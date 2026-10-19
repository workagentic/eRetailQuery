import { DEMO_USER_IDS } from './seed';

export interface AuthUserPayload {
  id: string;
  email: string;
  password: string;
  email_confirm: true;
}

/**
 * The demo login is the seeded demo owner: the seed already makes DEMO_USER_IDS.owner an owner of the demo org,
 * so an auth user created with that exact id needs no further membership row.
 */
export function buildAuthUserPayload(email: string, password: string): AuthUserPayload {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('DEMO_LOGIN_EMAIL must be a valid email address');
  }
  if (password.length < 12) {
    throw new Error('DEMO_LOGIN_PASSWORD must be at least 12 characters');
  }
  return { id: DEMO_USER_IDS.owner, email, password, email_confirm: true };
}

/**
 * Creates or updates the demo owner in Supabase Auth through the Admin API
 * (https://supabase.com/docs/reference/javascript/auth-admin-createuser).
 * The service role key is only ever sent in the Authorization header and never appears in errors.
 */
export async function provisionDemoUser(opts: {
  supabaseUrl: string;
  serviceRoleKey: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const payload = buildAuthUserPayload(opts.email, opts.password);
  const base = `${opts.supabaseUrl.replace(/\/+$/, '')}/auth/v1/admin/users`;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${opts.serviceRoleKey}`,
    apikey: opts.serviceRoleKey,
    'content-type': 'application/json',
  };

  const existing = await doFetch(`${base}/${payload.id}`, { method: 'GET', headers });
  if (existing.status !== 200 && existing.status !== 404) {
    throw new Error(`Supabase Auth admin lookup failed with HTTP ${existing.status}`);
  }
  const exists = existing.status === 200;
  const res = await doFetch(exists ? `${base}/${payload.id}` : base, {
    method: exists ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `Supabase Auth admin ${exists ? 'update' : 'create'} failed with HTTP ${res.status}`,
    );
  }
  return exists ? 'updated' : 'created';
}
