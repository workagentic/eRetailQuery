import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole, type OrgRole } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { ROLES_KEY } from './decorators';
import type { AuthedRequest } from './request';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const min = this.reflector.getAllAndOverride<OrgRole | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!min) return true;
    const role = ctx.switchToHttp().getRequest<AuthedRequest>().org?.role;
    if (!role || !hasRole(role, min))
      throw new ApiError(403, 'forbidden', `Requires ${min} role or higher`);
    return true;
  }
}
