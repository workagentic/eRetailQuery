import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { createAccountApi, createTenantDb, type AccountApi, type TenantDb } from '@erq/db';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';

export const TENANT_DB = Symbol('TENANT_DB');
export const ACCOUNT_API = Symbol('ACCOUNT_API');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

@Global()
@Module({})
export class DbModule {
  static forRoot(): DynamicModule {
    return {
      module: DbModule,
      providers: [
        {
          provide: TENANT_DB,
          inject: [APP_CONFIG],
          useFactory: (env: Env) => createTenantDb(env.DATABASE_URL),
        },
        {
          provide: ACCOUNT_API,
          inject: [TENANT_DB],
          useFactory: (db: TenantDb): AccountApi => createAccountApi(db.pool),
        },
        DbLifecycle,
      ],
      exports: [TENANT_DB, ACCOUNT_API],
    };
  }
}
