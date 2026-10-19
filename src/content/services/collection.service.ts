import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Parser = require('rss-parser');
import OpenAI from 'openai';
import { TaskQueueService } from './task-queue.service';

type FeedItem = Parser.Item & {
  enclosure?: { url?: string; type?: string };
  ['media:content']?: { $?: { url?: string; medium?: string } };
};

@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name);
  private readonly parser = new Parser();
  private readonly openai: OpenAI;
  private readonly webSearchEnabled: boolean;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: TaskQueueService,
  ) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.webSearchEnabled = config.get<string>('FREE_MODE') !== 'true'
      && config.get<string>('ENABLE_AI_WEB_SEARCH') !== 'false';
    this.model = config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
  }

  async collect(): Promise<number> {
    if (this.webSearchEnabled) return this.collectWithAiWebSearch();
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
          const imageCandidate = this.findImage(item) ?? this.config.get<string>('DEFAULT_POST_IMAGE_URL');
          const imagePublicUrl = imageCandidate && this.isPublicHttpsUrl(imageCandidate)
            ? imageCandidate
            : undefined;
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

  private async collectWithAiWebSearch(): Promise<number> {
    const response = await this.openai.responses.create({
      model: this.model,
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      tool_choice: 'required',
      instructions: [
        'Search the live web for three recent useful technology information items for a general Instagram audience.',
        'Exclude rumors, politics, medical or financial advice, adult content, violence, wrongdoing, and sensational claims.',
        'Verify each item with at least two credible sources. Prefer primary sources and reputable reporting.',
        'Return only supported facts. Never fabricate URLs, dates, quotes, or statistics.',
      ].join(' '),
      input: `Find three distinct verified technology items for ${new Date().toISOString().slice(0, 10)}.`,
      text: { format: {
        type: 'json_schema', name: 'verified_technology_items', strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['items'],
          properties: { items: {
            type: 'array', minItems: 3, maxItems: 3,
            items: {
              type: 'object', additionalProperties: false,
              required: ['topic', 'title', 'verifiedSummary', 'sourceUrls'],
              properties: {
                topic: { type: 'string', minLength: 3, maxLength: 300 },
                title: { type: 'string', minLength: 3, maxLength: 500 },
                verifiedSummary: { type: 'string', minLength: 100, maxLength: 4000 },
                sourceUrls: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
              },
            },
          } },
        },
      } },
    });
    if (!response.output_text) throw new Error('AI web search returned no content');
    const result = JSON.parse(response.output_text) as { items: Array<{ topic: string; title: string; verifiedSummary: string; sourceUrls: string[] }> };
    let added = 0;
    for (const item of result.items) {
      const sourceUrls = item.sourceUrls.filter((value) => this.isPublicHttpsUrl(value));
      if (sourceUrls.length < 2) {
        this.logger.warn(`Skipping web result without two valid HTTPS sources: ${item.title}`);
        continue;
      }
      const sourceUrl = sourceUrls[0];
      const fingerprint = this.queue.fingerprint(sourceUrl, item.title);
      if (await this.queue.getByFingerprint(fingerprint)) continue;
      await this.queue.enqueue({
        topic: item.topic, sourceUrl, sourceTitle: item.title,
        sourceExcerpt: `${item.verifiedSummary}\n\nVerification sources:\n${sourceUrls.join('\n')}`,
      });
      added += 1;
    }
    return added;
  }

  private isPublicHttpsUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && Boolean(url.hostname) && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch {
      return false;
    }
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
    const enclosure = item.enclosure;
    if (enclosure?.url && (!enclosure.type || enclosure.type.startsWith('image/'))) {
      return enclosure.url;
    }
    return item['media:content']?.$?.url;
  }
}
