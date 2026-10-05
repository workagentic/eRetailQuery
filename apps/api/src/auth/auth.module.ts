import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';
import { buildVerifierFromEnv, JWT_VERIFIER } from './jwt-verifier';

@Global()
@Module({
  providers: [
    {
      provide: JWT_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (env: Env) => buildVerifierFromEnv(env),
    },
  ],
  exports: [JWT_VERIFIER],
})
export class AuthModule {}
