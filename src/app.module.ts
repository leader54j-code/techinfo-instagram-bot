import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModule } from './content/content.module';
import { ContentTask } from './content/entities/content-task.entity';
import { validateEnvironment } from './config/environment';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        ssl: config.get<string>('DATABASE_SSL') === 'true' ? { rejectUnauthorized: false } : false,
        entities: [ContentTask],
        migrations: ['dist/migrations/*.js'],
        migrationsRun: config.get<string>('RUN_MIGRATIONS') !== 'false',
        synchronize: false,
      }),
    }),
    ContentModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
