import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPublishSlotKey1730000001000 implements MigrationInterface {
  name = 'AddPublishSlotKey1730000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_tasks" ADD "publishSlotKey" text`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_content_tasks_publish_slot" ON "content_tasks" ("publishSlotKey") WHERE "publishSlotKey" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_content_tasks_publish_slot"`);
    await queryRunner.query(`ALTER TABLE "content_tasks" DROP COLUMN "publishSlotKey"`);
  }
}
