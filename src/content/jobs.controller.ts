import { Controller, Param, ParseEnumPipe, Post, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { PublishSlot, SchedulerService } from './services/scheduler.service';

@Controller('jobs')
@UseGuards(AdminApiKeyGuard)
export class JobsController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post('run-slot/:slot')
  runSlot(@Param('slot', new ParseEnumPipe(PublishSlot)) slot: PublishSlot) {
    return this.scheduler.runExternalSlot(slot);
  }
}
