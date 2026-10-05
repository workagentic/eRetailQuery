import 'server-only';
import { createSupabaseServerClient } from './supabase/server';

export const ORG_COOKIE = 'erq_org';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { orgId?: string } = {},
): Promise<T> {
  const supabase = await createSupabaseServerClient();
  // The API verifies this JWT itself; middleware has already validated the session with getUser().
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new ApiRequestError(401, 'unauthenticated', 'Not signed in');

  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.access_token}`);
  if (init.orgId) headers.set('x-org-id', init.orgId);
  if (init.body) headers.set('content-type', 'application/json');

  const res = await fetch(`${process.env.API_URL}${path}`, { ...init, headers, cache: 'no-store' });
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      json?.error?.code ?? 'unknown',
      json?.error?.message ?? res.statusText,
    );
  }
  return json as T;
}
