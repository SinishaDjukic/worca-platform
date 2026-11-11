// Access requests for hosted worca (D69): the website's form under /api/public, the emailed
// confirmation, the superadmins' notice and hourly digest, grant (an email-bound registration
// code) and decline in the console, the join hook, CORS and the Origin check, and retention.
// Runs with the real key ring (.dev.vars keys): the sign-up through the Worker computes the
// address's blind index with it, and the granted code's index has to match.
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, Env } from '../../../packages/platform/src/control/env';
import { globalMiddleware } from '../../../packages/platform/src/control/auth/middleware';
import { SIGN_IN_JS } from '../../../packages/platform/src/control/auth/pages';
import { claimCode, findValidCode } from '../../../packages/platform/src/control/auth/registration';
import { CRON_DAILY, CRON_STALE, runCrons, setProviderRefresher, setReleaseChecker } from '../../../packages/platform/src/control/instances/crons';
import { getKeyRing } from '../../../packages/platform/src/control/keys';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { publicApp } from '../../../packages/platform/src/control/public';
import { accessRequestPageApp, logSafe, notifyStaff, RETENTION_MS, UNCONFIRMED_GRACE_MS } from '../../../packages/platform/src/control/public/access-requests';
import type { EmailMessage } from '../../../packages/platform/src/control/tenancy/deps';
import { setTenancyDeps } from '../../../packages/platform/src/control/tenancy/deps';
import { ensureTables, harness, insertRow, installFakes, type TestUser } from './helpers/tenancy-fixtures';

const testEnv = env as unknown as Env;
const ring = () => getKeyRing(testEnv);
const ORIGIN = testEnv.APP_ORIGIN;
const FORM_ORIGIN = 'http://localhost:8080'; // PUBLIC_FORM_ORIGINS in wrangler.control.jsonc (dev)
const HOUR = 3_600_000;

let mail: EmailMessage[];
const call = harness();

