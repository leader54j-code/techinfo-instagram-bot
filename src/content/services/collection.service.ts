import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Parser from 'rss-parser';
import { TaskQueueService } from './task-queue.service';

type FeedItem = Parser.Item & {
  enclosure?: { url?: string; type?: string };
  ['media:content']?: { $?: { url?: string; medium?: string } };
};

@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name);
  private readonly parser = new Parser();

  constructor(
    private readonly config: ConfigService,
    private readonly queue: TaskQueueService,
  ) {}

  async collect(): Promise<number> {
    const feeds = this.parseFeeds();
    const allowedHosts = new Set(
      (this.config.get<string>('ALLOWED_SOURCE_HOSTS') ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );
    let added = 0;
    for (const feedUrl of feeds) {
      this.assertAllowedUrl(feedUrl, allowedHosts);
      try {
        const feed = await this.parser.parseURL(feedUrl);
        for (const rawItem of feed.items.slice(0, 20)) {
          const item = rawItem as FeedItem;
          if (!item.link || !item.title) continue;
          this.assertAllowedUrl(item.link, allowedHosts);
          const excerpt = this.cleanText(item.contentSnippet ?? item.content ?? item.summary ?? '');
          if (excerpt.length < 80) continue;
          const imagePublicUrl = this.findImage(item) ?? this.config.get<string>('DEFAULT_POST_IMAGE_URL');
          if (!imagePublicUrl || !this.isLikelyInstagramJpeg(imagePublicUrl)) continue;
          const fingerprint = this.queue.fingerprint(item.link, item.title);
          const existing = await this.queue.getByFingerprint(fingerprint);
          await this.queue.enqueue({
            topic: feed.title ?? item.title,
            sourceUrl: item.link,
            sourceTitle: item.title,
            sourceExcerpt: excerpt.slice(0, 12000),
            sourcePublishedAt: item.isoDate,
            imagePublicUrl,
            imageAltText: item.title,
          });
          if (!existing) added += 1;
        }
      } catch (error) {
        this.logger.warn(`Feed collection failed for ${feedUrl}: ${String(error)}`);
      }
    }
    return added;
  }

  private parseFeeds(): string[] {
    try {
      const value = JSON.parse(this.config.get<string>('SOURCE_FEEDS') ?? '[]') as unknown;
      if (!Array.isArray(value) || value.some((url) => typeof url !== 'string')) {
        throw new Error('SOURCE_FEEDS must be a JSON array of URLs');
      }
      return value;
    } catch (error) {
      throw new Error(`Invalid SOURCE_FEEDS: ${String(error)}`);
    }
  }

  private assertAllowedUrl(value: string, allowedHosts: Set<string>): void {
    const url = new URL(value);
    const allowed = [...allowedHosts].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    if (url.protocol !== 'https:' || !allowed) throw new Error(`Source host is not allowed: ${url.hostname}`);
  }

  private cleanText(value: string): string {
    return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private findImage(item: FeedItem): string | undefined {
    return item.enclosure?.url ?? item['media:content']?.$?.url;
  }

  private isLikelyInstagramJpeg(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /\.jpe?g$/i.test(url.pathname);
    } catch {
      return false;
    }
  }
}
