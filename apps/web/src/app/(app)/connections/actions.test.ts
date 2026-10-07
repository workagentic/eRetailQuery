import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ApiRequestError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiRequestError,
    apiFetch: vi.fn(),
    loadAppContext: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('@/lib/api', () => ({ apiFetch: h.apiFetch, ApiRequestError: h.ApiRequestError }));
vi.mock('@/lib/app-context', () => ({ loadAppContext: h.loadAppContext }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { syncNowAction } from './actions';

const form = (id?: string) => {
  const f = new FormData();
  if (id !== undefined) f.set('id', id);
  return f;
};
const GENERIC = 'We could not start the import. Please try again.';

beforeEach(() => {
  vi.clearAllMocks();
  h.loadAppContext.mockResolvedValue({ active: { orgId: 'org-1' } });
});

describe('syncNowAction', () => {
  it('posts to the active org sync route and refreshes the page', async () => {
    h.apiFetch.mockResolvedValue({ started: true });
    await expect(syncNowAction(undefined, form('c 1'))).resolves.toEqual({ started: true });
    expect(h.apiFetch).toHaveBeenCalledWith('/orgs/org-1/connections/c%201/sync', {
      method: 'POST',
      orgId: 'org-1',
    });
    expect(h.revalidatePath).toHaveBeenCalledWith('/connections');
  });

  it('reports started false when an import is already running', async () => {
    h.apiFetch.mockResolvedValue({ started: false });
    await expect(syncNowAction(undefined, form('c1'))).resolves.toEqual({ started: false });
  });

  it.each([
    [409, 'This connection is not active.'],
    [503, 'Importing is not available right now.'],
  ])('passes the API message through for %i and refreshes the page', async (status, message) => {
    h.apiFetch.mockRejectedValue(new h.ApiRequestError(status, 'x', message));
    await expect(syncNowAction(undefined, form('c1'))).resolves.toEqual({ error: message });
    expect(h.revalidatePath).toHaveBeenCalledWith('/connections');
  });

  it('hides other failures behind a generic message', async () => {
    h.apiFetch.mockRejectedValue(new h.ApiRequestError(404, 'not_found', 'internal detail'));
    await expect(syncNowAction(undefined, form('c1'))).resolves.toEqual({ error: GENERIC });
    h.apiFetch.mockRejectedValue(new Error('socket hang up'));
    await expect(syncNowAction(undefined, form('c1'))).resolves.toEqual({ error: GENERIC });
  });

  it('rejects a missing or empty id without calling the API', async () => {
    await expect(syncNowAction(undefined, form())).resolves.toEqual({ error: GENERIC });
    await expect(syncNowAction(undefined, form(''))).resolves.toEqual({ error: GENERIC });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it('lets the redirect for an unauthenticated user propagate', async () => {
    h.loadAppContext.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(syncNowAction(undefined, form('c1'))).rejects.toThrow('NEXT_REDIRECT');
    expect(h.apiFetch).not.toHaveBeenCalled();
  });
});
