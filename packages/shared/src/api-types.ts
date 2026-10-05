import type { OrgRole } from './schemas';

export interface OrgSummary {
  orgId: string;
  name: string;
  slug: string;
  role: OrgRole;
}
export interface MeResponse {
  user: { id: string; email: string };
  orgs: OrgSummary[];
}
export interface MemberDto {
  userId: string;
  role: OrgRole;
  joinedAt: string;
}
export interface InviteDto {
  id: string;
  email: string;
  role: Exclude<OrgRole, 'owner'>;
  expiresAt: string;
  acceptedAt: string | null;
}
export interface CreatedInviteDto extends InviteDto {
  acceptUrl: string;
}
export interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
