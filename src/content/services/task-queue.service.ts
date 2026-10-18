import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateTaskDto } from '../dto/create-task.dto';
import { ListTasksDto } from '../dto/list-tasks.dto';
import { ContentTask, TaskStage, TaskStatus } from '../entities/content-task.entity';

@Injectable()
export class TaskQueueService {
  constructor(
    @InjectRepository(ContentTask) private readonly tasks: Repository<ContentTask>,
    private readonly dataSource: DataSource,
  ) {}

  fingerprint(sourceUrl: string, title: string): string {
    const normalized = `${sourceUrl.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
    return createHash('sha256').update(normalized).digest('hex');
  }

  async enqueue(input: CreateTaskDto, imagePath?: string): Promise<ContentTask> {
    const sourceFingerprint = this.fingerprint(input.sourceUrl, input.sourceTitle);
    const existing = await this.tasks.findOneBy({ sourceFingerprint });
    if (existing) return existing;
    const task = this.tasks.create({
      ...input,
      sourcePublishedAt: input.sourcePublishedAt ? new Date(input.sourcePublishedAt) : null,
      imagePublicUrl: input.imagePublicUrl ?? null,
      imageAltText: input.imageAltText ?? null,
      imagePath: imagePath ?? null,
      sourceFingerprint,
    });
    return this.tasks.save(task);
  }

  async list(query: ListTasksDto): Promise<ContentTask[]> {
    return this.tasks.find({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      take: query.limit,
    });
  }

  async get(id: string): Promise<ContentTask> {
    const task = await this.tasks.findOneBy({ id });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async getByFingerprint(sourceFingerprint: string): Promise<ContentTask | null> {
    return this.tasks.findOneBy({ sourceFingerprint });
  }

  async claimForGeneration(): Promise<ContentTask | null> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager
        .getRepository(ContentTask)
        .createQueryBuilder('task')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('task.status = :status', { status: TaskStatus.PENDING })
        .andWhere('task.stage = :stage', { stage: TaskStage.COLLECTED })
        .andWhere('(task.nextAttemptAt IS NULL OR task.nextAttemptAt <= NOW())')
        .orderBy('task.createdAt', 'ASC')
        .getOne();
      if (!task) return null;
      task.status = TaskStatus.PROCESSING;
      task.lockedAt = new Date();
      return manager.save(task);
    });
  }

  async markReady(id: string, values: Partial<ContentTask>): Promise<void> {
    const task = await this.get(id);
    Object.assign(task, values, {
      status: TaskStatus.PENDING,
      stage: TaskStage.READY,
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lastError: null,
    });
    await this.tasks.save(task);
  }

  async markAttemptFailed(task: ContentTask, error: unknown): Promise<void> {
    const attemptCount = task.attemptCount + 1;
    const terminal = attemptCount >= task.maxAttempts;
    const message = error instanceof Error ? error.message : String(error);
    await this.tasks.update(task.id, {
      attemptCount,
      status: terminal ? TaskStatus.FAILED : TaskStatus.PENDING,
      stage: terminal
        ? TaskStage.REJECTED
        : task.stage === TaskStage.PUBLISHING
          ? TaskStage.READY
          : TaskStage.COLLECTED,
      lastError: message.slice(0, 4000),
      lockedAt: null,
      nextAttemptAt: terminal ? null : new Date(Date.now() + 2 ** attemptCount * 60_000),
    });
  }

  async releaseStaleLocks(): Promise<number> {
    const result = await this.tasks
      .createQueryBuilder()
      .update(ContentTask)
      .set({
        status: TaskStatus.PENDING,
        stage: () => `CASE WHEN "stage" = '${TaskStage.PUBLISHING}' THEN '${TaskStage.READY}' ELSE '${TaskStage.COLLECTED}' END`,
        lockedAt: null,
        lastError: 'Recovered stale processing lock',
      })
      .where('status = :status', { status: TaskStatus.PROCESSING })
      .andWhere('lockedAt < NOW() - INTERVAL \'15 minutes\'')
      .execute();
    return result.affected ?? 0;
  }

  async reject(task: ContentTask, reason: string, safetyResult?: Record<string, unknown>): Promise<void> {
    Object.assign(task, {
      status: TaskStatus.FAILED,
      stage: TaskStage.REJECTED,
      lastError: reason.slice(0, 4000),
      safetyResult: safetyResult ?? task.safetyResult,
      lockedAt: null,
    });
    await this.tasks.save(task);
  }

  async generatedToday(timezone: string): Promise<number> {
    return this.tasks
      .createQueryBuilder('task')
      .where('task.stage IN (:...stages)', {
        stages: [TaskStage.READY, TaskStage.PUBLISHING, TaskStage.PUBLISHED],
      })
      .andWhere("(task.updatedAt AT TIME ZONE :timezone)::date = (NOW() AT TIME ZONE :timezone)::date", {
        timezone,
      })
      .getCount();
  }

  async publishedToday(timezone: string): Promise<number> {
    return this.tasks
      .createQueryBuilder('task')
      .where('task.status = :status', { status: TaskStatus.COMPLETED })
      .andWhere("(task.publishedAt AT TIME ZONE :timezone)::date = (NOW() AT TIME ZONE :timezone)::date", {
        timezone,
      })
      .getCount();
  }

  async claimReadyForPublishing(): Promise<ContentTask | null> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager
        .getRepository(ContentTask)
        .createQueryBuilder('task')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('task.status = :status', { status: TaskStatus.PENDING })
        .andWhere('task.stage = :stage', { stage: TaskStage.READY })
        .andWhere('(task.nextAttemptAt IS NULL OR task.nextAttemptAt <= NOW())')
        .andWhere('task.imagePublicUrl IS NOT NULL')
        .orderBy('task.createdAt', 'ASC')
        .getOne();
      if (!task) return null;
      task.status = TaskStatus.PROCESSING;
      task.stage = TaskStage.PUBLISHING;
      task.lockedAt = new Date();
      return manager.save(task);
    });
  }

  async saveCreationId(id: string, instagramCreationId: string): Promise<void> {
    await this.tasks.update(id, { instagramCreationId });
  }

  async markPublished(id: string, instagramMediaId: string, publishSlotKey?: string): Promise<void> {
    await this.tasks.update(id, {
      instagramMediaId,
      status: TaskStatus.COMPLETED,
      stage: TaskStage.PUBLISHED,
      publishedAt: new Date(),
      publishSlotKey: publishSlotKey ?? null,
      lockedAt: null,
      lastError: null,
    });
  }

  async hasCompletedSlot(publishSlotKey: string): Promise<boolean> {
    return this.tasks.existsBy({ publishSlotKey, status: TaskStatus.COMPLETED });
  }
}
