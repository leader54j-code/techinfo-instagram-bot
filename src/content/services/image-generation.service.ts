import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';

@Injectable()
export class ImageGenerationService {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly freeMode: boolean;
  private readonly freeImageBaseUrl: string;
  private readonly useSourceImages: boolean;

  constructor(config: ConfigService) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.model = config.get<string>('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1-mini';
    this.baseUrl = (config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    this.freeMode = config.get<string>('FREE_MODE') === 'true';
    this.freeImageBaseUrl = config.get<string>('FREE_IMAGE_BASE_URL')
      ?? 'https://placehold.co/1080x1080/111827/FFFFFF.jpg';
    this.useSourceImages = config.get<string>('USE_SOURCE_IMAGES') === 'true';
  }

  async generate(prompt: string, sourceUrl?: string): Promise<string> {
    if (this.freeMode) {
      if (this.useSourceImages && sourceUrl) {
        const sourceImage = await this.findSourceJpeg(sourceUrl);
        if (sourceImage) return sourceImage;
      }
      return `${this.freeImageBaseUrl}?text=${encodeURIComponent(prompt.slice(0, 120))}`;
    }
    const result = await this.openai.images.generate({
      model: this.model,
      prompt: `Draw a clean square technology editorial illustration. ${prompt}`,
      size: '1024x1024', quality: 'low', output_format: 'jpeg', n: 1,
    });
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw new Error('OpenAI returned no generated image');
    const filename = `${randomUUID()}.jpg`;
    const directory = join(process.cwd(), 'uploads');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), Buffer.from(encoded, 'base64'));
    return `${this.baseUrl}/media/${filename}`;
  }

  async refreshSourceImage(currentUrl: string | null, sourceUrl: string): Promise<string | null> {
    if (!this.freeMode || !this.useSourceImages) return currentUrl;
    return await this.findSourceJpeg(sourceUrl) ?? currentUrl;
  }

  private async findSourceJpeg(sourceUrl: string): Promise<string | undefined> {
    try {
      const articleUrl = new URL(sourceUrl);
      if (articleUrl.protocol !== 'https:') return undefined;
      const response = await fetch(articleUrl, {
        headers: { 'User-Agent': 'TechInfoInstagramBot/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return undefined;
      const html = (await response.text()).slice(0, 2_000_000);
      const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
      for (const tag of tags) {
        const attributes = new Map<string, string>();
        for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) {
          attributes.set(match[1].toLowerCase(), match[3]);
        }
        const key = (attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase();
        if (!['og:image', 'og:image:secure_url', 'twitter:image'].includes(key)) continue;
        const content = attributes.get('content');
        if (!content) continue;
        const imageUrl = new URL(content.replace(/&amp;/g, '&'), articleUrl).toString();
        if (this.isPublicJpeg(imageUrl)) return imageUrl;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isPublicJpeg(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && /\.jpe?g$/i.test(url.pathname)
        && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch {
      return false;
    }
  }
}
