import { DynamicModule, Global, Module } from '@nestjs/common';
import { createLogger } from '@erq/shared';
import type { Env } from './env';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOGGER = Symbol('LOGGER');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: env },
        { provide: LOGGER, useValue: createLogger({ level: env.LOG_LEVEL }) },
      ],
      exports: [APP_CONFIG, LOGGER],
    };
  }
}
