import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication, Type } from '@nestjs/common';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { AppModule } from '../../src/app.module';
import { createJoseVerifier, JWT_VERIFIER } from '../../src/auth/jwt-verifier';
import { loadEnv } from '../../src/config/env';

export const ISSUER = 'http://issuer.test/auth/v1';

export interface TokenOptions {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  key?: KeyLike;
  noExp?: boolean;
  extraClaims?: Record<string, unknown>;
}

export interface TestApp {
  app: INestApplication;
  tdb: TestDatabase;
  privateKey: KeyLike;
  signToken(opts?: TokenOptions): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: {
    extraControllers?: Type<unknown>[];
    env?: Record<string, string>;
    overrides?: { provide: unknown; useValue: unknown }[];
  } = {},
): Promise<TestApp> {
  const tdb = await startTestDatabase();
  try {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const env = loadEnv({
      DATABASE_URL: tdb.appUrl,
      WEB_PUBLIC_URL: 'http://localhost:3000',
      SUPABASE_JWT_ISSUER: ISSUER,
      SUPABASE_JWT_SECRET: 'unused-in-tests',
      LOG_LEVEL: 'silent',
      ...opts.env,
    });
    const builder = Test.createTestingModule({
      imports: [AppModule.register(env, { controllers: opts.extraControllers })],
    })
      .overrideProvider(JWT_VERIFIER)
      .useValue(createJoseVerifier({ key: publicKey, issuer: ISSUER, algorithms: ['ES256'] }));
    for (const o of opts.overrides ?? []) builder.overrideProvider(o.provide).useValue(o.useValue);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    return {
      app,
      tdb,
      privateKey,
      signToken: (o = {}) => {
        const jwt = new SignJWT({ email: o.email ?? 'owner@example.com', ...o.extraClaims })
          .setProtectedHeader({ alg: 'ES256' })
          .setSubject(o.sub ?? randomUUID())
          .setIssuer(o.iss ?? ISSUER)
          .setAudience(o.aud ?? 'authenticated')
          .setIssuedAt();
        if (!o.noExp) jwt.setExpirationTime(o.expiresIn ?? '1h');
        return jwt.sign(o.key ?? privateKey);
      },
      close: async () => {
        try {
          await app.close();
        } finally {
          await tdb.stop();
        }
      },
    };
  } catch (err) {
    await tdb.stop();
    throw err;
  }
}
