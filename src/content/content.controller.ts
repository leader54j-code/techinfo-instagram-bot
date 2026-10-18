import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { imageSize } from 'image-size';
import { diskStorage } from 'multer';
import { CreateTaskDto } from './dto/create-task.dto';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ListTasksDto } from './dto/list-tasks.dto';
import { TaskQueueService } from './services/task-queue.service';

const imageUpload = FileInterceptor('image', {
  storage: diskStorage({
    destination: './uploads',
    filename: (_request, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB ?? 8) * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const accepted = file.mimetype === 'image/jpeg' && /\.jpe?g$/i.test(file.originalname);
    callback(accepted ? null : new BadRequestException('Only JPEG images are supported'), accepted);
  },
});

@Controller('tasks')
@UseGuards(AdminApiKeyGuard)
export class ContentController {
  constructor(
    private readonly queue: TaskQueueService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @UseInterceptors(imageUpload)
  async create(
    @Body() input: CreateTaskDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (file) {
      const dimensions = imageSize(await readFile(file.path));
      if (!dimensions.width || !dimensions.height) {
        await unlink(file.path);
        throw new BadRequestException('Could not read image dimensions');
      }
      const ratio = dimensions.width / dimensions.height;
      if (ratio < 0.8 || ratio > 1.91) {
        await unlink(file.path);
        throw new BadRequestException('Instagram image aspect ratio must be between 4:5 and 1.91:1');
      }
      const baseUrl = this.config.get<string>('PUBLIC_BASE_URL');
      if (!baseUrl) {
        await unlink(file.path);
        throw new BadRequestException('PUBLIC_BASE_URL is required for uploaded media');
      }
      input.imagePublicUrl = `${baseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(file.filename)}`;
    }
    if (!input.imagePublicUrl) {
      throw new BadRequestException('Provide either imagePublicUrl or a JPEG image upload');
    }
    const imageUrl = new URL(input.imagePublicUrl);
    if (imageUrl.protocol !== 'https:' || !/\.jpe?g$/i.test(imageUrl.pathname)) {
      if (file) await unlink(file.path);
      throw new BadRequestException('imagePublicUrl must be a public HTTPS JPEG URL');
    }
    const existing = await this.queue.getByFingerprint(
      this.queue.fingerprint(input.sourceUrl, input.sourceTitle),
    );
    if (existing) {
      if (file) await unlink(file.path);
      return existing;
    }
    return this.queue.enqueue(input, file?.path);
  }

  @Get()
  list(@Query() query: ListTasksDto) {
    return this.queue.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.get(id);
  }
}
