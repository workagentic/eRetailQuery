import { describe, expect, it, vi } from 'vitest';
import type { OrgSummary } from '@erq/shared';
import { loadDemoContext, type DemoContextDeps } from './demo-context';

const org = (id: string): OrgSummary => ({ orgId: id, name: `Org ${id}`, slug: id, role: 'owner' });

function deps(over: Partial<DemoContextDeps> = {}): DemoContextDeps {
  return {
    getUser: async () => ({ id: 'user-1', email: 'boss@example.com' }),
    listOrgs: async () => [org('a'), org('b')],
    savedOrgId: async () => undefined,
    redirect: (path: string): never => {
      throw new Error(`redirect:${path}`);
    },
    ...over,
  };
}

describe('loadDemoContext', () => {
  it('redirects to /no-access when the user belongs to no org', async () => {
    await expect(loadDemoContext(deps({ listOrgs: async () => [] }))).rejects.toThrow(
      'redirect:/no-access',
    );
  });
  it('redirects to /login when there is no signed-in user', async () => {
    await expect(loadDemoContext(deps({ getUser: async () => null }))).rejects.toThrow(
      'redirect:/login',
    );
  });
  it('asks for the signed-in user’s orgs and returns the first one by default', async () => {
    const listOrgs = vi.fn(async () => [org('a'), org('b')]);
    const ctx = await loadDemoContext(deps({ listOrgs }));
    expect(listOrgs).toHaveBeenCalledWith('user-1');
    expect(ctx.active.orgId).toBe('a');
    expect(ctx.me).toEqual({ user: { id: 'user-1', email: 'boss@example.com' }, orgs: [org('a'), org('b')] });
  });
  it('returns the org saved in the cookie when the user still belongs to it', async () => {
    expect((await loadDemoContext(deps({ savedOrgId: async () => 'b' }))).active.orgId).toBe('b');
    expect((await loadDemoContext(deps({ savedOrgId: async () => 'gone' }))).active.orgId).toBe('a');
  });
});
