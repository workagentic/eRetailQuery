import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { JWT_VERIFIER, type JwtVerifier } from './jwt-verifier';
import type { AuthedRequest } from './request';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(JWT_VERIFIER) private readonly verifier: JwtVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(header) : null;
    if (!match?.[1])
      throw new ApiError(401, 'unauthenticated', 'Missing or malformed bearer token');
    req.user = await this.verifier.verify(match[1]);
    return true;
  }
}
