import { beforeAll, describe, expect, it } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import type { DBAdapter } from 'better-auth/adapters';
import { createDatabase } from '../../../packages/platform/src/control/auth/database';
import { EncryptedFieldQueryError, makeSessionHandle } from '../../../packages/platform/src/control/auth/adapter-wrapper';
import { getKeyRing, KeyDestroyedError } from '../../../packages/platform/src/control/keys';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { keysEnv, TEST_AUTH_SECRET, uid } from './helpers/keys-env';
import { authPlugins, ensureAuthSchema } from './helpers/keys-auth';

const env = keysEnv();
const ring = getKeyRing(env);
let a: DBAdapter;

type Row = Record<string, unknown>;
const raw = (table: string, id: string) => env.DB.prepare(`SELECT * FROM "${table}" WHERE id = ?`).bind(id).first<Row>();
const now = () => new Date();

async function newUser(email = `${uid()}@Example.com`, name = 'Ana Tester') {
  const user = await a.create<Row>({
    model: 'user',
    data: { email, name, emailVerified: true, createdAt: now(), updatedAt: now() },
  });
  return user as Row & { id: string; email: string };
}

async function newOrg(name = 'Acme') {
  return (await a.create<Row>({
    model: 'organization',
    data: { name, slug: uid(), createdAt: now() },
  })) as Row & { id: string };
}

async function newSession(userId: string, token = `tok-${uid()}`) {
  const s = await a.create<Row>({
    model: 'session',
    data: { userId, token, expiresAt: new Date(Date.now() + 3600_000), ipAddress: '203.0.113.7', userAgent: 'Firefox/200', createdAt: now(), updatedAt: now() },
  });
  return { s: s as Row & { id: string; token: string }, token };
}

beforeAll(async () => {
  await ensureAuthSchema(env);
  a = createDatabase(env)({ plugins: authPlugins() } as BetterAuthOptions);
});

