import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { slugify, type OrgRole, type OrgSummary } from '@erq/shared';

export class InviteInvalidError extends Error {
  constructor() {
    super('invite_invalid');
  }
}

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface OrgRow {
  org_id: string;
  name: string;
  slug: string;
  role: OrgRole;
}
const toSummary = (r: OrgRow): OrgSummary => ({
  orgId: r.org_id,
  name: r.name,
  slug: r.slug,
  role: r.role,
});

export interface AccountApi {
  listUserOrgs(userId: string): Promise<OrgSummary[]>;
  createOrg(userId: string, name: string): Promise<OrgSummary>;
  acceptInvite(
    userId: string,
    email: string,
    token: string,
  ): Promise<{ orgId: string; role: OrgRole }>;
}

export function createAccountApi(pool: Pool): AccountApi {
  async function listUserOrgs(userId: string): Promise<OrgSummary[]> {
    const { rows } = await pool.query<OrgRow>('select * from app_list_user_orgs($1)', [userId]);
    return rows.map(toSummary);
  }
  return {
    listUserOrgs,
    async createOrg(userId, name) {
      const base = slugify(name);
      for (let attempt = 0; attempt < 4; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
        try {
          const { rows } = await pool.query<{ id: string }>(
            'select app_create_org($1, $2, $3) as id',
            [userId, name, slug],
          );
          const created = (await listUserOrgs(userId)).find((o) => o.orgId === rows[0]!.id);
          if (!created) throw new Error('org created but not visible to creator');
          return created;
        } catch (e) {
          if ((e as { code?: string }).code !== '23505') throw e; // only retry slug collisions
        }
      }
      throw new Error('could not allocate a unique org slug');
    },
    async acceptInvite(userId, email, token) {
      try {
        const { rows } = await pool.query<{ o_org_id: string; o_role: OrgRole }>(
          'select * from app_accept_invite($1, $2, $3)',
          [userId, email, hashInviteToken(token)],
        );
        return { orgId: rows[0]!.o_org_id, role: rows[0]!.o_role };
      } catch (e) {
        if ((e as Error).message === 'invite_invalid') throw new InviteInvalidError();
        throw e;
      }
    },
  };
}
