import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { TenantDb } from '@erq/db';
import { ApiError } from '../common/api-error';
import { TENANT_DB } from '../db/db.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.pool.query('select 1');
    } catch {
      throw new ApiError(503, 'db_unavailable', 'Database is unavailable');
    }
    return { status: 'ok' };
  }
}