describe('adapter wrapper: users and blind index', () => {
  it('stores ciphertext and the index, returns plaintext', async () => {
    const u = await newUser('Ana@Example.com');
    expect(u.email).toBe('Ana@Example.com');
    expect(u.name).toBe('Ana Tester');
    const r = (await raw('user', u.id))!;
    expect(ring.isCiphertext(r.email)).toBe(true);
    expect(ring.isCiphertext(r.name)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/ana|tester/i);
    expect(r.emailIndex).toBe(await ring.emailIndex('ana@example.com'));
    const keys = await env.DB.prepare("SELECT count(*) AS n FROM data_keys WHERE owner_type = 'user' AND owner_id = ?").bind(u.id).first<{ n: number }>();
    expect(keys!.n).toBe(1);
  });

  it('finds by email through the index (eq, in, any case)', async () => {
    const u = await newUser();
    const lower = u.email.toLowerCase();
    expect((await a.findOne<Row>({ model: 'user', where: [{ field: 'email', value: lower }] }))?.id).toBe(u.id);
    const many = await a.findMany<Row>({ model: 'user', where: [{ field: 'email', operator: 'in', value: [lower, 'nobody@example.com'] }] });
    expect(many.map((x) => x.id)).toEqual([u.id]);
    expect(await a.findOne({ model: 'user', where: [{ field: 'email', value: 'nobody@example.com' }] })).toBeNull();
    expect(await a.count({ model: 'user', where: [{ field: 'email', value: lower }] })).toBe(1);
  });

  it('rejects other operators, plain lookups on encrypted fields, and sorting by them (D54)', async () => {
    await expect(a.findMany({ model: 'user', where: [{ field: 'email', operator: 'contains', value: 'ana' }] })).rejects.toBeInstanceOf(EncryptedFieldQueryError);
    await expect(a.findMany({ model: 'user', where: [{ field: 'email', operator: 'ne', value: 'x' }] })).rejects.toBeInstanceOf(EncryptedFieldQueryError);
    await expect(a.findOne({ model: 'user', where: [{ field: 'name', value: 'Ana Tester' }] })).rejects.toBeInstanceOf(EncryptedFieldQueryError);
    await expect(a.findMany({ model: 'user', sortBy: { field: 'name', direction: 'asc' } })).rejects.toBeInstanceOf(EncryptedFieldQueryError);
  });

  it('decrypts with a narrow select and strips the fields it added', async () => {
    const u = await newUser();
    const r = await a.findOne<Row>({ model: 'user', where: [{ field: 'id', value: u.id }], select: ['email'] });
    expect(r).toEqual({ email: u.email });
  });

  it('rejects a ciphertext copied to another row (AAD)', async () => {
    const x = await newUser();
    const y = await newUser();
    const rx = (await raw('user', x.id))!;
    await env.DB.prepare('UPDATE "user" SET name = ? WHERE id = ?').bind(rx.name, y.id).run();
    await expect(a.findOne({ model: 'user', where: [{ field: 'id', value: y.id }] })).rejects.toThrow(/cannot decrypt|decrypt/);
  });

  it('keeps one user per email (unique index), and the failed row is removed', async () => {
    const u = await newUser();
    await expect(newUser(u.email.toUpperCase())).rejects.toThrow();
    expect(await a.count({ model: 'user', where: [{ field: 'email', value: u.email }] })).toBe(1);
  });

  it('update re-encrypts and moves the index; updateMany works row by row', async () => {
    const u = await newUser();
    const newEmail = `${uid()}@example.com`;
    const upd = await a.update<Row>({ model: 'user', where: [{ field: 'email', value: u.email }], update: { email: newEmail, name: 'Renamed' } });
    expect(upd).toMatchObject({ id: u.id, email: newEmail, name: 'Renamed' });
    expect(await a.findOne({ model: 'user', where: [{ field: 'email', value: u.email }] })).toBeNull();
    expect((await a.findOne<Row>({ model: 'user', where: [{ field: 'email', value: newEmail }] }))?.name).toBe('Renamed');
    expect((await raw('user', u.id))!.emailIndex).toBe(await ring.emailIndex(newEmail));

    const org = await newOrg();
    for (const name of ['One', 'Two']) await a.create({ model: 'team', data: { name, organizationId: org.id, createdAt: now() } });
    expect(await a.updateMany({ model: 'team', where: [{ field: 'organizationId', value: org.id }], update: { name: 'Same' } })).toBe(2);
    const teams = await a.findMany<Row>({ model: 'team', where: [{ field: 'organizationId', value: org.id }] });
    expect(teams.map((t) => t.name)).toEqual(['Same', 'Same']);
  });

  it('a destroyed user key makes their rows unreadable', async () => {
    const u = await newUser();
    await ring.destroyKey({ type: 'user', id: u.id });
    await expect(a.findOne({ model: 'user', where: [{ field: 'id', value: u.id }] })).rejects.toBeInstanceOf(KeyDestroyedError);
  });
});

