import type { MeResponse, OrgSummary } from '@erq/shared';

export interface DemoContextDeps {
  getUser(): Promise<{ id: string; email: string } | null>;
  listOrgs(userId: string): Promise<OrgSummary[]>;
  savedOrgId(): Promise<string | undefined>;
  redirect(path: string): never;
}

/**
 * Demo-mode replacement for the API's /me: reads the signed-in user's orgs straight from the database.
 * Sends users without an org to /no-access instead of an error page.
 */
export async function loadDemoContext(
  deps: DemoContextDeps,
): Promise<{ me: MeResponse; active: OrgSummary }> {
  const user = await deps.getUser();
  if (!user) return deps.redirect('/login');
  const orgs = await deps.listOrgs(user.id);
  const first = orgs[0];
  if (!first) return deps.redirect('/no-access');
  const saved = await deps.savedOrgId();
  const active = orgs.find((o) => o.orgId === saved) ?? first;
  return { me: { user: { id: user.id, email: user.email }, orgs }, active };
}
