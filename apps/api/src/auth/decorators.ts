import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { OrgRole } from '@erq/shared';
import { ApiError } from '../common/api-error';
import type { AuthedRequest } from './request';

export const ROLES_KEY = 'erq:min-role';
/** Minimum role required: `@Roles('admin')` allows admin and owner. */
export const Roles = (min: OrgRole) => SetMetadata(ROLES_KEY, min);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return user;
});

export const CurrentOrg = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const org = ctx.switchToHttp().getRequest<AuthedRequest>().org;
  if (!org) throw new ApiError(400, 'invalid_org', 'Organization context required');
  return org;
});
