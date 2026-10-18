import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface SafetyDecision {
  safe: boolean;
  reasons: string[];
  moderation: Record<string, unknown>;
}

const DISALLOWED_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:guaranteed returns?|get rich quick|risk[- ]free profit)\b/i, 'financial misinformation'],
  [/\b(?:miracle cure|cures? cancer|replace your doctor)\b/i, 'medical misinformation'],
  [/\b(?:suicide method|self[- ]harm instructions?)\b/i, 'self-harm instructions'],
  [/\b(?:buy|sell)\s+(?:drugs?|weapons?)\b/i, 'regulated goods'],
];

@Injectable()
export class SafetyService {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly freeMode: boolean;

  constructor(config: ConfigService) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') ?? 'missing' });
    this.model = config.get<string>('OPENAI_MODERATION_MODEL') ?? 'omni-moderation-latest';
    this.freeMode = config.get<string>('FREE_MODE') === 'true';
  }

  async check(text: string): Promise<SafetyDecision> {
    const reasons = DISALLOWED_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
    if (this.freeMode) {
      return { safe: reasons.length === 0, reasons, moderation: { provider: 'local-rules' } };
    }
    const response = await this.openai.moderations.create({ model: this.model, input: text });
    const result = response.results[0];
    if (result.flagged) reasons.push('OpenAI moderation policy flag');
    return {
      safe: reasons.length === 0,
      reasons,
      moderation: {
        flagged: result.flagged,
        categories: result.categories,
        categoryScores: result.category_scores,
      },
    };
  }
}
