import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ContentTask } from '../entities/content-task.entity';

export interface GeneratedPost {
  factSummary: string;
  caption: string;
  hashtags: string[];
  imageAltText: string;
  relevanceScore: number;
  confidence: number;
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['factSummary', 'caption', 'hashtags', 'imageAltText', 'relevanceScore', 'confidence'],
  properties: {
    factSummary: { type: 'string', minLength: 30, maxLength: 1000 },
    caption: { type: 'string', minLength: 50, maxLength: 1800 },
    hashtags: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', pattern: '^#[A-Za-z0-9_]+$' } },
    imageAltText: { type: 'string', minLength: 10, maxLength: 500 },
    relevanceScore: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

@Injectable()
export class AiContentService {
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.model = config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
  }

  async generate(task: ContentTask): Promise<GeneratedPost> {
    const response = await this.openai.responses.create({
      model: this.model,
      instructions: [
        'Create a useful, factual Instagram post using only the supplied source excerpt.',
        'Do not invent facts, dates, quotes, statistics, or certainty not present in the source.',
        'Avoid medical, legal, financial, political persuasion, graphic, sexual, hateful, or dangerous content.',
        'Use a calm informative tone. Do not use engagement bait. Attribute the source in the caption.',
        'Return a low confidence score when the excerpt is incomplete or ambiguous.',
      ].join(' '),
      input: `TOPIC: ${task.topic}\nSOURCE TITLE: ${task.sourceTitle}\nSOURCE URL: ${task.sourceUrl}\nSOURCE EXCERPT:\n${task.sourceExcerpt}`,
      text: {
        format: {
          type: 'json_schema',
          name: 'instagram_post',
          strict: true,
          schema,
        },
      },
    });
    if (!response.output_text) throw new Error('OpenAI returned no content');
    const generated = JSON.parse(response.output_text) as GeneratedPost;
    if (generated.confidence < 0.75 || generated.relevanceScore < 0.65) {
      throw new Error('Generated content did not meet verification thresholds');
    }
    return generated;
  }
}
