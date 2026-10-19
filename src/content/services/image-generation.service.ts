import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import sharp from 'sharp';

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

  async prepare(currentUrl: string | null, prompt: string, sourceUrl?: string): Promise<string> {
    if (this.useSourceImages) {
      const candidates: string[] = [];
      if (currentUrl && !currentUrl.includes('placehold.co')) candidates.push(currentUrl);
      if (sourceUrl) {
        const articleImage = await this.findSourceImage(sourceUrl);
        if (articleImage && !candidates.includes(articleImage)) candidates.push(articleImage);
      }
      for (const candidate of candidates) {
        const converted = await this.convertToInstagramJpeg(candidate);
        if (converted) return converted;
      }
    }
    if (currentUrl && !currentUrl.includes('placehold.co')) return currentUrl;
    return this.generate(prompt);
  }

  async generate(prompt: string): Promise<string> {
    if (this.freeMode) {
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
    if (currentUrl?.startsWith(`${this.baseUrl}/media/`)) return currentUrl;
    const articleImage = await this.findSourceImage(sourceUrl);
    if (!articleImage) return currentUrl;
    return await this.convertToInstagramJpeg(articleImage) ?? currentUrl;
  }

  private async findSourceImage(sourceUrl: string): Promise<string | undefined> {
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
        if (this.isPublicHttpsUrl(imageUrl)) return imageUrl;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async convertToInstagramJpeg(imageUrl: string): Promise<string | undefined> {
    if (!this.isPublicHttpsUrl(imageUrl)) return undefined;
    try {
      const response = await fetch(imageUrl, {
        headers: { Accept: 'image/*', 'User-Agent': 'TechInfoInstagramBot/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
      const allowedTypes = new Set([
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif',
      ]);
      if (!response.ok || !contentType || !allowedTypes.has(contentType)) return undefined;
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (declaredSize > 20 * 1024 * 1024) return undefined;
      const input = Buffer.from(await response.arrayBuffer());
      if (input.length === 0 || input.length > 20 * 1024 * 1024) return undefined;
      const output = await sharp(input, { failOn: 'warning', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(1080, 1080, { fit: 'cover', position: 'attention' })
        .flatten({ background: '#111827' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      const filename = `${randomUUID()}.jpg`;
      const directory = join(process.cwd(), 'uploads');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, filename), output);
      return `${this.baseUrl}/media/${filename}`;
    } catch {
      return undefined;
    }
  }

  private isPublicHttpsUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch {
      return false;
    }
  }
}
