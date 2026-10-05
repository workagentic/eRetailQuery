import { describe, expect, it } from 'vitest';
import type { AccountApi, TenantDb } from '@erq/db';
import type { Env } from '../src/config/env';
import { OrgsService } from '../src/orgs/orgs.service';

describe('OrgsService.createInvite', () => {
  it('builds the accept URL without a double slash when WEB_PUBLIC_URL has trailing slashes', async () => {
    const db = {
      withTenant: async () => ({ id: 'inv-1', email: 'a@b.co' }),
    } as unknown as TenantDb;
    const service = new OrgsService(
      db,
      {} as AccountApi,
      {
        WEB_PUBLIC_URL: 'https://app.example.com//',
      } as Env,
    );
    const res = await service.createInvite(
      '11111111-1111-4111-8111-111111111111',
      { userId: 'u', email: 'o@x.co' },
      { email: 'a@b.co', role: 'viewer' },
    );
    expect(res.acceptUrl).toMatch(/^https:\/\/app\.example\.com\/invite\/[A-Za-z0-9_-]+$/);
    expect(res.acceptUrl).not.toContain('//invite');
  });
});
