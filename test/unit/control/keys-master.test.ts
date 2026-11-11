// Master key rotation (D37): MASTER_KEY + MASTER_KEY_PREVIOUS, re-wrapping data keys, the route.
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, Env, SessionInfo, SessionUser } from '../../../packages/platform/src/control/env';
import { toBase64 } from '../../../packages/platform/src/control/crypto';
import {
  _clearKeyCaches,
  getKeyRing,
  masterKeyId,
  masterKeyStatus,
  MasterKeyUnavailableError,
  rewrapDataKeys,
} from '../../../packages/platform/src/control/keys';
import type { FieldContext, KeyOwner } from '../../../packages/platform/src/control/keys-api';
import { keysPlatformApp } from '../../../packages/platform/src/control/keys-routes';
import { keysEnv, TEST_MASTER_KEY, uid } from './helpers/keys-env';

const KEY_A = TEST_MASTER_KEY;
const KEY_B = toBase64(new Uint8Array(32).fill(0xb2));
const KEY_C = toBase64(new Uint8Array(32).fill(0xc3));
const envA = keysEnv({ KEY_ROTATION: undefined });
const envB = keysEnv({ KEY_ROTATION: undefined, MASTER_KEY: KEY_B, MASTER_KEY_PREVIOUS: KEY_A });
const envBOnly = keysEnv({ KEY_ROTATION: undefined, MASTER_KEY: KEY_B });
const envC = keysEnv({ KEY_ROTATION: undefined, MASTER_KEY: KEY_C });

const ctxFor = (owner: KeyOwner): FieldContext => ({ table: 'user', column: 'email', rowId: owner.id, owner });
const SECRETS = [KEY_A, KEY_B, KEY_C];

async function rewrapAll(env: Env) {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await rewrapDataKeys(env, { limit: 3 });
    total += r.rewrapped;
    expect(r.failed).toBe(0);
    if (r.exhausted) return total;
  }
  throw new Error('rewrap did not finish');
}

async function masterIdOfRow(owner: KeyOwner) {
  const r = await envA.DB.prepare('SELECT master_id FROM data_keys WHERE owner_type = ? AND owner_id = ?').bind(owner.type, owner.id).first<{ master_id: string | null }>();
  return r?.master_id ?? null;
}

afterEach(() => {
  _clearKeyCaches();
  vi.restoreAllMocks();
});

