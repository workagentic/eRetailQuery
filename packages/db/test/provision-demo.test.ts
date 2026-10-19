import { describe, expect, it } from 'vitest';
import { DEMO_USER_IDS } from '../src/seed';
import { buildAuthUserPayload, provisionDemoUser } from '../src/provision-demo';

const URL_ = 'https://abcd.supabase.co';
const KEY = 'service-role-key-value';

describe('buildAuthUserPayload', () => {
  it('maps the demo owner id to a confirmed auth user', () => {
    expect(buildAuthUserPayload('boss@example.com', 'a-long-demo-password')).toEqual({
      id: DEMO_USER_IDS.owner,
      email: 'boss@example.com',
      password: 'a-long-demo-password',
      email_confirm: true,
    });
  });
  it('rejects a missing email or a short password', () => {
    expect(() => buildAuthUserPayload('', 'a-long-demo-password')).toThrow(/DEMO_LOGIN_EMAIL/);
    expect(() => buildAuthUserPayload('not-an-email', 'a-long-demo-password')).toThrow(/DEMO_LOGIN_EMAIL/);
    expect(() => buildAuthUserPayload('boss@example.com', 'short')).toThrow(/DEMO_LOGIN_PASSWORD/);
  });
});

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('provisionDemoUser', () => {
  it('creates the user when it does not exist', async () => {
    const { impl, calls } = fakeFetch([{ status: 404 }, { status: 200 }]);
    const result = await provisionDemoUser({
      supabaseUrl: URL_,
      serviceRoleKey: KEY,
      email: 'boss@example.com',
      password: 'a-long-demo-password',
      fetchImpl: impl,
    });
    expect(result).toBe('created');
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${URL_}/auth/v1/admin/users/${DEMO_USER_IDS.owner}` });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${URL_}/auth/v1/admin/users` });
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ id: DEMO_USER_IDS.owner, email_confirm: true });
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('updates the email and password when the user already exists', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: DEMO_USER_IDS.owner } }, { status: 200 }]);
    const result = await provisionDemoUser({
      supabaseUrl: `${URL_}/`,
      serviceRoleKey: KEY,
      email: 'boss@example.com',
      password: 'a-long-demo-password',
      fetchImpl: impl,
    });
    expect(result).toBe('updated');
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${URL_}/auth/v1/admin/users/${DEMO_USER_IDS.owner}` });
  });

  it('fails with a message that never contains the key or the password', async () => {
    const { impl } = fakeFetch([{ status: 404 }, { status: 422, body: { msg: 'weak password' } }]);
    const error = await provisionDemoUser({
      supabaseUrl: URL_,
      serviceRoleKey: KEY,
      email: 'boss@example.com',
      password: 'a-long-demo-password',
      fetchImpl: impl,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('422');
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain('a-long-demo-password');
  });
});
