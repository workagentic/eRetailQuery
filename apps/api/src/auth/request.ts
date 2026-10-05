import type { Request } from 'express';
import type { OrgRole } from '@erq/shared';
import type { VerifiedUser } from './jwt-verifier';

export interface OrgContext {
  orgId: string;
  role: OrgRole;
}
export interface AuthedRequest extends Request {
  user?: VerifiedUser;
  org?: OrgContext;
}
