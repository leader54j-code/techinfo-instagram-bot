import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TaskStatus {
  PENDING = 'Pending',
  PROCESSING = 'Processing',
  COMPLETED = 'Completed',
  FAILED = 'Failed',
}

export enum TaskStage {
  COLLECTED = 'Collected',
  READY = 'Ready',
  PUBLISHING = 'Publishing',
  PUBLISHED = 'Published',
  REJECTED = 'Rejected',
}

@Entity('content_tasks')
@Index('IDX_content_tasks_queue', ['status', 'stage', 'createdAt'])
@Index('IDX_content_tasks_published_at', ['publishedAt'])
export class ContentTask {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.PENDING })
  status: TaskStatus;

  @Column({ type: 'enum', enum: TaskStage, default: TaskStage.COLLECTED })
  stage: TaskStage;

  @Column({ length: 300 }) topic: string;
  @Column({ type: 'text' }) sourceUrl: string;
  @Column({ length: 500 }) sourceTitle: string;
  @Column({ type: 'text' }) sourceExcerpt: string;
  @Column({ type: 'timestamptz', nullable: true }) sourcePublishedAt: Date | null;

  @Index({ unique: true })
  @Column({ length: 64 }) sourceFingerprint: string;

  @Column({ type: 'text', nullable: true }) factSummary: string | null;
  @Column({ type: 'text', nullable: true }) caption: string | null;
  @Column({ type: 'jsonb', nullable: true }) hashtags: string[] | null;
  @Column({ type: 'jsonb', nullable: true }) safetyResult: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true }) imagePath: string | null;
  @Column({ type: 'text', nullable: true }) imagePublicUrl: string | null;
  @Column({ type: 'text', nullable: true }) imageAltText: string | null;

  @Column({ type: 'int', default: 0 }) attemptCount: number;
  @Column({ type: 'int', default: 3 }) maxAttempts: number;
  @Column({ type: 'timestamptz', nullable: true }) nextAttemptAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lockedAt: Date | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;

  @Column({ type: 'text', nullable: true }) instagramCreationId: string | null;
  @Index({ unique: true, where: '"instagramMediaId" IS NOT NULL' })
  @Column({ type: 'text', nullable: true }) instagramMediaId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) publishedAt: Date | null;

  @Index({ unique: true, where: '"publishSlotKey" IS NOT NULL' })
  @Column({ type: 'text', nullable: true }) publishSlotKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
