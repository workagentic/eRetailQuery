import { DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  static register(env: Env, extras: { controllers?: Type<unknown>[] } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(env), DbModule.forRoot(), AuthModule],
      controllers: [HealthController, ...(extras.controllers ?? [])],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
