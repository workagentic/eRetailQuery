import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard';
import { CurrentOrg, CurrentUser, Roles } from '../src/auth/decorators';
import { OrgGuard } from '../src/auth/org.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { createTestApp, type TestApp } from './helpers/app';
import { createJoseVerifier } from '../src/auth/jwt-verifier';

@Controller('probe')
class ProbeController {
  @Get('user')
  @UseGuards(AuthGuard)
  user(@CurrentUser() u: { userId: string }) {
    return u;
  }

  @Get('org')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  org(@CurrentOrg() o: { orgId: string; role: string }) {
    return o;
  }

  @Get('admin')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  admin() {
    return { ok: true };
  }
}

let t: TestApp | undefined;
const U_OWNER = '00000000-0000-4000-8000-0000000000a1';
const U_VIEWER = '00000000-0000-4000-8000-0000000000a2';
const U_OUTSIDER = '00000000-0000-4000-8000-0000000000a3';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  t = await createTestApp({ extraControllers: [ProbeController] });
  const { Pool } = await import('pg');
  const owner = new Pool({ connectionString: t.tdb.ownerUrl });
  try {
    await owner.query(`insert into orgs (id,name,slug) values ($1,'A','a'),($2,'B','b')`, [
      ORG_A,
      ORG_B,
    ]);
    await owner.query(
      `insert into org_members (org_id,user_id,role) values ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
      [ORG_A, U_OWNER, U_VIEWER, ORG_B, U_OUTSIDER],
    );
  } finally {
    await owner.end();
  }
});
afterAll(async () => {
  await t?.close();
});

const tt = (): TestApp => t as TestApp;
const get = (path: string) => request(tt().app.getHttpServer()).get(path);

describe('authentication', () => {
  it('rejects a missing Authorization header', async () => {
    const res = await get('/probe/user');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
  it.each([
    'Bearer',
    'Bearer ',
    'Basic abc',
    'Bearer not.a.jwt',
    'Bearer ' + 'a'.repeat(5000),
    'bearer x',
    'Bearer a b',
    'Bearer a\tb',
    'Bearer "x"',
  ])('rejects garbage header %j with 401, never 500', async (header) => {
    expect((await get('/probe/user').set('authorization', header)).status).toBe(401);
  });
  // supertest/Node refuse to send a NUL byte in a header, so send it over a raw socket instead.
  it('answers a NUL byte in the Authorization header with a 4xx, never a 5xx', async () => {
    const server = tt().app.getHttpServer() as Server;
    if (!server.listening)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1');
      let data = '';
      sock.on('data', (d) => {
        data += d.toString('latin1');
      });
      sock.on('error', reject);
      sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 400)));
      sock.write(
        'GET /probe/user HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: bearer\u0000x\r\n\r\n',
        'latin1',
      );
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
  it('rejects an expired token', async () => {
    const token = await tt().signToken({ sub: U_OWNER, expiresIn: '-1h' });
    expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('rejects wrong issuer, wrong audience and a different signing key', async () => {
    const other = await generateKeyPair('ES256');
    for (const opts of [
      { iss: 'http://evil/auth/v1' },
      { aud: 'anon' },
      { key: other.privateKey },
    ]) {
      const token = await tt().signToken({ sub: U_OWNER, ...opts });
      expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
    }
  });
  it('rejects a non-uuid sub instead of passing it to Postgres', async () => {
    const token = await tt().signToken({ sub: "x'; drop table orgs;--" });
    expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('accepts a valid token', async () => {
    const token = await tt().signToken({ sub: U_OWNER });
    const res = await get('/probe/user').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(U_OWNER);
  });
});

describe('org context', () => {
  it('requires a valid X-Org-Id header', async () => {
    const token = await tt().signToken({ sub: U_OWNER });
    const auth = { authorization: `Bearer ${token}` };
    expect((await get('/probe/org').set(auth)).status).toBe(400);
    expect((await get('/probe/org').set({ ...auth, 'x-org-id': 'not-a-uuid' })).status).toBe(400);
    expect((await get('/probe/org').set({ ...auth, 'x-org-id': "1' or '1'='1" })).status).toBe(400);
  });
  it('403s for orgs the user does not belong to', async () => {
    const token = await tt().signToken({ sub: U_OWNER });
    const res = await get('/probe/org').set({
      authorization: `Bearer ${token}`,
      'x-org-id': ORG_B,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_a_member');
  });
  it('403s for a random but well-formed org id', async () => {
    const token = await tt().signToken({ sub: U_OWNER });
    const res = await get('/probe/org').set({
      authorization: `Bearer ${token}`,
      'x-org-id': '99999999-9999-4999-8999-999999999999',
    });
    expect(res.status).toBe(403);
  });
  it('resolves the role for members', async () => {
    const token = await tt().signToken({ sub: U_VIEWER });
    const res = await get('/probe/org').set({
      authorization: `Bearer ${token}`,
      'x-org-id': ORG_A,
    });
    expect(res.body).toEqual({ orgId: ORG_A, role: 'viewer' });
  });
});

describe('roles', () => {
  it('blocks a viewer from an admin route and allows an owner', async () => {
    const viewer = await tt().signToken({ sub: U_VIEWER });
    const owner = await tt().signToken({ sub: U_OWNER });
    expect(
      (await get('/probe/admin').set({ authorization: `Bearer ${viewer}`, 'x-org-id': ORG_A }))
        .status,
    ).toBe(403);
    expect(
      (await get('/probe/admin').set({ authorization: `Bearer ${owner}`, 'x-org-id': ORG_A }))
        .status,
    ).toBe(200);
  });
});

describe('verifier factory', () => {
  it('rejects tokens when the key is a mismatched HS256 secret', async () => {
    const v = createJoseVerifier({
      key: new TextEncoder().encode('secret'),
      issuer: 'x',
      algorithms: ['HS256'],
    });
    await expect(v.verify('a.b.c')).rejects.toThrow();
  });
});