describe('adapter wrapper: sessions', () => {
  it('stores the token hashed, finds it by the raw token, decrypts the joined user', async () => {
    const u = await newUser();
    const { s, token } = await newSession(u.id);
    expect(s.token).toBe(token);
    expect(s.ipAddress).toBe('203.0.113.7');
    const r = (await raw('session', s.id))!;
    expect(r.token).toBe(`h1.${await sha256Hex(token)}`);
    expect(ring.isCiphertext(r.ipAddress)).toBe(true);
    expect(ring.isCiphertext(r.userAgent)).toBe(true);

    const found = await a.findOne<Row & { user: Row }>({ model: 'session', where: [{ field: 'token', value: token }], join: { user: true } });
    expect(found).toMatchObject({ id: s.id, token, userAgent: 'Firefox/200' });
    expect(found!.user).toMatchObject({ id: u.id, email: u.email, name: 'Ana Tester' });
  });

  it('handles in-lookups, hashed values passed back, updates and deletes by token', async () => {
    const u = await newUser();
    const one = await newSession(u.id);
    const two = await newSession(u.id);
    const many = await a.findMany<Row & { user: Row }>({
      model: 'session',
      where: [{ field: 'token', operator: 'in', value: [one.token, two.token] }],
      join: { user: true },
    });
    expect(many.map((m) => m.token).sort()).toEqual([one.token, two.token].sort());
    expect(many.every((m) => m.user.email === u.email)).toBe(true);

    // Listed by user id, the token comes back as a signed handle, never the stored hash;
    // Better Auth's revokeSession passes it back to find and delete the session.
    const listed = await a.findMany<Row>({ model: 'session', where: [{ field: 'userId', value: u.id }] });
    const handle = String(listed.find((x) => x.id === one.s.id)!.token);
    expect(handle.startsWith('r1.')).toBe(true);
    expect(handle).not.toContain(await sha256Hex(one.token));
    expect((await a.findOne<Row>({ model: 'session', where: [{ field: 'token', value: handle }] }))?.id).toBe(one.s.id);

    const later = new Date(Date.now() + 7200_000);
    const upd = await a.update<Row>({ model: 'session', where: [{ field: 'token', value: one.token }], update: { expiresAt: later, userAgent: 'Chrome/300' } });
    expect(upd).toMatchObject({ token: one.token, userAgent: 'Chrome/300' });
    expect(ring.isCiphertext((await raw('session', one.s.id))!.userAgent)).toBe(true);

    await a.delete({ model: 'session', where: [{ field: 'token', value: handle }] });
    expect(await a.deleteMany({ model: 'session', where: [{ field: 'token', operator: 'in', value: [two.token] }] })).toBe(1);
    expect(await a.count({ model: 'session', where: [{ field: 'userId', value: u.id }] })).toBe(0);
  });

  it('a stored hash, or a forged or expired handle, does not work as a token', async () => {
    const u = await newUser();
    const { s } = await newSession(u.id);
    const stored = String((await raw('session', s.id))!.token);
    const find = (token: string) => a.findOne({ model: 'session', where: [{ field: 'token', value: token }] });
    expect(await find(stored)).toBeNull();
    expect(await find(stored.slice('h1.'.length))).toBeNull();
    expect(await a.findMany({ model: 'session', where: [{ field: 'token', operator: 'in', value: [stored] }] })).toEqual([]);
    const expired = await makeSessionHandle(TEST_AUTH_SECRET, s.id, stored, Date.now() - 3600_000);
    expect(await find(expired)).toBeNull();
    const forged = await makeSessionHandle('another-secret', s.id, stored);
    expect(await find(forged)).toBeNull();
    const [, id, exp] = (await makeSessionHandle(TEST_AUTH_SECRET, s.id, stored)).split('.');
    expect(await find(`r1.${id}.${Number(exp) + 999999}.${'0'.repeat(64)}`)).toBeNull();
    await a.deleteMany({ model: 'session', where: [{ field: 'token', value: stored }] });
    expect(await raw('session', s.id)).not.toBeNull();
  });

  it('wraps the adapter handed to transaction callbacks', async () => {
    const u = await newUser();
    const token = `tok-${uid()}`;
    const found = await a.transaction(async (trx) => {
      await trx.create({ model: 'session', data: { userId: u.id, token, expiresAt: new Date(Date.now() + 1000_000), ipAddress: '1.2.3.4', userAgent: 'ua', createdAt: now(), updatedAt: now() } });
      return trx.findOne<Row>({ model: 'session', where: [{ field: 'token', value: token }] });
    });
    expect(found).toMatchObject({ token, ipAddress: '1.2.3.4' });
    const r = await env.DB.prepare('SELECT token, ipAddress FROM session WHERE userId = ?').bind(u.id).first<Row>();
    expect(r!.token).not.toBe(token);
    expect(ring.isCiphertext(r!.ipAddress)).toBe(true);
  });
});

