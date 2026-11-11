import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext, Env, SessionInfo, SessionUser } from '../../../packages/platform/src/control/env';
import type { FieldContext, KeyRing } from '../../../packages/platform/src/control/keys-api';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { consumeGateCode, createGateCode, pruneGateCodes } from '../../../packages/platform/src/control/identity/codes';
import { setIdentityDeps, type AccessResult, type InstanceRef } from '../../../packages/platform/src/control/identity/deps';
import { exchangeCode, renewToken } from '../../../packages/platform/src/control/identity/rpc-handlers';
import { identityApp, isSafeReturnPath } from '../../../packages/platform/src/control/identity/routes';
import { getJwks, signIdentityToken } from '../../../packages/platform/src/control/identity/tokens';

const HOST = 'k7m2qz9xwp.run.localhost';
const OTHER_HOST = 'aaaaaaaaaa.run.localhost';
const STATE = 'st_abcdefghijklmnop123';

let testEnv: Env;
let access: AccessResult;
const instances = new Map<string, InstanceRef>();
const accessCalls: { userId: string; sessionMethod: string; instanceId: string }[] = [];
const decryptCalls: FieldContext[] = [];

const fakeRing = {
  isCiphertext: (v: unknown) => typeof v === 'string' && v.startsWith('enc:'),
  decrypt: async (ctx: FieldContext, v: string) => {
    decryptCalls.push(ctx);
    return v.slice(4);
  },
} as unknown as KeyRing;

// --- seeding: tolerant of whatever columns 0001_auth.sql adds to Better Auth's tables ---

async function ensureAuthTables() {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, status TEXT,
       createdAt TEXT, updatedAt TEXT)`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, userId TEXT, token TEXT, expiresAt TEXT, method TEXT,
       mfa INTEGER, createdAt TEXT, updatedAt TEXT)`,
    ),
  ]);
}

async function insertRow(table: string, values: Record<string, unknown>) {
  const cols = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; notnull: number; dflt_value: unknown; pk: number; type: string }>();
  const row: Record<string, unknown> = { ...values };
  for (const c of cols.results) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : `x-${crypto.randomUUID()}`;
  }
  const names = Object.keys(row);
  await env.DB.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .bind(...names.map((n) => row[n] as string | number | null))
    .run();
}

async function seedUser(status = 'active') {
  const id = crypto.randomUUID();
  await insertRow('user', { id, email: 'enc:ana@example.com', name: 'enc:Ana', status, emailVerified: 1 });
  return id;
}

async function seedSession(userId: string, opts: { expiresAt?: number; method?: string } = {}) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(opts.expiresAt ?? Date.now() + 3600_000).toISOString();
  await insertRow('session', { id, userId, token: await sha256Hex(id), expiresAt, method: opts.method ?? 'email-otp' });
  return id;
}

// --- routes, with the session middleware replaced by fixed variables ---

function appWith(user: SessionUser | null, session: SessionInfo | null) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', session);
    c.set('requestId', 'test');
    await next();
  });
  app.route('/', identityApp);
  return app;
}

function signedIn(userId: string, sessionId: string, method: SessionInfo['method'] = 'email-otp') {
  const user: SessionUser = { id: userId, email: 'ana@example.com', name: 'Ana', status: 'active' };
  const session: SessionInfo = { id: sessionId, userId, method, mfa: false, expiresAt: Date.now() + 3600_000, activeOrganizationId: null, ssoOrgId: null };
  return appWith(user, session);
}

const authorizeUrl = (q: Record<string, string>) => `http://app.localhost/authorize?${new URLSearchParams(q)}`;

async function authorize(app: Hono<AppContext>, q: Record<string, string> = { host: HOST, state: STATE, return: '/board?x=1' }) {
  return app.request(authorizeUrl(q), {}, testEnv);
}

async function codeFor(userId: string, sessionId: string, host = HOST) {
  const res = await authorize(signedIn(userId, sessionId), { host, state: STATE, return: '/' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('code')!;
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'test-1', alg: 'ES256' };
  testEnv = { ...(env as unknown as Env), IDENTITY_SIGNING_JWK: JSON.stringify(jwk) };
  await ensureAuthTables();
});

beforeEach(() => {
  instances.clear();
  instances.set(HOST, { id: 'inst-1', orgId: 'org-1', kind: 'worca', status: 'running' });
  access = { ok: true, orgId: 'org-1', teamIds: ['team-1'] };
  accessCalls.length = 0;
  decryptCalls.length = 0;
  setIdentityDeps({
    findInstanceByHost: async (_e, host) => instances.get(host) ?? null,
    checkInstanceAccess: async (_e, input) => {
      accessCalls.push(input);
      return access;
    },
    getKeyRing: () => fakeRing,
  });
});

afterAll(() => setIdentityDeps());

