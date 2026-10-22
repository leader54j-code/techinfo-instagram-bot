import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AiContentService } from './ai-content.service';
import { CollectionService } from './collection.service';
import { InstagramService } from './instagram.service';
import { ImageGenerationService } from './image-generation.service';
import { SafetyService } from './safety.service';
import { TaskQueueService } from './task-queue.service';

export enum PublishSlot {
  MORNING = 'morning',
  AFTERNOON = 'afternoon',
  EVENING = 'evening',
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly timezone: string;
  private readonly dailyLimit: number;
  private readonly internalSchedulerEnabled: boolean;
  private generating = false;
  private publishing = false;

  constructor(
    config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly queue: TaskQueueService,
    private readonly collector: CollectionService,
    private readonly ai: AiContentService,
    private readonly images: ImageGenerationService,
    private readonly safety: SafetyService,
    private readonly instagram: InstagramService,
  ) {
    this.timezone = config.get<string>('APP_TIMEZONE') ?? 'Asia/Kolkata';
    this.dailyLimit = Number(config.get<string>('MAX_DAILY_POSTS') ?? 3);
    this.internalSchedulerEnabled = config.get<string>('ENABLE_INTERNAL_SCHEDULER') !== 'false';
  }

  onModuleInit(): void {
    if (!this.internalSchedulerEnabled) {
      this.logger.log('Internal cron disabled; waiting for authenticated external job triggers');
      return;
    }
    this.addJob('collect-daily', '0 5 * * *', () => this.collectAndPrepare());
    this.addJob('prepare-pending', '* * * * *', () => this.preparePending());
    this.addJob('publish-0600', '0 6 * * *', () => this.publishBatch(1, this.slotKey(PublishSlot.MORNING)));
    this.addJob('publish-1300', '0 13 * * *', () => this.publishBatch(1, this.slotKey(PublishSlot.AFTERNOON)));
    this.addJob('publish-1800', '0 18 * * *', () => this.publishBatch(1, this.slotKey(PublishSlot.EVENING)));
    this.addJob('recover-locks', '*/10 * * * *', () => this.queue.releaseStaleLocks());
  }

  onApplicationShutdown(): void {
    for (const name of this.registry.getCronJobs().keys()) this.registry.deleteCronJob(name);
  }

  async collectAndPrepare(): Promise<void> {
    const added = await this.collector.collect();
    this.logger.log(`Collection complete: ${added} new tasks`);
    await this.preparePending();
  }

  async preparePending(): Promise<void> {
    if (this.generating) return;
    this.generating = true;
    try {
      let generated = await this.queue.generatedToday(this.timezone);
      while (generated < this.dailyLimit) {
        const task = await this.queue.claimForGeneration();
        if (!task) break;
        try {
          const sourceSafety = await this.safety.check(`${task.sourceTitle}\n${task.sourceExcerpt}`);
          if (!sourceSafety.safe) {
            await this.queue.reject(task, `Unsafe source: ${sourceSafety.reasons.join(', ')}`, sourceSafety as unknown as Record<string, unknown>);
            continue;
          }
          const post = await this.ai.generate(task);
          const outputSafety = await this.safety.check(`${post.factSummary}\n${post.caption}\n${post.hashtags.join(' ')}`);
          if (!outputSafety.safe) {
            await this.queue.reject(task, `Unsafe output: ${outputSafety.reasons.join(', ')}`, outputSafety as unknown as Record<string, unknown>);
            continue;
          }
          const imagePublicUrl = await this.images.prepare(
            task.imagePublicUrl,
            post.imagePrompt,
            task.sourceUrl,
          );
          await this.queue.markReady(task.id, {
            factSummary: post.factSummary,
            caption: post.caption,
            hashtags: post.hashtags,
            imageAltText: task.imageAltText ?? post.imageAltText,
            imagePublicUrl,
            safetyResult: outputSafety as unknown as Record<string, unknown>,
          });
          generated += 1;
        } catch (error) {
          this.logger.warn(
            `Generation failed for task ${task.id}: ${this.errorMessage(error)}`,
          );
          await this.queue.markAttemptFailed(task, error);
        }
      }
    } finally {
      this.generating = false;
    }
  }

  async publishBatch(requested: number, publishSlotKey?: string): Promise<boolean> {
    if (this.publishing) return false;
    this.publishing = true;
    try {
      if (publishSlotKey && await this.queue.hasCompletedSlot(publishSlotKey)) {
        this.logger.log(`Skipping completed publishing slot ${publishSlotKey}`);
        return false;
      }
      const alreadyPublished = await this.queue.publishedToday(this.timezone);
      const count = Math.min(requested, Math.max(0, this.dailyLimit - alreadyPublished));
      if (count === 0) {
        this.logger.log(`Daily publishing limit reached (${alreadyPublished}/${this.dailyLimit})`);
        return false;
      }
      for (let index = 0; index < count; index += 1) {
        const task = await this.queue.claimReadyForPublishing();
        if (!task) {
          this.logger.warn('No Ready publishing task is currently eligible; it may be in retry backoff');
          break;
        }
        try {
          const refreshedImageUrl = await this.images.refreshSourceImage(
            task.imagePublicUrl,
            task.sourceUrl,
            task.factSummary ?? task.sourceTitle,
          );
          if (refreshedImageUrl && refreshedImageUrl !== task.imagePublicUrl) {
            task.imagePublicUrl = refreshedImageUrl;
            await this.queue.saveImageUrl(task.id, refreshedImageUrl);
          }
          const mediaId = await this.instagram.publish(task);
          await this.queue.markPublished(task.id, mediaId, publishSlotKey);
          return true;
        } catch (error) {
          this.logger.warn(
            `Publishing failed for task ${task.id}: ${this.errorMessage(error)}`,
          );
          await this.queue.markAttemptFailed(task, error);
        }
      }
      return false;
    } finally {
      this.publishing = false;
    }
  }

  async runExternalSlot(slot: PublishSlot): Promise<{ slot: PublishSlot; slotKey: string; published: boolean }> {
    await this.queue.releaseStaleLocks();
    await this.collectAndPrepare();
    const slotKey = this.slotKey(slot);
    const published = await this.publishBatch(1, slotKey);
    return { slot, slotKey, published };
  }

  private slotKey(slot: PublishSlot): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}:${slot}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private addJob(name: string, expression: string, callback: () => Promise<unknown>): void {
    const job = CronJob.from({
      cronTime: expression,
      timeZone: this.timezone,
      onTick: () => void callback().catch((error) => this.logger.error(`${name} failed`, error)),
      start: false,
    });
    this.registry.addCronJob(name, job);
    job.start();
  }
}
