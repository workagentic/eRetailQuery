import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { AppModule } from '../../src/app.module';
import { loadEnv } from '../../src/config/env';

export interface TestApp {
  app: INestApplication;
  tdb: TestDatabase;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const tdb = await startTestDatabase();
  const env = loadEnv({
    DATABASE_URL: tdb.appUrl,
    WEB_PUBLIC_URL: 'http://localhost:3000',
    SUPABASE_JWT_ISSUER: 'http://issuer.test/auth/v1',
    SUPABASE_JWT_SECRET: 'unused-in-tests',
    LOG_LEVEL: 'silent',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env)],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    tdb,
    close: async () => {
      await app.close();
      await tdb.stop();
    },
  };
}
