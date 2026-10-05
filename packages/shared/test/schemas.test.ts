import { describe, expect, it } from 'vitest';
import { createInviteInput, createOrgInput, hasRole, uuidSchema } from '../src/schemas';

describe('hasRole', () => {
  it('ranks owner > admin > analyst > viewer', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('analyst', 'admin')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'analyst')).toBe(false);
  });
});

describe('createOrgInput', () => {
  it('trims and accepts a normal name', () => {
    expect(createOrgInput.parse({ name: '  Acme Goods ' })).toEqual({ name: 'Acme Goods' });
  });
  it.each([{ name: '' }, { name: 'a' }, { name: 'x'.repeat(101) }, {}, { name: 5 }])(
    'rejects %j',
    (v) => {
      expect(createOrgInput.safeParse(v).success).toBe(false);
    },
  );
});

describe('createInviteInput', () => {
  it('lowercases the email', () => {
    expect(createInviteInput.parse({ email: ' Bob@Example.COM ', role: 'viewer' })).toEqual({
      email: 'bob@example.com',
      role: 'viewer',
    });
  });
  it('cannot invite an owner', () => {
    expect(createInviteInput.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
  });
  it('rejects bad emails', () => {
    expect(createInviteInput.safeParse({ email: 'nope', role: 'admin' }).success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts uuids and rejects other strings', () => {
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true);
    expect(uuidSchema.safeParse("1'; drop table orgs;--").success).toBe(false);
  });
});
