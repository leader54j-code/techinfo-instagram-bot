import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentController } from './content.controller';
import { JobsController } from './jobs.controller';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AiContentService } from './services/ai-content.service';
import { CollectionService } from './services/collection.service';
import { InstagramService } from './services/instagram.service';
import { ImageGenerationService } from './services/image-generation.service';
import { SafetyService } from './services/safety.service';
import { SchedulerService } from './services/scheduler.service';
import { TaskQueueService } from './services/task-queue.service';
import { ContentTask } from './entities/content-task.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ContentTask]), HttpModule],
  controllers: [ContentController, JobsController],
  providers: [
    AdminApiKeyGuard,
    AiContentService,
    CollectionService,
    InstagramService,
    ImageGenerationService,
    SafetyService,
    SchedulerService,
    TaskQueueService,
  ],
  exports: [TaskQueueService],
})
export class ContentModule {}