describe('adapter wrapper: orgs, invitations, accounts, SSO', () => {
  it('creates the org key and encrypts org-owned rows with it', async () => {
    const org = await newOrg('Initech');
    expect(org.name).toBe('Initech');
    const key = await env.DB.prepare("SELECT version FROM data_keys WHERE owner_type = 'org' AND owner_id = ?").bind(org.id).first();
    expect(key).not.toBeNull();
    const team = (await a.create<Row>({ model: 'team', data: { name: 'Platform', organizationId: org.id, createdAt: now() } })) as Row & { id: string };
    expect(team.name).toBe('Platform');
    expect(ring.isCiphertext((await raw('team', team.id))!.name)).toBe(true);
    expect(ring.isCiphertext((await raw('organization', org.id))!.name)).toBe(true);
  });

  it('invitations: email by index together with other conditions; consumeOne decrypts', async () => {
    const org = await newOrg();
    const inviter = await newUser();
    const email = `${uid()}@invitee.com`;
    const inv = (await a.create<Row>({
      model: 'invitation',
      data: { organizationId: org.id, email, role: 'tenant_user', status: 'pending', expiresAt: new Date(Date.now() + 1e6), inviterId: inviter.id, createdAt: now() },
    })) as Row & { id: string };
    const r = (await raw('invitation', inv.id))!;
    expect(ring.isCiphertext(r.email)).toBe(true);
    expect(r.emailIndex).toBe(await ring.emailIndex(email));
    const found = await a.findMany<Row>({
      model: 'invitation',
      where: [
        { field: 'email', value: email.toUpperCase() },
        { field: 'organizationId', value: org.id },
        { field: 'status', value: 'pending' },
      ],
    });
    expect(found.map((x) => x.email)).toEqual([email]);
    const consumed = await a.consumeOne<Row>({ model: 'invitation', where: [{ field: 'email', value: email }] });
    expect(consumed).toMatchObject({ id: inv.id, email });
    expect(await raw('invitation', inv.id)).toBeNull();
  });

  it('incrementOne passes through, and encrypts a `set` on an encrypted field', async () => {
    const u = await newUser();
    const res = await a.incrementOne<Row>({ model: 'user', where: [{ field: 'email', value: u.email }], increment: {}, set: { name: 'Counted' } });
    expect(res).toMatchObject({ id: u.id, name: 'Counted' });
    expect(ring.isCiphertext((await raw('user', u.id))!.name)).toBe(true);
    expect(await a.incrementOne({ model: 'user', where: [{ field: 'email', value: 'none@example.com' }], increment: {}, set: { name: 'x' } })).toBeNull();
  });

  it('consumeOne on unencrypted models is a passthrough', async () => {
    const v = (await a.create<Row>({ model: 'verification', data: { identifier: `id-${uid()}`, value: 'v', expiresAt: new Date(Date.now() + 1e6), createdAt: now(), updatedAt: now() } })) as Row & { identifier: string };
    expect(await a.consumeOne<Row>({ model: 'verification', where: [{ field: 'identifier', value: v.identifier }] })).toMatchObject({ value: 'v' });
    expect(await a.consumeOne({ model: 'verification', where: [{ field: 'identifier', value: v.identifier }] })).toBeNull();
  });

  it('encrypts OAuth tokens with the user key', async () => {
    const u = await newUser();
    const acc = (await a.create<Row>({
      model: 'account',
      data: { userId: u.id, accountId: 'g-1', providerId: 'google', accessToken: 'ya29.secret', refreshToken: '1//refresh', idToken: 'eyJ.id', createdAt: now(), updatedAt: now() },
    })) as Row & { id: string };
    expect(acc).toMatchObject({ accessToken: 'ya29.secret', refreshToken: '1//refresh', idToken: 'eyJ.id' });
    const r = (await raw('account', acc.id))!;
    expect([r.accessToken, r.refreshToken, r.idToken].join()).not.toMatch(/ya29|refresh|eyJ/);
    const joined = await a.findMany<Row & { user: Row }>({ model: 'account', where: [{ field: 'userId', value: u.id }], join: { user: true } });
    expect(joined[0]).toMatchObject({ accessToken: 'ya29.secret' });
    expect(joined[0]!.user.email).toBe(u.email);
  });

  it('SSO providers: config encrypted with the org key, found by domain index', async () => {
    const org = await newOrg();
    const owner = await newUser();
    const p = (await a.create<Row>({
      model: 'ssoProvider',
      data: { issuer: 'https://idp.example', providerId: `p-${uid()}`, organizationId: org.id, userId: owner.id, domain: 'Corp.Example', oidcConfig: '{"clientSecret":"s3cret"}' },
    })) as Row & { id: string };
    const r = (await raw('ssoProvider', p.id))!;
    expect(JSON.stringify(r)).not.toMatch(/s3cret|corp/i);
    expect(r.domainIndex).toBe(await ring.blindIndex('corp.example'));
    const found = await a.findOne<Row>({ model: 'ssoProvider', where: [{ field: 'domain', value: 'corp.example' }] });
    expect(found).toMatchObject({ id: p.id, domain: 'Corp.Example', oidcConfig: '{"clientSecret":"s3cret"}' });
  });
});
