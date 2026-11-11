// End-to-end through the Worker: the person's own sessions and passkeys (ui-feasibility.md T14).
// /api/me/sessions lists, revokes one, and revokes the others, with signed handles (D49) and gate
// session drops (D46); a real passkey sign-in sets passkey.lastUsedAt.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeSessionHandle } from '../../../packages/platform/src/control/auth/adapter-wrapper';
import { passkeyUseFrom, recordPasskeyUse } from '../../../packages/platform/src/control/auth/index';
import { deviceLabel } from '../../../packages/platform/src/control/tenancy/me-routes';
import { gateCalls, resetGate, seedInstance } from './helpers/tenancy-fixtures';

const ORIGIN = env.APP_ORIGIN;
let seq = 0;
const freshEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}@example.com`;
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

async function latestCode(email: string): Promise<string> {
  const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
  return /code: (\d{6})/.exec(mails.at(-1)!.subject)![1]!;
}

/** One email-code sign-in: a new session for the same account each time. */
async function signIn(email: string, userAgent = MAC_CHROME) {
  expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const res = await post('/api/auth/sign-in/email-otp', { email, otp: await latestCode(email) }, { 'user-agent': userAgent });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  return { userId: user.id, cookie: cookiesOf(res) };
}

const get = (path: string, cookie: string) => SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
const del = (path: string, cookie: string) => SELF.fetch(`${ORIGIN}${path}`, { method: 'DELETE', headers: { cookie, origin: ORIGIN } });

interface SessionView {
  handle: string;
  current: boolean;
  method: string;
  mfa: boolean;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

async function sessions(cookie: string): Promise<SessionView[]> {
  const res = await get('/api/me/sessions', cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SessionView[] }).sessions;
}

const isSignedIn = async (cookie: string) => (await (await get('/api/auth/get-session', cookie)).json()) !== null;
const idOf = (handle: string) => handle.split('.')[1]!;

/** An org the user belongs to, with one running instance, so revocation has gate sessions to drop. */
async function orgWithInstance(userId: string): Promise<string> {
  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)').bind(orgId, 'org', orgId.slice(0, 12), now).run();
  await env.DB.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), orgId, userId, 'tenant_user', now)
    .run();
  return seedInstance(orgId);
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'open', 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
});

beforeEach(async () => {
  await resetGate();
});

describe('GET /api/me/sessions', () => {
  it('lists the caller’s sessions with handles, method, device and times, never raw data', async () => {
    const email = freshEmail('list');
    const a = await signIn(email, MAC_CHROME);
    const b = await signIn(email, IPHONE_SAFARI);
    const other = await signIn(freshEmail('other'));

    const list = await sessions(a.cookie);
    expect(list).toHaveLength(2);
    expect(list[0]!.current).toBe(true);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.map((s) => s.device).sort()).toEqual(['Chrome on macOS', 'Safari on iOS']);
    for (const s of list) {
      expect(s.handle).toMatch(/^r1\.[^.]+\.\d+\.[0-9a-f]{64}$/);
      expect(s.method).toBe('email-otp');
      expect(s.mfa).toBe(false);
      expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.now());
      expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(s.lastActiveAt))).toBe(false);
      expect(Object.keys(s).sort()).toEqual(['createdAt', 'current', 'device', 'expiresAt', 'handle', 'lastActiveAt', 'method', 'mfa']);
    }
    // No other account's sessions; the raw user agent and stored token hash never appear.
    const otherIds = (await sessions(other.cookie)).map((s) => idOf(s.handle));
    expect(list.some((s) => otherIds.includes(idOf(s.handle)))).toBe(false);
    const raw = JSON.stringify(list);
    expect(raw).not.toContain('Macintosh');
    expect(raw).not.toContain('h1.');
    expect(b.userId).toBe(a.userId);
  });

  it('needs a session', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/me/sessions`)).status).toBe(401);
  });
});

