import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import OpenAI from 'openai';
import type sharpFactory from 'sharp';

// Sharp 0.35 exposes a CommonJS callable at runtime, while its type package also
// advertises an ESM default. Requiring it directly avoids a `.default` call in
// the CommonJS bundle produced by Nest.
const sharp = require('sharp') as typeof sharpFactory;

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly freeMode: boolean;
  private readonly freeImageBaseUrl: string;
  private readonly useSourceImages: boolean;
  private readonly imageProxyBaseUrl: string;
  private readonly imageProvider: string;
  private readonly generateAiImages: boolean;
  private readonly cloudflareAccountId: string;
  private readonly cloudflareApiToken: string;
  private readonly cloudflareImageModel: string;

  constructor(config: ConfigService) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.model = config.get<string>('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1-mini';
    this.baseUrl = (config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    this.freeMode = config.get<string>('FREE_MODE') === 'true';
    this.freeImageBaseUrl = config.get<string>('FREE_IMAGE_BASE_URL')
      ?? 'https://placehold.co/1080x1080/111827/FFFFFF.jpg';
    this.useSourceImages = config.get<string>('USE_SOURCE_IMAGES') !== 'false';
    this.imageProxyBaseUrl = config.get<string>('IMAGE_PROXY_BASE_URL') ?? 'https://wsrv.nl/';
    this.imageProvider = (config.get<string>('IMAGE_PROVIDER') ?? 'openai').toLowerCase();
    this.generateAiImages = config.get<string>('GENERATE_AI_IMAGES') === 'true';
    this.cloudflareAccountId = config.get<string>('CLOUDFLARE_ACCOUNT_ID') ?? '';
    this.cloudflareApiToken = config.get<string>('CLOUDFLARE_API_TOKEN') ?? '';
    this.cloudflareImageModel = config.get<string>('CLOUDFLARE_IMAGE_MODEL')
      ?? '@cf/black-forest-labs/flux-1-schnell';
  }

  async prepare(currentUrl: string | null, prompt: string, sourceUrl?: string): Promise<string> {
    if (this.generateAiImages) {
      try {
        return await this.generate(prompt);
      } catch (error) {
        this.logger.warn(
          `AI image generation failed; trying source image: ${this.errorMessage(error)}`,
        );
      }
    }
    if (this.useSourceImages) {
      const candidates: string[] = [];
      if (currentUrl && !currentUrl.includes('placehold.co')) candidates.push(currentUrl);
      if (sourceUrl) {
        const articleImage = await this.findSourceImage(sourceUrl);
        if (articleImage && !candidates.includes(articleImage)) candidates.push(articleImage);
      }
      for (const candidate of candidates) {
        const converted = await this.convertToInstagramJpeg(candidate, sourceUrl);
        if (converted) return converted;
      }
      this.logger.warn(`No usable source image found for ${sourceUrl ?? 'unknown source'}; using fallback image`);
    }
    if (currentUrl && !currentUrl.includes('placehold.co')) return currentUrl;
    return this.generate(prompt);
  }

  async generate(prompt: string): Promise<string> {
    if (this.imageProvider === 'cloudflare') {
      return this.generateWithCloudflare(prompt);
    }
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

  private async generateWithCloudflare(prompt: string): Promise<string> {
    if (!this.cloudflareAccountId || !this.cloudflareApiToken) {
      throw new Error('Cloudflare image generation credentials are missing');
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.cloudflareAccountId)}/ai/run/${this.cloudflareImageModel}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cloudflareApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: [
          'Create a square editorial technology illustration for an Instagram news post.',
          prompt.slice(0, 1500),
          'Visually communicate the subject accurately. No words, letters, logos, watermarks,',
          'UI screenshots, misleading claims, graphic content, or photorealistic public figures.',
        ].join(' '),
        steps: 4,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`Cloudflare Workers AI returned ${response.status}: ${details}`);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    let imageBuffer: Buffer;
    if (contentType.startsWith('image/')) {
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      const payload = await response.json() as {
        result?: { image?: string } | string;
        image?: string;
      };
      const encoded = typeof payload.result === 'string'
        ? payload.result
        : payload.result?.image ?? payload.image;
      if (!encoded) throw new Error('Cloudflare Workers AI returned no image');
      imageBuffer = Buffer.from(encoded.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    }

    return this.saveInstagramJpeg(imageBuffer);
  }

  private async saveInstagramJpeg(input: Buffer): Promise<string> {
    if (input.length === 0 || input.length > 20 * 1024 * 1024) {
      throw new Error('Generated image is empty or exceeds 20 MB');
    }
    const output = await sharp(input, { failOn: 'warning', limitInputPixels: 40_000_000 })
      .rotate()
      .resize(1080, 1080, { fit: 'cover', position: 'attention' })
      .flatten({ background: '#111827' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    const filename = `${randomUUID()}.jpg`;
    const directory = join(process.cwd(), 'uploads');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), output);
    return `${this.baseUrl}/media/${filename}`;
  }

  async refreshSourceImage(
    currentUrl: string | null,
    sourceUrl: string,
    prompt?: string,
  ): Promise<string | null> {
    if (currentUrl?.startsWith(`${this.baseUrl}/media/`)) {
      if (await this.localMediaExists(currentUrl)) return currentUrl;
      this.logger.warn(`Generated media file no longer exists; regenerating ${currentUrl}`);
    }
    if (this.generateAiImages && prompt) {
      try {
        return await this.generate(prompt);
      } catch (error) {
        this.logger.warn(
          `AI image refresh failed; trying source image: ${this.errorMessage(error)}`,
        );
      }
    }
    if (!this.useSourceImages) return currentUrl;
    const articleImage = await this.findSourceImage(sourceUrl);
    if (!articleImage) return currentUrl;
    return await this.convertToInstagramJpeg(articleImage, sourceUrl) ?? currentUrl;
  }

  private async findSourceImage(sourceUrl: string): Promise<string | undefined> {
    try {
      const articleUrl = new URL(sourceUrl);
      if (articleUrl.protocol !== 'https:') return undefined;
      const response = await fetch(articleUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (compatible; TechInfoInstagramBot/1.0; +https://techinfo-instagram-bot.onrender.com)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.warn(`Article fetch failed (${response.status}) for ${sourceUrl}`);
        return undefined;
      }
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
    } catch (error) {
      this.logger.warn(`Could not discover source image for ${sourceUrl}: ${this.errorMessage(error)}`);
      return undefined;
    }
  }

  private async convertToInstagramJpeg(imageUrl: string, referer?: string): Promise<string | undefined> {
    if (!this.isPublicHttpsUrl(imageUrl)) return undefined;
    try {
      const response = await fetch(imageUrl, {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/tiff,*/*;q=0.5',
          Referer: referer ?? new URL(imageUrl).origin,
          'User-Agent': 'Mozilla/5.0 (compatible; TechInfoInstagramBot/1.0; +https://techinfo-instagram-bot.onrender.com)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        this.logger.warn(`Image fetch failed (${response.status}) for ${imageUrl}`);
        return this.buildProxyJpegUrl(imageUrl);
      }
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (declaredSize > 20 * 1024 * 1024) return this.buildProxyJpegUrl(imageUrl);
      const input = Buffer.from(await response.arrayBuffer());
      if (input.length === 0 || input.length > 20 * 1024 * 1024) {
        return this.buildProxyJpegUrl(imageUrl);
      }
      const image = sharp(input, { failOn: 'warning', limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      const supportedFormats = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif']);
      if (!metadata.format || !supportedFormats.has(metadata.format)) {
        this.logger.warn(`Unsupported decoded image format for ${imageUrl}: ${metadata.format ?? 'unknown'}`);
        return this.buildProxyJpegUrl(imageUrl);
      }
      const output = await image
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
    } catch (error) {
      this.logger.warn(`Image conversion failed for ${imageUrl}: ${this.errorMessage(error)}`);
      return this.buildProxyJpegUrl(imageUrl);
    }
  }

  private buildProxyJpegUrl(imageUrl: string): string {
    const proxy = new URL(this.imageProxyBaseUrl);
    proxy.searchParams.set('url', imageUrl);
    proxy.searchParams.set('w', '1080');
    proxy.searchParams.set('h', '1080');
    proxy.searchParams.set('fit', 'cover');
    proxy.searchParams.set('output', 'jpg');
    return proxy.toString();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async localMediaExists(mediaUrl: string): Promise<boolean> {
    try {
      const url = new URL(mediaUrl);
      const filename = basename(decodeURIComponent(url.pathname));
      if (!/^[0-9a-f-]+\.jpg$/i.test(filename)) return false;
      await access(join(process.cwd(), 'uploads', filename));
      return true;
    } catch {
      return false;
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
