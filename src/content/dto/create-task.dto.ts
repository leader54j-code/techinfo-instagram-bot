import { IsDateString, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @Length(3, 300)
  topic: string;

  @IsUrl({ require_protocol: true })
  sourceUrl: string;

  @IsString()
  @Length(3, 500)
  sourceTitle: string;

  @IsString()
  @Length(20, 12000)
  sourceExcerpt: string;

  @IsOptional()
  @IsDateString()
  sourcePublishedAt?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  imagePublicUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageAltText?: string;
}