describe('DELETE /api/me/sessions/:handle', () => {
  it('revokes one of your own sessions, drops its gate sessions and audits', async () => {
    const email = freshEmail('revoke');
    const a = await signIn(email);
    const b = await signIn(email, IPHONE_SAFARI);
    const instanceId = await orgWithInstance(a.userId);
    const target = (await sessions(a.cookie)).find((s) => !s.current)!;

    const res = await del(`/api/me/sessions/${target.handle}`, a.cookie);
    expect(res.status).toBe(200);
    expect(await isSignedIn(b.cookie)).toBe(false);
    expect(await isSignedIn(a.cookie)).toBe(true);
    expect(await gateCalls()).toContainEqual(['dropSessions', instanceId, { cpSessionId: idOf(target.handle) }]);
    const audit = await env.DB.prepare(`SELECT details FROM audit_platform WHERE action = 'auth.session_revoked' AND actor_id = ?`)
      .bind(a.userId)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toEqual({ sessionId: idOf(target.handle) });

    // Gone: a second revocation finds nothing.
    expect((await del(`/api/me/sessions/${target.handle}`, a.cookie)).status).toBe(404);
  });

  it('refuses another user’s session handle, a forged one, an expired one and the current one', async () => {
    const a = await signIn(freshEmail('attacker'));
    const victim = await signIn(freshEmail('victim'));
    const victimHandle = (await sessions(victim.cookie))[0]!.handle;
    await resetGate();

    // A valid handle, but for someone else's session.
    expect((await del(`/api/me/sessions/${victimHandle}`, a.cookie)).status).toBe(404);

    // Forged: the victim's session id with a made-up or altered MAC.
    const [, id, exp, mac] = victimHandle.split('.');
    const flipped = mac!.slice(0, -1) + (mac!.endsWith('0') ? '1' : '0');
    for (const forged of [`r1.${id}.${exp}.${'0'.repeat(64)}`, `r1.${id}.${exp}.${flipped}`, `r1.${id}.${Number(exp) + 3600}.${mac}`]) {
      expect((await del(`/api/me/sessions/${forged}`, a.cookie)).status).toBe(404);
      expect((await del(`/api/me/sessions/${forged}`, victim.cookie)).status).toBe(404);
    }

    // The stored token hash, or anything else that isn't a handle.
    const stored = await env.DB.prepare('SELECT token FROM session WHERE id = ?').bind(id).first<{ token: string }>();
    for (const junk of [stored!.token, id!, 'r1.x.1.y']) {
      expect((await del(`/api/me/sessions/${encodeURIComponent(junk)}`, a.cookie)).status).toBe(404);
    }

    // A correctly signed handle that has expired.
    const expired = await makeSessionHandle(env.BETTER_AUTH_SECRET, id!, stored!.token, Date.now() - 16 * 60_000);
    expect((await del(`/api/me/sessions/${expired}`, victim.cookie)).status).toBe(404);

    // Your own current session: sign out instead.
    expect((await del(`/api/me/sessions/${victimHandle}`, victim.cookie)).status).toBe(409);

    expect(await isSignedIn(victim.cookie)).toBe(true);
    expect((await gateCalls()).filter((c) => c[0] === 'dropSessions')).toEqual([]);
  });

  it('refuses a cross-site request', async () => {
    const a = await signIn(freshEmail('xsite'));
    const handle = (await sessions(a.cookie))[0]!.handle;
    const res = await SELF.fetch(`${ORIGIN}/api/me/sessions/${handle}`, { method: 'DELETE', headers: { cookie: a.cookie, origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/me/sessions/revoke-others', () => {
  it('revokes every other session of the caller only, with gate drops for each', async () => {
    const email = freshEmail('others');
    const a = await signIn(email);
    const b = await signIn(email);
    const c = await signIn(email);
    const bystander = await signIn(freshEmail('bystander'));
    const instanceId = await orgWithInstance(a.userId);
    const otherIds = (await sessions(a.cookie)).filter((s) => !s.current).map((s) => idOf(s.handle));
    expect(otherIds).toHaveLength(2);

    const res = await post('/api/me/sessions/revoke-others', {}, { cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });
    expect(await isSignedIn(a.cookie)).toBe(true);
    expect(await isSignedIn(b.cookie)).toBe(false);
    expect(await isSignedIn(c.cookie)).toBe(false);
    expect(await isSignedIn(bystander.cookie)).toBe(true);
    const drops = (await gateCalls()).filter((x) => x[0] === 'dropSessions');
    expect(drops).toHaveLength(2);
    for (const id of otherIds) expect(drops).toContainEqual(['dropSessions', instanceId, { cpSessionId: id }]);
    expect((await sessions(a.cookie)).map((s) => s.current)).toEqual([true]);
    const audit = await env.DB.prepare(`SELECT details FROM audit_platform WHERE action = 'auth.other_sessions_revoked' AND actor_id = ?`)
      .bind(a.userId)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toEqual({ count: 2 });
  });
});

// ---- Passkeys -----------------------------------------------------------------------------------

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** DER encoding of a raw (r || s) P-256 signature, as WebAuthn authenticators return it. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.slice(i);
    return v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  const body = concat(new Uint8Array([0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** A virtual ES256 passkey stored straight in the passkey table (registration isn't under test). */
async function addPasskey(userId: string, name: string) {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = concat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x!), new Uint8Array([0x22, 0x58, 0x20]), fromB64url(jwk.y!));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt)
     VALUES (?, ?, ?, ?, ?, 0, 'multiDevice', 1, 'internal', ?)`,
  )
    .bind(id, name, b64(cose), userId, b64url(credId), new Date().toISOString())
    .run();
  return { id, credId, privateKey: keys.privateKey, signCount: 0 };
}

async function passkeySignIn(pk: Awaited<ReturnType<typeof addPasskey>>) {
  const optRes = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: { origin: ORIGIN } });
  expect(optRes.status).toBe(200);
  const options = (await optRes.json()) as { challenge: string; rpId?: string };
  const rpId = options.rpId ?? new URL(ORIGIN).hostname;
  pk.signCount += 1;
  const authData = concat(await sha256(new TextEncoder().encode(rpId)), new Uint8Array([0x05, 0, 0, 0, pk.signCount]));
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pk.privateKey, concat(authData, await sha256(clientDataJSON))),
  );
  const response = {
    id: b64url(pk.credId),
    rawId: b64url(pk.credId),
    type: 'public-key',
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)) },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
  return post('/api/auth/passkey/verify-authentication', { response }, { cookie: cookiesOf(optRes) });
}

interface PasskeyView {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

describe('passkeys: lastUsedAt and GET /api/me/passkeys', () => {
  it('a passkey sign-in sets lastUsedAt on that passkey only; the list never shows key material', async () => {
    const email = freshEmail('pk');
    const { userId, cookie } = await signIn(email);
    const used = await addPasskey(userId, 'Laptop');
    const unused = await addPasskey(userId, 'Phone');

    const before = ((await (await get('/api/me/passkeys', cookie)).json()) as { passkeys: PasskeyView[] }).passkeys;
    expect(before.map((p) => p.lastUsedAt)).toEqual([null, null]);

    const t0 = Date.now();
    const res = await passkeySignIn(used);
    expect(res.status).toBe(200);
    const pkCookie = cookiesOf(res);
    const me = (await (await get('/api/me', pkCookie)).json()) as { session: { method: string; mfa: boolean }; signIn: { passkeys: number } };
    expect(me.session).toMatchObject({ method: 'passkey', mfa: true });
    expect(me.signIn.passkeys).toBe(2);

    const list = ((await (await get('/api/me/passkeys', pkCookie)).json()) as { passkeys: PasskeyView[] }).passkeys;
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(Date.parse(byId.get(used.id)!.lastUsedAt!)).toBeGreaterThanOrEqual(t0 - 1000);
    expect(byId.get(unused.id)!.lastUsedAt).toBeNull();
    expect(byId.get(used.id)).toMatchObject({ name: 'Laptop', deviceType: 'multiDevice', backedUp: true });
    for (const p of list) expect(Object.keys(p).sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'lastUsedAt', 'name']);

    // The sessions list shows the passkey session as MFA.
    const current = (await sessions(pkCookie)).find((s) => s.current)!;
    expect(current).toMatchObject({ method: 'passkey', mfa: true });

    // Someone else sees none of these.
    const other = await signIn(freshEmail('pk-other'));
    expect(((await (await get('/api/me/passkeys', other.cookie)).json()) as { passkeys: PasskeyView[] }).passkeys).toEqual([]);
  });

  it('a failed passkey sign-in sets nothing', async () => {
    const { userId } = await signIn(freshEmail('pk-fail'));
    const pk = await addPasskey(userId, 'Key');
    const wrong = await addPasskey(userId, 'Other');
    pk.privateKey = wrong.privateKey; // signs with the wrong key
    expect((await passkeySignIn(pk)).status).not.toBe(200);
    const row = await env.DB.prepare('SELECT lastUsedAt FROM passkey WHERE id = ?').bind(pk.id).first<{ lastUsedAt: string | null }>();
    expect(row?.lastUsedAt).toBeNull();
  });
});

describe('passkey hook logic', () => {
  const ok = { session: {}, user: { id: 'u1' } };
  it('passkeyUseFrom picks the credential and user of a successful verify-authentication only', () => {
    const body = { response: { id: 'cred-1' } };
    expect(passkeyUseFrom({ path: '/passkey/verify-authentication', body, context: { returned: ok, newSession: { user: { id: 'u1' } } } })).toEqual({
      credentialId: 'cred-1',
      userId: 'u1',
    });
    expect(passkeyUseFrom({ path: '/passkey/verify-authentication', body, context: { returned: ok } })).toEqual({ credentialId: 'cred-1', userId: 'u1' });
    expect(passkeyUseFrom({ path: '/passkey/verify-authentication', body, context: { returned: new Error('x') } })).toBeNull();
    expect(passkeyUseFrom({ path: '/passkey/verify-authentication', body, context: { returned: undefined } })).toBeNull();
    expect(passkeyUseFrom({ path: '/passkey/verify-authentication', body: {}, context: { returned: ok } })).toBeNull();
    expect(passkeyUseFrom({ path: '/passkey/verify-registration', body, context: { returned: ok } })).toBeNull();
    expect(passkeyUseFrom(null)).toBeNull();
  });

  it('recordPasskeyUse touches only the row of that credential and owner', async () => {
    const { userId } = await signIn(freshEmail('pk-unit'));
    const mine = await addPasskey(userId, 'mine');
    const at = new Date('2026-10-01T10:00:00.000Z');
    await recordPasskeyUse(env, { credentialId: b64url(mine.credId), userId: 'someone-else' }, at);
    const read = () => env.DB.prepare('SELECT lastUsedAt FROM passkey WHERE id = ?').bind(mine.id).first<{ lastUsedAt: string | null }>();
    expect((await read())?.lastUsedAt).toBeNull();
    await recordPasskeyUse(env, { credentialId: b64url(mine.credId), userId }, at);
    expect((await read())?.lastUsedAt).toBe(at.toISOString());
  });
});

describe('deviceLabel', () => {
  it('gives a coarse browser and OS', () => {
    expect(deviceLabel(MAC_CHROME)).toBe('Chrome on macOS');
    expect(deviceLabel(IPHONE_SAFARI)).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15')).toBe('Safari on macOS');
    expect(deviceLabel('curl/8.7.1')).toBe('Unknown device');
    expect(deviceLabel(null)).toBe('Unknown device');
  });
});
