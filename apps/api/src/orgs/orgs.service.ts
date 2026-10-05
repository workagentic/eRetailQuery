import { Inject, Injectable } from '@nestjs/common';
import { asc, isNull } from 'drizzle-orm';
import {
  generateInviteToken,
  hashInviteToken,
  insertAudit,
  invites,
  orgMembers,
  type AccountApi,
  type TenantDb,
} from '@erq/db';
import type {
  CreatedInviteDto,
  CreateInviteInput,
  InviteDto,
  MeResponse,
  MemberDto,
  OrgSummary,
} from '@erq/shared';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';
import { ACCOUNT_API, TENANT_DB } from '../db/db.module';
import type { VerifiedUser } from '../auth/jwt-verifier';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class OrgsService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(ACCOUNT_API) private readonly account: AccountApi,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async me(user: VerifiedUser): Promise<MeResponse> {
    return {
      user: { id: user.userId, email: user.email },
      orgs: await this.account.listUserOrgs(user.userId),
    };
  }

  createOrg(user: VerifiedUser, name: string): Promise<OrgSummary> {
    return this.account.createOrg(user.userId, name);
  }

  async listMembers(orgId: string): Promise<MemberDto[]> {
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          joinedAt: orgMembers.createdAt,
        })
        .from(orgMembers)
        .orderBy(asc(orgMembers.createdAt)),
    );
    return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
  }

  async listPendingInvites(orgId: string): Promise<InviteDto[]> {
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx.select().from(invites).where(isNull(invites.acceptedAt)).orderBy(asc(invites.createdAt)),
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role as InviteDto['role'],
      expiresAt: r.expiresAt.toISOString(),
      acceptedAt: null,
    }));
  }

  async createInvite(
    orgId: string,
    actor: VerifiedUser,
    input: CreateInviteInput,
  ): Promise<CreatedInviteDto> {
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const row = await this.db.withTenant(orgId, async (tx) => {
      const [inserted] = await tx
        .insert(invites)
        .values({
          orgId,
          email: input.email,
          role: input.role,
          tokenHash: hashInviteToken(token),
          invitedBy: actor.userId,
          expiresAt,
        })
        .returning();
      await insertAudit(tx, {
        orgId,
        actorUserId: actor.userId,
        action: 'invite.created',
        entityType: 'invite',
        entityId: inserted!.id,
        after: { email: input.email, role: input.role },
      });
      return inserted!;
    });
    // No email provider in Phase 0: the inviter shares this link. The raw token is never stored or listed.
    return {
      id: row.id,
      email: row.email,
      role: input.role,
      expiresAt: expiresAt.toISOString(),
      acceptedAt: null,
      acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/${token}`,
    };
  }

  acceptInvite(user: VerifiedUser, token: string) {
    return this.account.acceptInvite(user.userId, user.email, token);
  }
}
