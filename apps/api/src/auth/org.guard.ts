import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { orgMembers, type TenantDb } from '@erq/db';
import { uuidSchema } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { TENANT_DB } from '../db/db.module';
import type { AuthedRequest } from './request';

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Authentication required');

    const header = req.headers['x-org-id'];
    const orgId = (Array.isArray(header) ? header[0] : header)?.toLowerCase();
    if (!orgId || !uuidSchema.safeParse(orgId).success) {
      throw new ApiError(400, 'invalid_org', 'X-Org-Id header must be a valid organization id');
    }
    const rawParam = req.params['orgId'];
    const param = (Array.isArray(rawParam) ? rawParam[0] : rawParam)?.toLowerCase();
    if (param && param !== orgId)
      throw new ApiError(400, 'org_mismatch', 'X-Org-Id does not match the URL');

    // RLS limits this query to the requested org, so a non-member simply gets no rows.
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.userId, user.userId)),
    );
    const role = rows[0]?.role;
    if (!role) throw new ApiError(403, 'not_a_member', 'You are not a member of this organization');
    req.org = { orgId, role };
    return true;
  }
}