// The public routes and the page, as index.ts mounts them (no session involved).
const site = new Hono<AppContext>();
site.route('/api/public', publicApp);
site.route('/', accessRequestPageApp);
const request = (body: unknown, raw?: string) =>
  site.request('/api/public/access-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }, testEnv);
const confirm = (token: string) =>
  site.request('/api/public/access-requests/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }, testEnv);

let seq = 0;
const freshEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}@example.com`;

/** A user whose fields are encrypted with the real key ring, so staff mail can be addressed. */
async function seedUser(email = freshEmail('user')): Promise<TestUser> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const owner = { type: 'user' as const, id };
  await insertRow('user', {
    id,
    email: await ring().encrypt({ table: 'user', column: 'email', rowId: id, owner }, email),
    emailIndex: await ring().emailIndex(email),
    name: await ring().encrypt({ table: 'user', column: 'name', rowId: id, owner }, 'Someone'),
    emailVerified: 1,
    status: 'active',
    registeredVia: 'code',
    createdAt: now,
    updatedAt: now,
  });
  return { id, email, name: 'Someone', status: 'active' };
}
async function staffUser(role: 'superadmin' | 'admin' | 'support'): Promise<TestUser> {
  const u = await seedUser(freshEmail(role));
  await testEnv.DB.prepare('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, NULL, ?)').bind(u.id, role, Date.now()).run();
  return u;
}
const as = (u: TestUser, mfa = true) => ({ as: u, mfa });

/** The token from the newest confirmation mail to `to`. */
function tokenFor(to: string): string {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject === 'Confirm your request for hosted Worca');
  const t = /#t=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
  if (!t) throw new Error(`no confirmation mail to ${to}`);
  return t;
}
const rowFor = async (email: string) =>
  testEnv.DB.prepare('SELECT * FROM access_requests WHERE email_index = ? ORDER BY created_at DESC').bind(await ring().emailIndex(email)).first<Record<string, unknown>>();

/** A confirmed (pending) request; returns its id. */
async function pendingRequest(email = freshEmail('req'), extra: Record<string, unknown> = {}): Promise<string> {
  expect((await request({ email, useCase: 'Running pipelines for my team', company: 'Acme', source: 'hosted', ...extra })).status).toBe(202);
  expect((await confirm(tokenFor(email))).status).toBe(200);
  return String((await rowFor(email))?.id);
}

beforeAll(ensureTables);
beforeEach(async () => {
  installFakes();
  mail = [];
  setTenancyDeps({ keyRing: (e) => getKeyRing(e), sendEmail: async (_e, msg) => void mail.push(msg) });
  setProviderRefresher(async () => undefined);
  setReleaseChecker(async () => undefined);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM access_requests'),
    testEnv.DB.prepare('DELETE FROM platform_roles'),
    testEnv.DB.prepare("DELETE FROM platform_settings WHERE key = 'access_requests_noticed_at'"),
  ]);
});

describe('POST /api/public/access-requests', () => {
  it('refuses bad input with 400 invalid_input', async () => {
    const bad = [
      {},
      { email: 'not-an-email', useCase: 'x' },
      { email: 'a@example.com' },
      { email: 'a@example.com', useCase: '   ' },
      { email: 'a@example.com', useCase: 'x'.repeat(2001) },
      { email: 'a@example.com', useCase: 'x', company: 'c'.repeat(201) },
      { email: 'a@example.com', useCase: 'x', source: 's'.repeat(101) },
    ];
    for (const body of bad) {
      const res = await request(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_input' });
    }
    expect((await request(null, '{not json')).status).toBe(400);
    expect(mail).toEqual([]);
  });

  it('a new request is stored encrypted, unconfirmed, and mails a link with the token in the fragment', async () => {
    const email = freshEmail('new');
    const res = await request({ email, useCase: '  Our team wants hosted pipelines  ', company: 'Acme', source: 'hosted' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: email, subject: 'Confirm your request for hosted Worca', kind: 'access_request' });
    expect(mail[0]!.text).toContain(`${ORIGIN}/access-request#t=`);
    const token = tokenFor(email);
    const row = await rowFor(email);
    expect(row).toMatchObject({ status: 'unconfirmed', source: 'hosted', confirm_token_hash: await sha256Hex(token) });
    // Nothing readable at rest: address, use case and company are ciphertexts.
    for (const col of ['email', 'use_case', 'company']) expect(String(row?.[col])).not.toMatch(/Acme|example\.com|pipelines/);
    expect(Number(row?.confirm_expires_at) - Number(row?.created_at)).toBe(7 * 86_400_000);
  });

  it('answers the same for a duplicate and for an address with an account, without new mail', async () => {
    const email = freshEmail('dup');
    await request({ email, useCase: 'first' });
    const again = await request({ email, useCase: 'second' });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ ok: true });
    expect(mail).toHaveLength(1); // the link went out less than an hour ago
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM access_requests WHERE email_index = ?').bind(await ring().emailIndex(email)).first<{ n: number }>())?.n).toBe(1);

    const member = await seedUser(freshEmail('member'));
    const res = await request({ email: member.email.toUpperCase(), useCase: 'hello' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mail).toHaveLength(1);
    expect(await rowFor(member.email)).toBeNull();
  });

  it('resends the link for an unconfirmed request after an hour, and nothing once pending', async () => {
    const email = freshEmail('resend');
    await request({ email, useCase: 'x' });
    const first = tokenFor(email);
    await testEnv.DB.prepare('UPDATE access_requests SET confirm_sent_at = confirm_sent_at - ? WHERE email_index = ?').bind(HOUR + 1000, await ring().emailIndex(email)).run();
    expect((await request({ email, useCase: 'x' })).status).toBe(202);
    expect(mail).toHaveLength(2);
    const second = tokenFor(email);
    expect(second).not.toBe(first);
    expect((await confirm(first)).status).toBe(410); // replaced
    expect((await confirm(second)).status).toBe(200);
    const before = mail.length;
    await testEnv.DB.prepare('UPDATE access_requests SET confirm_sent_at = 0 WHERE email_index = ?').bind(await ring().emailIndex(email)).run();
    expect((await request({ email, useCase: 'x' })).status).toBe(202);
    expect(mail.filter((m) => m.to === email)).toHaveLength(2);
    expect(mail.length).toBe(before);
  });
});

