import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContentTasks1730000000000 implements MigrationInterface {
  name = 'CreateContentTasks1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "content_tasks_status_enum" AS ENUM ('Pending', 'Processing', 'Completed', 'Failed')`);
    await queryRunner.query(`CREATE TYPE "content_tasks_stage_enum" AS ENUM ('Collected', 'Ready', 'Publishing', 'Published', 'Rejected')`);
    await queryRunner.query(`
      CREATE TABLE "content_tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "status" "content_tasks_status_enum" NOT NULL DEFAULT 'Pending',
        "stage" "content_tasks_stage_enum" NOT NULL DEFAULT 'Collected',
        "topic" character varying(300) NOT NULL,
        "sourceUrl" text NOT NULL,
        "sourceTitle" character varying(500) NOT NULL,
        "sourceExcerpt" text NOT NULL,
        "sourcePublishedAt" timestamptz,
        "sourceFingerprint" character varying(64) NOT NULL,
        "factSummary" text,
        "caption" text,
        "hashtags" jsonb,
        "safetyResult" jsonb,
        "imagePath" text,
        "imagePublicUrl" text,
        "imageAltText" text,
        "attemptCount" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 3,
        "nextAttemptAt" timestamptz,
        "lockedAt" timestamptz,
        "lastError" text,
        "instagramCreationId" text,
        "instagramMediaId" text,
        "publishedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_content_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_content_tasks_source_fingerprint" UNIQUE ("sourceFingerprint")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_content_tasks_queue" ON "content_tasks" ("status", "stage", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_content_tasks_published_at" ON "content_tasks" ("publishedAt")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_content_tasks_instagram_media" ON "content_tasks" ("instagramMediaId") WHERE "instagramMediaId" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "content_tasks"`);
    await queryRunner.query(`DROP TYPE "content_tasks_stage_enum"`);
    await queryRunner.query(`DROP TYPE "content_tasks_status_enum"`);
  }
}