describe('tokens and JWKS', () => {
  it('publishes only public key parts with kid, alg and use', async () => {
    const res = await identityApp.request('/.well-known/jwks.json', {}, testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'test-1', alg: 'ES256', use: 'sig' });
  });

  it('signs tokens that verify against the JWKS with issuer and audience', async () => {
    const { token, exp } = await signIdentityToken(testEnv, { aud: HOST, sub: 'u1', email: 'a@b.c', name: 'A', org: 'o1', inst: 'i1', teams: ['t1'] });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'test-1' });
    const { payload } = await jwtVerify(token, createLocalJWKSet(getJwks(testEnv)), { issuer: testEnv.APP_ORIGIN, audience: HOST });
    expect(payload).toMatchObject({ sub: 'u1', email: 'a@b.c', org: 'o1', inst: 'i1', teams: ['t1'], exp });
    expect(payload.exp! - payload.iat!).toBe(300);
    await expect(jwtVerify(token, createLocalJWKSet(getJwks(testEnv)), { audience: OTHER_HOST })).rejects.toThrow();
  });

  it('publishes every key of a list and signs with the first', async () => {
    const mk = async (kid: string) => ({ ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid });
    const rotEnv = { ...testEnv, IDENTITY_SIGNING_JWK: JSON.stringify({ keys: [await mk('new'), await mk('old')] }) };
    expect(getJwks(rotEnv).keys.map((k) => k.kid)).toEqual(['new', 'old']);
    const { token } = await signIdentityToken(rotEnv, { aud: HOST, sub: 'u', email: '', name: '', org: 'o', inst: 'i', teams: [] });
    expect(decodeProtectedHeader(token).kid).toBe('new');
    expect(JSON.stringify(getJwks(rotEnv))).not.toContain('"d"');
  });
});

