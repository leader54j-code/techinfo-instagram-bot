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

  constructor(config: ConfigService) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.model = config.get<string>('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1-mini';
    this.baseUrl = (config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
  }

  async generate(prompt: string): Promise<string> {
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
}
