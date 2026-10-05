import { z } from 'zod';

export const orgRoleSchema = z.enum(['owner', 'admin', 'analyst', 'viewer']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

/** True when `actual` is `min` or higher. */
export function hasRole(actual: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

export const uuidSchema = z.string().uuid();

export const createOrgInput = z.object({ name: z.string().trim().min(2).max(100) });
export type CreateOrgInput = z.infer<typeof createOrgInput>;

export const createInviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'analyst', 'viewer']),
});
export type CreateInviteInput = z.infer<typeof createInviteInput>;