describe('confirmation', () => {
  it('the page does nothing on GET and carries no token; the POST confirms once', async () => {
    const email = freshEmail('conf');
    await request({ email, useCase: 'x' });
    const token = tokenFor(email);
    const page = await site.request('/access-request', {}, testEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Confirm my request');
    expect(html).toContain('<script src="/access-request.js"');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect((await site.request('/access-request.js', {}, testEnv)).headers.get('content-type')).toContain('javascript');
    expect((await rowFor(email))?.status).toBe('unconfirmed');

    expect((await confirm('wrong-token')).status).toBe(410);
    const ok = await confirm(token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, status: 'confirmed' });
    const row = await rowFor(email);
    expect(row?.status).toBe('pending');
    expect(row?.confirmed_at).toBeTypeOf('number');
    expect(await (await confirm(token)).json()).toEqual({ ok: true, status: 'already_confirmed' });
  });

  it('an expired link is refused', async () => {
    const email = freshEmail('expired');
    await request({ email, useCase: 'x' });
    await testEnv.DB.prepare('UPDATE access_requests SET confirm_expires_at = ? WHERE email_index = ?').bind(Date.now() - 1, await ring().emailIndex(email)).run();
    const res = await confirm(tokenFor(email));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect((await rowFor(email))?.status).toBe('unconfirmed');
  });
});

describe('staff notice', () => {
  it('tells every superadmin at once, then at most one digest an hour, from the 5-minute cron', async () => {
    const sa1 = await staffUser('superadmin');
    const sa2 = await staffUser('superadmin');
    const admin = await staffUser('admin');
    const staffMail = () => mail.filter((m) => m.kind === 'staff_digest');

    await pendingRequest();
    expect(staffMail().map((m) => m.to).sort()).toEqual([sa1.email, sa2.email].sort());
    expect(staffMail().some((m) => m.to === admin.email)).toBe(false);
    expect(staffMail()[0]).toMatchObject({ subject: 'A new access request for hosted Worca' });
    expect(staffMail()[0]!.text).toContain(`${ORIGIN}/platform/access-requests`);
    expect(staffMail()[0]!.text).toContain('1 request is waiting');

    // Two more within the hour: no mail now, nor from a tick 30 minutes on.
    await pendingRequest();
    await pendingRequest();
    expect(staffMail()).toHaveLength(2);
    expect(await notifyStaff(testEnv, Date.now() + 30 * 60_000)).toBe(0);
    expect(staffMail()).toHaveLength(2);

    // The tick after the hour sends one digest covering both.
    await runCrons({ cron: CRON_STALE, scheduledTime: Date.now() + HOUR + 60_000, noRetry() {} } as ScheduledController, testEnv, {} as ExecutionContext);
    expect(staffMail()).toHaveLength(4);
    expect(staffMail().at(-1)).toMatchObject({ subject: '2 new access requests for hosted Worca' });
    expect(staffMail().at(-1)!.text).toContain('3 requests are waiting');
    // Nothing new: the next tick stays quiet.
    expect(await notifyStaff(testEnv, Date.now() + 3 * HOUR)).toBe(0);
  });
});

