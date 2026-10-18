import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('ADMIN_API_KEY');
    if (!expected && this.config.get<string>('NODE_ENV') !== 'production') return true;
    const provided = context.switchToHttp().getRequest<Request>().header('x-admin-api-key');
    if (!expected || provided !== expected) throw new UnauthorizedException('Invalid admin API key');
    return true;
  }
}