describe('master key rotation (D37)', () => {
  it('ids master keys by fingerprint, never by the key itself', async () => {
    const a = await masterKeyId(envA);
    const b = await masterKeyId(envB);
    expect(a).toMatch(/^k[0-9a-f]{16}$/);
    expect(b).toMatch(/^k[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    for (const s of SECRETS) expect(a).not.toContain(s);
  });

  it('derives the fingerprint key with HKDF, not from the raw wrapping key', async () => {
    const raw = Uint8Array.from(atob(KEY_A), (ch) => ch.charCodeAt(0));
    const hex = async (key: CryptoKey) =>
      'k' +
      [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('worca-run master key id v1')))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derived = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('worca-run master-id v1') },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    const legacy = await hex(await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
    expect(await masterKeyId(envA)).toBe(await hex(derived));
    expect(await masterKeyId(envA)).not.toBe(legacy);
  });

  it('rows carrying the pre-HKDF fingerprint still unwrap, and a master rotation rewrites them', async () => {
    const raw = Uint8Array.from(atob(KEY_A), (ch) => ch.charCodeAt(0));
    const mac = await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      new TextEncoder().encode('worca-run master key id v1'),
    );
    const legacyId = 'k' + [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const owner: KeyOwner = { type: 'user', id: uid() };
    const ct = await getKeyRing(envA).encrypt(ctxFor(owner), 'legacy fingerprint');
    await envA.DB.prepare('UPDATE data_keys SET master_id = ? WHERE owner_id = ?').bind(legacyId, owner.id).run();
    _clearKeyCaches();
    // Under the same master and during a rotation (it is MASTER_KEY_PREVIOUS there).
    expect(await getKeyRing(envA).decrypt(ctxFor(owner), ct)).toBe('legacy fingerprint');
    _clearKeyCaches();
    expect(await getKeyRing(envB).decrypt(ctxFor(owner), ct)).toBe('legacy fingerprint');
    // An unknown fingerprint is still refused.
    await envA.DB.prepare("UPDATE data_keys SET master_id = 'k0000000000000000' WHERE owner_id = ?").bind(owner.id).run();
    _clearKeyCaches();
    expect(await getKeyRing(envA).decrypt(ctxFor(owner), ct).catch((e: Error) => e)).toBeInstanceOf(MasterKeyUnavailableError);
    // The one-time recompute: rewrapping under the same MASTER_KEY rewrites the fingerprint.
    await envA.DB.prepare('UPDATE data_keys SET master_id = ? WHERE owner_id = ?').bind(legacyId, owner.id).run();
    // Other tests' rows (under other masters) may fail here; only this row matters.
    for (let after: string | null = null, i = 0; i < 1000; i++) {
      const r = await rewrapDataKeys(envA, { limit: 100, after });
      after = r.cursor;
      if (r.exhausted) break;
    }
    expect(await masterIdOfRow(owner)).toBe(await masterKeyId(envA));
    _clearKeyCaches();
    expect(await getKeyRing(envA).decrypt(ctxFor(owner), ct)).toBe('legacy fingerprint');
  });

  it('new keys record the master that wrapped them', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    await getKeyRing(envA).ensureKey(owner);
    expect(await masterIdOfRow(owner)).toBe(await masterKeyId(envA));
  });

  it('rotates: reads through MASTER_KEY_PREVIOUS, re-wraps every live key, then works without it', async () => {
    const owners: KeyOwner[] = [
      { type: 'user', id: uid() },
      { type: 'org', id: uid() },
      { type: 'user', id: uid() },
    ];
    const ringA = getKeyRing(envA);
    const cts: string[] = [];
    for (const o of owners) cts.push(await ringA.encrypt(ctxFor(o), `secret ${o.id}`));
    // A row from before migration 0011 names no master.
    await envA.DB.prepare('UPDATE data_keys SET master_id = NULL WHERE owner_id = ?').bind(owners[2]!.id).run();
    // A destroyed key stays destroyed.
    const gone: KeyOwner = { type: 'user', id: uid() };
    await ringA.ensureKey(gone);
    await ringA.destroyKey(gone);
    const wrappedBefore = await envA.DB.prepare('SELECT id, wrapped FROM data_keys WHERE owner_id = ?').bind(owners[0]!.id).first<{ wrapped: string }>();

    // Mid-rotation: MASTER_KEY is new, the old one is MASTER_KEY_PREVIOUS. Everything reads.
    _clearKeyCaches();
    const ringB = getKeyRing(envB);
    for (const [i, o] of owners.entries()) expect(await ringB.decrypt(ctxFor(o), cts[i]!)).toBe(`secret ${o.id}`);
    const before = await masterKeyStatus(envB);
    expect(before.status).toBe('pending');
    expect(before.previousMasterId).toBe(await masterKeyId(envA));
    // New keys go under the new master straight away.
    const late: KeyOwner = { type: 'user', id: uid() };
    await ringB.ensureKey(late);
    expect(await masterIdOfRow(late)).toBe(await masterKeyId(envB));

    expect(await rewrapAll(envB)).toBeGreaterThanOrEqual(3);
    const after = await masterKeyStatus(envB);
    expect(after).toMatchObject({ status: 'done', masterId: await masterKeyId(envB) });
    expect(after.done).toBe(after.total);
    for (const o of owners) expect(await masterIdOfRow(o)).toBe(await masterKeyId(envB));
    const wrappedAfter = await envA.DB.prepare('SELECT wrapped FROM data_keys WHERE owner_id = ?').bind(owners[0]!.id).first<{ wrapped: string }>();
    expect(wrappedAfter!.wrapped).toMatch(/^m1\./);
    expect(wrappedAfter!.wrapped).not.toBe(wrappedBefore!.wrapped);
    expect(await envA.DB.prepare('SELECT wrapped FROM data_keys WHERE owner_id = ?').bind(gone.id).first()).toEqual({ wrapped: null });

    // MASTER_KEY_PREVIOUS removed: ciphertexts (unchanged) still decrypt.
    _clearKeyCaches();
    const ringBOnly = getKeyRing(envBOnly);
    for (const [i, o] of owners.entries()) expect(await ringBOnly.decrypt(ctxFor(o), cts[i]!)).toBe(`secret ${o.id}`);
    expect((await rewrapDataKeys(envBOnly)).rewrapped).toBe(0);

    // The old master alone can no longer unwrap them, and says which master is missing.
    _clearKeyCaches();
    const err = await getKeyRing(envA)
      .decrypt(ctxFor(owners[0]!), cts[0]!)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(MasterKeyUnavailableError);
    expect((err as Error).message).toContain(await masterKeyId(envB));
  });

  it('fails cleanly when the named master is absent, with no key material in errors or logs', async () => {
    const owner: KeyOwner = { type: 'org', id: uid() };
    const ct = await getKeyRing(envA).encrypt(ctxFor(owner), 'payload');
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

    _clearKeyCaches();
    const err = (await getKeyRing(envC)
      .decrypt(ctxFor(owner), ct)
      .catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(MasterKeyUnavailableError);
    expect(err.message).toMatch(/not configured/);
    expect(err.message).toContain(await masterKeyId(envA));

    // The re-wrap job skips it and counts it rather than throwing.
    const r = await rewrapDataKeys(envC, { limit: 500 });
    expect(r.failed).toBeGreaterThan(0);
    expect((await masterKeyStatus(envC)).status).toBe('pending');

    // Legacy row (no master named) under an unknown master: also a clean error.
    await envA.DB.prepare('UPDATE data_keys SET master_id = NULL WHERE owner_id = ?').bind(owner.id).run();
    _clearKeyCaches();
    const legacy = (await getKeyRing(envC)
      .decrypt(ctxFor(owner), ct)
      .catch((e: Error) => e)) as Error;
    expect(legacy).toBeInstanceOf(MasterKeyUnavailableError);

    // Tampered wrapped key under the right master: generic error.
    await envA.DB.prepare("UPDATE data_keys SET master_id = ?, wrapped = 'm1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' WHERE owner_id = ?")
      .bind(await masterKeyId(envA), owner.id)
      .run();
    _clearKeyCaches();
    const tampered = (await getKeyRing(envA)
      .decrypt(ctxFor(owner), ct)
      .catch((e: Error) => e)) as Error;
    expect(tampered.message).toMatch(/cannot unwrap/);

    const raw = (b64: string) => [...atob(b64)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    for (const text of [err.message, legacy.message, tampered.message, err.stack ?? '', ...logs]) {
      for (const s of SECRETS) {
        expect(text).not.toContain(s);
        expect(text).not.toContain(raw(s));
      }
    }
    // Don't leave an unreadable key behind for the route test.
    await getKeyRing(envA).destroyKey(owner);
  });
});

// ---- routes -------------------------------------------------------------------------------------

const people = new Map<string, { user: SessionUser; session: SessionInfo }>();

function signIn(opts: { mfa: boolean }): string {
  const id = uid();
  people.set(id, {
    user: { id, email: `${id}@example.com`, name: 'x', status: 'active' },
    session: { id: uid(), userId: id, method: opts.mfa ? 'passkey' : 'email-otp', mfa: opts.mfa, ssoOrgId: null, expiresAt: Date.now() + 3600_000, activeOrganizationId: null },
  });
  return id;
}

function app(env: Env) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    const who = people.get(c.req.header('x-test-as') ?? '');
    c.set('user', who?.user ?? null);
    c.set('session', who?.session ?? null);
    c.set('requestId', 'test');
    await next();
  });
  a.route('/api/platform', keysPlatformApp);
  a.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err.message }, status as 400);
  });
  return (method: string, path: string, as?: string, body?: unknown) =>
    a.fetch(
      new Request(`http://app.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(as ? { 'x-test-as': as } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
}

const grant = (userId: string, role: string) =>
  envA.DB.prepare('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, NULL, ?)').bind(userId, role, Date.now()).run();

describe('master rotation routes', () => {
  it('superadmin with MFA only; POST continues the re-wrap until done and is audited', async () => {
    const call = app(envB);
    const root = signIn({ mfa: true });
    await grant(root, 'superadmin');
    const rootNoMfa = signIn({ mfa: false });
    await grant(rootNoMfa, 'superadmin');
    const admin = signIn({ mfa: true });
    await grant(admin, 'admin');

    expect((await call('GET', '/api/platform/keys/master')).status).toBe(401);
    expect((await call('POST', '/api/platform/keys/rotate-master', admin)).status).toBe(403);
    expect(await (await call('POST', '/api/platform/keys/rotate-master', rootNoMfa)).json()).toEqual({ error: 'mfa_required' });

    // Some keys under the old master.
    _clearKeyCaches();
    for (let i = 0; i < 3; i++) await getKeyRing(envA).ensureKey({ type: 'user', id: uid() });
    _clearKeyCaches();

    const st = (await (await call('GET', '/api/platform/keys/master', root)).json()) as { status: string; previousMasterId: string };
    expect(st.status).toBe('pending');
    expect(st.previousMasterId).toBe(await masterKeyId(envA));

    let res: { status: string; rewrapped: number; done: number; total: number } | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await call('POST', '/api/platform/keys/rotate-master', root, { limit: 2 });
      expect(r.status).toBe(200);
      res = (await r.json()) as typeof res;
      if (res!.status === 'done') break;
    }
    expect(res).toMatchObject({ status: 'done' });
    expect(res!.done).toBe(res!.total);
    const audit = await envA.DB.prepare("SELECT actor_id, target_id FROM audit_platform WHERE action = 'platform.master_key_rotated' AND actor_id = ?")
      .bind(root)
      .all();
    expect(audit.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.results)).not.toContain(KEY_B);
  });
});