describe('GET /authorize', () => {
  it('sends a signed-out browser to sign-in with a same-origin next', async () => {
    const res = await authorize(appWith(null, null));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'http://app.localhost');
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('next')).toBe(`/authorize?${new URLSearchParams({ host: HOST, state: STATE, return: '/board?x=1' })}`);
  });

  it('redirects to the gate callback with a one-time code stored only as a hash', async () => {
    const userId = await seedUser();
    const sessionId = await seedSession(userId);
    const res = await authorize(signedIn(userId, sessionId));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(`${testEnv.INSTANCE_SCHEME}://${HOST}${testEnv.INSTANCE_ORIGIN_SUFFIX}/.gate/callback`);
    expect(loc.searchParams.get('state')).toBe(STATE);
    expect(loc.searchParams.get('return')).toBe('/board?x=1');
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT * FROM gate_codes WHERE code_hash = ?').bind(await sha256Hex(code)).first<Record<string, unknown>>();
    expect(row).toMatchObject({ host: HOST, user_id: userId, session_id: sessionId, instance_id: 'inst-1', used_at: null });
    expect((row!.expires_at as number) - (row!.created_at as number)).toBe(60_000);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(accessCalls[0]).toEqual({ userId, sessionMethod: 'email-otp', instanceId: 'inst-1', ssoOrgId: null });
  });

  it('answers 404 for an unknown host', async () => {
    const res = await authorize(signedIn('u', 's'), { host: OTHER_HOST, state: STATE, return: '/' });
    expect(res.status).toBe(404);
  });

  it('answers 403 explaining a missing team', async () => {
    access = { ok: false, reason: 'no_team' };
    const res = await authorize(signedIn('u', 's'));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('None of your teams');
  });

  it('asks to sign in again with the method the instance requires', async () => {
    access = { ok: false, reason: 'policy_method', requiredMethods: ['sso'] };
    const res = await authorize(signedIn('u', 's'));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'http://app.localhost');
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('methods')).toBe('sso');
    expect(loc.searchParams.get('next')).toMatch(/^\/authorize\?/);
  });

  it.each(['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'evil', '/a\nb', ''])('refuses return=%j', async (ret) => {
    const res = await authorize(signedIn('u', 's'), { host: HOST, state: STATE, return: ret });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it.each([
    { host: 'evil.example', state: STATE },
    { host: `${HOST}.evil.example`, state: STATE },
    { host: HOST, state: 'short' },
    { host: HOST, state: 'has spaces and <tags> in it' },
  ])('refuses bad host or state %j', async (q) => {
    const res = await authorize(signedIn('u', 's'), { ...q, return: '/' });
    expect(res.status).toBe(400);
  });

  it('accepts only same-origin paths as return', () => {
    expect(isSafeReturnPath('/')).toBe(true);
    expect(isSafeReturnPath('/a/b?c=//d')).toBe(true);
    expect(isSafeReturnPath('//x')).toBe(false);
    expect(isSafeReturnPath('/\\x')).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('exchanges once for a verifiable token with decrypted claims', async () => {
    const userId = await seedUser();
    const sessionId = await seedSession(userId);
    const code = await codeFor(userId, sessionId);
    const ex = await exchangeCode(testEnv, code, HOST);
    expect(ex).toMatchObject({ userId, cpSessionId: sessionId, instanceId: 'inst-1' });
    const { payload } = await jwtVerify(ex!.token, createLocalJWKSet(getJwks(testEnv)), { issuer: testEnv.APP_ORIGIN, audience: HOST });
    expect(payload).toMatchObject({ sub: userId, email: 'ana@example.com', name: 'Ana', org: 'org-1', inst: 'inst-1', teams: ['team-1'] });
    expect(payload.exp).toBe(ex!.tokenExp);
    expect(decryptCalls).toContainEqual({ table: 'user', column: 'email', rowId: userId, owner: { type: 'user', id: userId } });
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
  });

  it('lets only one of two concurrent exchanges win', async () => {
    const userId = await seedUser();
    const code = await codeFor(userId, await seedSession(userId));
    const results = await Promise.all([exchangeCode(testEnv, code, HOST), exchangeCode(testEnv, code, HOST)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a code for another host, and burns it', async () => {
    const userId = await seedUser();
    instances.set(OTHER_HOST, { id: 'inst-2', orgId: 'org-1', kind: 'worca', status: 'running' });
    const code = await codeFor(userId, await seedSession(userId));
    expect(await exchangeCode(testEnv, code, OTHER_HOST)).toBeNull();
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
  });

  it('refuses an expired code', async () => {
    const userId = await seedUser();
    const sessionId = await seedSession(userId);
    const code = await createGateCode(testEnv, { host: HOST, userId, sessionId, instanceId: 'inst-1' }, Date.now() - 61_000);
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
    expect(await consumeGateCode(testEnv, 'unknown-code-unknown-code', HOST)).toBeNull();
  });

  it('refuses when the session expired after the code was issued', async () => {
    const userId = await seedUser();
    const sessionId = await seedSession(userId);
    const code = await codeFor(userId, sessionId);
    await env.DB.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), sessionId).run();
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
  });

  it('refuses when access was removed after the code was issued', async () => {
    const userId = await seedUser();
    const code = await codeFor(userId, await seedSession(userId));
    access = { ok: false, reason: 'no_team' };
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
  });

  it('refuses when the host now points at another instance', async () => {
    const userId = await seedUser();
    const code = await codeFor(userId, await seedSession(userId));
    instances.set(HOST, { id: 'inst-other', orgId: 'org-1', kind: 'worca', status: 'running' });
    expect(await exchangeCode(testEnv, code, HOST)).toBeNull();
  });
});

describe('renewToken', () => {
  it('renews while session and access hold, passing the session method to the policy check', async () => {
    const userId = await seedUser();
    const cpSessionId = await seedSession(userId, { method: 'sso' });
    const r = await renewToken(testEnv, { cpSessionId, userId, host: HOST });
    expect(r).not.toBeNull();
    await jwtVerify(r!.token, createLocalJWKSet(getJwks(testEnv)), { issuer: testEnv.APP_ORIGIN, audience: HOST });
    expect(accessCalls.at(-1)).toEqual({ userId, sessionMethod: 'sso', instanceId: 'inst-1', ssoOrgId: null });
  });

  it('refuses after team removal or a narrowed policy', async () => {
    const userId = await seedUser();
    const cpSessionId = await seedSession(userId);
    access = { ok: false, reason: 'no_team' };
    expect(await renewToken(testEnv, { cpSessionId, userId, host: HOST })).toBeNull();
    access = { ok: false, reason: 'policy_method', requiredMethods: ['passkey'] };
    expect(await renewToken(testEnv, { cpSessionId, userId, host: HOST })).toBeNull();
  });

  it('refuses after the session is deleted', async () => {
    const userId = await seedUser();
    const cpSessionId = await seedSession(userId);
    await env.DB.prepare('DELETE FROM "session" WHERE id = ?').bind(cpSessionId).run();
    expect(await renewToken(testEnv, { cpSessionId, userId, host: HOST })).toBeNull();
  });

  it("refuses another user's session, a disabled user and an unknown host", async () => {
    const userId = await seedUser();
    const cpSessionId = await seedSession(userId);
    expect(await renewToken(testEnv, { cpSessionId, userId: 'someone-else', host: HOST })).toBeNull();
    expect(await renewToken(testEnv, { cpSessionId, userId, host: OTHER_HOST })).toBeNull();
    const disabled = await seedUser('disabled');
    expect(await renewToken(testEnv, { cpSessionId: await seedSession(disabled), userId: disabled, host: HOST })).toBeNull();
  });
});

describe('pruneGateCodes', () => {
  it('deletes codes expired more than a day ago', async () => {
    const old = await createGateCode(testEnv, { host: HOST, userId: 'u', sessionId: 's', instanceId: 'i' }, Date.now() - 2 * 86_400_000);
    const fresh = await createGateCode(testEnv, { host: HOST, userId: 'u', sessionId: 's', instanceId: 'i' });
    expect(await pruneGateCodes(testEnv)).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare('SELECT code_hash FROM gate_codes').all<{ code_hash: string }>();
    const hashes = left.results.map((r) => r.code_hash);
    expect(hashes).toContain(await sha256Hex(fresh));
    expect(hashes).not.toContain(await sha256Hex(old));
  });
});