describe('console: grant and decline', () => {
  it('grant makes a single-use code bound to the address, mails it, and the request joins on sign-up', async () => {
    const sa = await staffUser('superadmin');
    const email = freshEmail('grant');
    const id = await pendingRequest(email);

    const list = await call('GET', '/api/platform/access-requests', as(sa));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { requests: Record<string, unknown>[]; counts: Record<string, unknown> };
    expect(listed.requests).toEqual([expect.objectContaining({ id, email, useCase: 'Running pipelines for my team', company: 'Acme', source: 'hosted', status: 'pending' })]);
    expect(listed.counts).toMatchObject({ requested: 1, confirmed: 1, granted: 0, joined: 0 });
    const viewed = await testEnv.DB.prepare("SELECT details FROM audit_platform WHERE action = 'platform.access_requests_viewed' AND actor_id = ?").bind(sa.id).first<{ details: string }>();
    expect(JSON.parse(viewed!.details)).toEqual({ count: 1 });
    expect(((await (await call('GET', '/api/platform/stats', as(sa))).json()) as { accessRequestsPending: number }).accessRequestsPending).toBe(1);

    const res = await call('POST', `/api/platform/access-requests/${id}/grant`, { ...as(sa), body: { message: 'Welcome aboard!' } });
    expect(res.status).toBe(200);
    const granted = (await res.json()) as { code: string; codeId: string; expiresAt: number; mailed: boolean };
    expect(granted.mailed).toBe(true);
    expect(granted.codeId).toBe(await sha256Hex(granted.code));
    expect(granted.expiresAt - Date.now()).toBeGreaterThan(13.9 * 86_400_000);

    const sent = mail.find((m) => m.to === email && m.subject === 'Your access to hosted Worca')!;
    expect(sent.kind).toBe('access_request');
    expect(sent.text).toContain(`${ORIGIN}/sign-in#code=${granted.code}`);
    expect(sent.text).toContain(granted.code);
    expect(sent.text).toContain('Welcome aboard!');
    expect(sent.html).toContain('Welcome aboard!');

    const code = await testEnv.DB.prepare('SELECT uses_left, uses_total, tier, email_index, note FROM registration_codes WHERE code_hash = ?').bind(granted.codeId).first<Record<string, unknown>>();
    expect(code).toMatchObject({ uses_left: 1, uses_total: 1, tier: 'free', email_index: await ring().emailIndex(email) });
    expect(String(code?.note)).not.toContain('Access request'); // encrypted
    expect(await rowFor(email)).toMatchObject({ status: 'granted', registration_code_id: granted.codeId, decided_by: sa.id });
    expect((await call('POST', `/api/platform/access-requests/${id}/grant`, as(sa))).status).toBe(409);
    expect((await call('POST', `/api/platform/access-requests/${id}/decline`, as(sa))).status).toBe(409);

    // The code works for this address only.
    expect(await findValidCode(testEnv, granted.code, 'someone-else@example.com')).toBeNull();
    expect(await findValidCode(testEnv, granted.code, email.toUpperCase())).toMatchObject({ codeHash: granted.codeId });
    expect(await claimCode(testEnv, granted.code, 'someone-else@example.com')).toBeNull();
    expect(await claimCode(testEnv, granted.code, null)).toBeNull();

    // Through the Worker: another address is refused, the right one signs up and joins.
    await testEnv.DB.prepare(
      "INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'invite_code', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    expect((await signUp(freshEmail('thief'), granted.code)).status).toBe(403);
    const joined = await signUp(email, granted.code);
    expect(joined.status).toBe(200);
    expect(await rowFor(email)).toMatchObject({ status: 'joined', joined_at: expect.any(Number) });
    const after = (await (await call('GET', '/api/platform/access-requests?status=all', as(sa))).json()) as { requests: { status: string }[]; counts: Record<string, unknown> };
    expect(after.requests.map((r) => r.status)).toEqual(['joined']);
    expect(after.counts).toMatchObject({ requested: 1, confirmed: 1, granted: 1, joined: 1, withInstance: 0 });

    // Once they run an instance in an org of theirs, the funnel's last step counts them.
    const user = await testEnv.DB.prepare('SELECT id FROM user WHERE emailIndex = ?').bind(await ring().emailIndex(email)).first<{ id: string }>();
    const orgId = crypto.randomUUID();
    await insertRow('organization', { id: orgId, name: 'enc', slug: orgId.slice(0, 12), createdAt: new Date().toISOString() });
    await insertRow('member', { id: crypto.randomUUID(), organizationId: orgId, userId: user!.id, role: 'tenant_admin', createdAt: new Date().toISOString() });
    await insertRow('instances', { id: crypto.randomUUID(), org_id: orgId, slug: orgId.slice(0, 10), key_slug: orgId.slice(-10), display_name: 'enc', status: 'running', created_at: Date.now(), updated_at: Date.now() });
    const last = (await (await call('GET', '/api/platform/access-requests?status=all', as(sa))).json()) as { counts: Record<string, unknown> };
    expect(last.counts).toMatchObject({ withInstance: 1 });
  });

  it('the sign-in page fills the sign-up code from #code= and drops the fragment', () => {
    expect(SIGN_IN_JS).toContain("new URLSearchParams(location.hash.slice(1)).get('code')");
    expect(SIGN_IN_JS).toContain("$('signup-code').value = codeFromLink.trim()");
    expect(SIGN_IN_JS).toContain('history.replaceState');
  });

  it('a code without an address still works for anyone', async () => {
    const code = `OPEN-${crypto.randomUUID()}`;
    await testEnv.DB.prepare('INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, 1, NULL, ?)')
      .bind(await sha256Hex(code), 'free', Date.now())
      .run();
    expect(await findValidCode(testEnv, code, 'anyone@example.com')).not.toBeNull();
    expect(await claimCode(testEnv, code, 'anyone@example.com')).not.toBeNull();
  });

  it('decline mails a polite note by default, or nothing; only pending requests', async () => {
    const sa = await staffUser('superadmin');
    const a = freshEmail('decline-a');
    const b = freshEmail('decline-b');
    const idA = await pendingRequest(a);
    const idB = await pendingRequest(b);
    const res = await call('POST', `/api/platform/access-requests/${idA}/decline`, { ...as(sa), body: { message: 'We are full this month.' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mailed: true });
    const sent = mail.find((m) => m.to === a && m.subject === 'Your request for hosted Worca')!;
    expect(sent.text).toContain('We are full this month.');
    expect((await rowFor(a))?.status).toBe('declined');

    expect(await (await call('POST', `/api/platform/access-requests/${idB}/decline`, { ...as(sa), body: { notify: false } })).json()).toEqual({ ok: true, mailed: false });
    expect(mail.some((m) => m.to === b && m.subject === 'Your request for hosted Worca')).toBe(false);
    expect((await call('POST', `/api/platform/access-requests/${idB}/grant`, as(sa))).status).toBe(409);
    expect((await call('POST', `/api/platform/access-requests/${crypto.randomUUID()}/decline`, as(sa))).status).toBe(404);
    const audited = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM audit_platform WHERE action = 'platform.access_request_declined' AND target_id IN (?, ?)").bind(idA, idB).first<{ n: number }>();
    expect(audited?.n).toBe(2);
  });

  it('unconfirmed requests are counted but never listed', async () => {
    const sa = await staffUser('superadmin');
    await request({ email: freshEmail('unconf'), useCase: 'x' });
    const body = (await (await call('GET', '/api/platform/access-requests?status=all', as(sa))).json()) as { requests: unknown[]; counts: Record<string, unknown> };
    expect(body.requests).toEqual([]);
    expect(body.counts).toMatchObject({ requested: 1, confirmed: 0 });
  });

  it('is superadmin only, with a passkey session', async () => {
    const sa = await staffUser('superadmin');
    const admin = await staffUser('admin');
    const support = await staffUser('support');
    const id = await pendingRequest();
    for (const who of [admin, support]) {
      expect((await call('GET', '/api/platform/access-requests', as(who))).status).toBe(403);
      expect((await call('POST', `/api/platform/access-requests/${id}/grant`, as(who))).status).toBe(403);
      expect((await call('POST', `/api/platform/access-requests/${id}/decline`, as(who))).status).toBe(403);
    }
    const noMfa = await call('GET', '/api/platform/access-requests', as(sa, false));
    expect(noMfa.status).toBe(403);
    expect(await noMfa.json()).toEqual({ error: 'mfa_required' });
    expect((await call('GET', '/api/platform/access-requests')).status).toBe(401);
  });
});

/** Email-code sign-in through the Worker with a sign-up code. */
async function signUp(email: string, code: string): Promise<Response> {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
  const otp = /code: (\d{6})/.exec(mails.at(-1)?.subject ?? '')?.[1];
  expect(otp).toBeTruthy();
  return post('/api/auth/sign-in/email-otp', { email, otp }, { 'x-signup-code': code });
}

describe('CORS and the Origin check', () => {
  it('answers the preflight from a website origin only', async () => {
    const pre = await SELF.fetch(`${ORIGIN}/api/public/access-requests`, {
      method: 'OPTIONS',
      headers: { origin: FORM_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-turnstile-token' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(FORM_ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-turnstile-token');
    const other = await SELF.fetch(`${ORIGIN}/api/public/access-requests`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const post = await SELF.fetch(`${ORIGIN}/api/public/access-requests`, { method: 'POST', headers: { origin: FORM_ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(400); // past the Origin check, refused by validation
    expect(post.headers.get('access-control-allow-origin')).toBe(FORM_ORIGIN);
  });

  // Deployed settings: local dev trusts every localhost origin, so the Origin check is exercised
  // with LOCAL_DEV off and an https app origin.
  const deployed = { ...testEnv, LOCAL_DEV: undefined, APP_ORIGIN: 'https://app.worca.test', PUBLIC_FORM_ORIGINS: FORM_ORIGIN, TURNSTILE_SECRET: undefined } as Env;
  const stack = new Hono<AppContext>();
  for (const mw of globalMiddleware) stack.use('*', mw);
  stack.route('/api/public', publicApp);
  stack.post('/api/orgs/x', (c) => c.json({ ok: true }));
  const post = (path: string, headers: Record<string, string>, e: Env = deployed) =>
    stack.request(`https://app.worca.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }, e);

  it('lets a website origin through for /api/public only', async () => {
    expect((await post('/api/public/access-requests', { origin: FORM_ORIGIN })).status).toBe(400);
    const elsewhere = await post('/api/orgs/x', { origin: FORM_ORIGIN });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ error: 'invalid_origin' });
    expect((await post('/api/public/access-requests', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('rate-limits the form per address and asks for Turnstile when it is on', async () => {
    const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post('/api/public/access-requests', { origin: FORM_ORIGIN, 'cf-connecting-ip': ip })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    const turnstile = await post('/api/public/access-requests', { origin: FORM_ORIGIN }, { ...deployed, TURNSTILE_SECRET: 'secret' });
    expect(turnstile.status).toBe(403);
    expect(((await turnstile.json()) as { error: string }).error).toBe('turnstile_required');
  });
});

describe('data protection', () => {
  const keyRows = async (id: string) =>
    (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM data_keys WHERE owner_type = 'user' AND owner_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

  it('each request has its own data key under an ar_ id', async () => {
    const a = freshEmail('key-a');
    const b = freshEmail('key-b');
    await request({ email: a, useCase: 'first' });
    await request({ email: b, useCase: 'second' });
    const ra = await rowFor(a);
    const rb = await rowFor(b);
    expect(String(ra?.id)).toMatch(/^ar_[0-9a-f-]{36}$/);
    expect(ra?.id).not.toBe(rb?.id);
    expect(await keyRows(String(ra?.id))).toBe(1);
    expect(await keyRows(String(rb?.id))).toBe(1);
    // Bound to its own key: one request's ciphertext doesn't open under another's.
    await expect(ring().decrypt({ table: 'access_requests', column: 'email', rowId: String(ra?.id), owner: { type: 'user', id: String(rb?.id) } }, String(ra?.email))).rejects.toThrow();
  });

  it('the platform key counts list request keys apart from user keys', async () => {
    const sa = await staffUser('superadmin');
    await request({ email: freshEmail('keys'), useCase: 'x' });
    const keys = (await (await call('GET', '/api/platform/keys', as(sa))).json()) as { wrapped: { user: { count: number }[] }; formKeys: { accessRequests: number } };
    const accountKeys = (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM data_keys WHERE owner_type = 'user' AND wrapped IS NOT NULL AND substr(owner_id, 1, 3) NOT IN ('ar_', 'nl_')").first<{ n: number }>())!.n;
    expect(keys.wrapped.user.reduce((n, g) => n + g.count, 0)).toBe(accountKeys);
    expect(keys.formKeys.accessRequests).toBe(
      (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM data_keys WHERE substr(owner_id, 1, 3) = 'ar_'").first<{ n: number }>())!.n,
    );
    expect(keys.formKeys.accessRequests).toBeGreaterThan(0);
  });

  it('retention deletes expired unconfirmed requests with their key, and shreds decided ones keeping the counts', async () => {
    const sa = await staffUser('superadmin');
    const now = Date.now();
    // Unconfirmed: one expired more than 7 days ago, one expired only yesterday.
    const stale = freshEmail('stale');
    const recent = freshEmail('recent');
    await request({ email: stale, useCase: 'x' });
    await request({ email: recent, useCase: 'x' });
    const staleId = String((await rowFor(stale))?.id);
    const recentId = String((await rowFor(recent))?.id);
    await testEnv.DB.prepare('UPDATE access_requests SET confirm_expires_at = ? WHERE id = ?').bind(now - UNCONFIRMED_GRACE_MS - 60_000, staleId).run();
    await testEnv.DB.prepare('UPDATE access_requests SET confirm_expires_at = ? WHERE id = ?').bind(now - 86_400_000, recentId).run();
    // Decided long ago: declined, granted, joined; and one declined recently; and a pending one.
    const old = now - RETENTION_MS - 86_400_000;
    const ids: Record<string, string> = {};
    for (const key of ['declined', 'granted', 'joined', 'recentDecline', 'pending']) {
      const email = freshEmail(key);
      ids[key] = await pendingRequest(email, { useCase: `secret plan ${key}` });
    }
    await call('POST', `/api/platform/access-requests/${ids.declined}/decline`, { ...as(sa), body: { notify: false, message: 'note' } });
    await call('POST', `/api/platform/access-requests/${ids.recentDecline}/decline`, { ...as(sa), body: { notify: false } });
    await call('POST', `/api/platform/access-requests/${ids.granted}/grant`, { ...as(sa), body: { message: 'hi' } });
    await call('POST', `/api/platform/access-requests/${ids.joined}/grant`, as(sa));
    await testEnv.DB.prepare("UPDATE access_requests SET status = 'joined', joined_at = ? WHERE id = ?").bind(old, ids.joined).run();
    for (const k of ['declined', 'granted', 'joined']) await testEnv.DB.prepare('UPDATE access_requests SET decided_at = ? WHERE id = ?').bind(old, ids[k]).run();
    const before = ((await (await call('GET', '/api/platform/access-requests?status=all', as(sa))).json()) as { counts: Record<string, unknown> }).counts;

    await runCrons({ cron: CRON_DAILY, scheduledTime: now, noRetry() {} } as ScheduledController, testEnv, {} as ExecutionContext);

    expect(await testEnv.DB.prepare('SELECT 1 FROM access_requests WHERE id = ?').bind(staleId).first()).toBeNull();
    expect(await keyRows(staleId)).toBe(0);
    expect(await keyRows(recentId)).toBe(1);
    for (const k of ['declined', 'granted', 'joined']) {
      const row = await testEnv.DB.prepare('SELECT * FROM access_requests WHERE id = ?').bind(ids[k]).first<Record<string, unknown>>();
      expect(row, k).toMatchObject({ email: null, email_index: null, use_case: null, company: null, decision_note: null, shredded_at: expect.any(Number) });
      expect(row?.source).toBe('hosted');
      expect(await keyRows(ids[k]!)).toBe(0);
    }
    expect((await testEnv.DB.prepare('SELECT registration_code_id FROM access_requests WHERE id = ?').bind(ids.granted).first<{ registration_code_id: string }>())?.registration_code_id).toBeTruthy();
    for (const k of ['recentDecline', 'pending']) {
      expect((await testEnv.DB.prepare('SELECT shredded_at FROM access_requests WHERE id = ?').bind(ids[k]).first<{ shredded_at: number | null }>())?.shredded_at).toBeNull();
      expect(await keyRows(ids[k]!)).toBe(1);
    }

    // Counts survive (minus the one unconfirmed row that was deleted); the list shows "(removed)".
    const after = (await (await call('GET', '/api/platform/access-requests?status=all', as(sa))).json()) as {
      counts: Record<string, number>;
      requests: { id: string; email: string | null; useCase: string | null; removed: boolean }[];
    };
    expect(after.counts.confirmed).toBe(Number(before.confirmed));
    expect(after.counts.granted).toBe(Number(before.granted));
    expect(after.counts.requested).toBe(Number(before.requested) - 1);
    const declined = after.requests.find((r) => r.id === ids.declined);
    expect(declined).toMatchObject({ email: null, useCase: null, removed: true });
    const pending = (await (await call('GET', '/api/platform/access-requests', as(sa))).json()) as { requests: { id: string }[] };
    expect(pending.requests.map((r) => r.id)).toEqual([ids.pending]);
  });

  it('no address or use-case text reaches the audit log or the logs', async () => {
    const sa = await staffUser('superadmin');
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' '))));
    try {
      const email = freshEmail('pii');
      const id = await pendingRequest(email, { useCase: 'TOPSECRET-USECASE', company: 'TOPSECRET-CO' });
      await call('GET', '/api/platform/access-requests?status=all', as(sa));
      // A failing transport whose message names the address: the log line must not.
      setTenancyDeps({ sendEmail: async (_e, msg) => { throw new Error(`could not deliver to ${msg.to}`); } });
      const res = await call('POST', `/api/platform/access-requests/${id}/grant`, { ...as(sa), body: { message: 'TOPSECRET-MSG' } });
      expect(((await res.json()) as { mailed: boolean }).mailed).toBe(false);
      const audit = (await testEnv.DB.prepare('SELECT action, target_id, details FROM audit_platform').all()).results.map((r) => JSON.stringify(r)).join('\n');
      for (const secret of [email, 'TOPSECRET']) {
        expect(audit).not.toContain(secret);
        expect(logged.join('\n')).not.toContain(secret);
      }
      expect(logged.join('\n')).toContain('[address]');
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logSafe(new Error('to Jo.Doe+x@Example.com failed'))).toBe('to [address] failed');
  });
});
