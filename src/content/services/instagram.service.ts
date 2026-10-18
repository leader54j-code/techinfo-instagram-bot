import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentTask } from '../entities/content-task.entity';
import { TaskQueueService } from './task-queue.service';

interface GraphIdResponse { id: string }
interface InstagramProfileResponse { id?: string; user_id?: string; username?: string }

@Injectable()
export class InstagramService {
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly userId: string;
  private readonly token: string;
  private readonly expectedUsername: string;
  private targetVerified = false;

  constructor(
    config: ConfigService,
    private readonly http: HttpService,
    private readonly queue: TaskQueueService,
  ) {
    this.baseUrl = config.get<string>('INSTAGRAM_GRAPH_BASE_URL') ?? 'https://graph.instagram.com';
    this.version = config.get<string>('INSTAGRAM_GRAPH_VERSION') ?? 'v24.0';
    this.userId = config.get<string>('INSTAGRAM_USER_ID') ?? '';
    this.token = config.get<string>('INSTAGRAM_ACCESS_TOKEN') ?? '';
    this.expectedUsername = config.get<string>('INSTAGRAM_EXPECTED_USERNAME') ?? '';
  }

  async publish(task: ContentTask): Promise<string> {
    if (!this.userId || !this.token) throw new Error('Instagram credentials are not configured');
    await this.verifyTargetAccount();
    if (!task.imagePublicUrl || !task.caption) throw new Error('Task is missing image or caption');
    let creationId = task.instagramCreationId;
    if (!creationId) {
      const caption = `${task.caption}\n\n${(task.hashtags ?? []).join(' ')}`.slice(0, 2200);
      const response = await this.http.axiosRef.post<GraphIdResponse>(
        `${this.baseUrl}/${this.version}/${this.userId}/media`,
        new URLSearchParams({ image_url: task.imagePublicUrl, caption, access_token: this.token }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30_000 },
      );
      creationId = response.data.id;
      await this.queue.saveCreationId(task.id, creationId);
    }
    await this.waitUntilReady(creationId);
    const published = await this.http.axiosRef.post<GraphIdResponse>(
      `${this.baseUrl}/${this.version}/${this.userId}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: this.token }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30_000 },
    );
    return published.data.id;
  }

  private async verifyTargetAccount(): Promise<void> {
    if (this.targetVerified) return;
    if (!this.expectedUsername) throw new Error('INSTAGRAM_EXPECTED_USERNAME is not configured');
    const response = await this.http.axiosRef.get<InstagramProfileResponse>(
      `${this.baseUrl}/${this.version}/${this.userId}`,
      {
        params: { fields: 'id,user_id,username', access_token: this.token },
        timeout: 15_000,
      },
    );
    const actual = response.data.username?.replace(/^@/, '').toLowerCase();
    const expected = this.expectedUsername.replace(/^@/, '').toLowerCase();
    if (!actual || actual !== expected) {
      throw new Error(`Instagram token target mismatch: expected @${expected}, received @${actual ?? 'unknown'}`);
    }
    this.targetVerified = true;
  }

  private async waitUntilReady(creationId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.http.axiosRef.get<{ status_code?: string }>(
        `${this.baseUrl}/${this.version}/${creationId}`,
        { params: { fields: 'status_code', access_token: this.token }, timeout: 15_000 },
      );
      if (response.data.status_code === 'FINISHED') return;
      if (response.data.status_code === 'ERROR' || response.data.status_code === 'EXPIRED') {
        throw new Error(`Instagram container status: ${response.data.status_code}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('Instagram media container was not ready in time');
  }
}
