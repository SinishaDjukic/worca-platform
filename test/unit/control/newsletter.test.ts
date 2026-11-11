// Newsletter (D70): public subscribe with double opt-in, manage tokens, one-click unsubscribe,
// the release hook, classification and recipient thresholds, the batch send and its quota
// reserve, bounce suppression, the account card's API and the console endpoint.
import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext, Env } from '../../../packages/platform/src/control/env';
import worker from '../../../packages/platform/src/control/index';
import { readDevMail } from '../../../packages/platform/src/control/auth/email';
import { RATE_LIMITS } from '../../../packages/platform/src/control/auth/rate-limit';
import { TURNSTILE_PATHS } from '../../../packages/platform/src/control/auth/turnstile';
import { recordSentMail, utcDay } from '../../../packages/platform/src/control/system/mail';
import { signSvix } from '../../../packages/platform/src/control/system/svix';
import { getKeyRing } from '../../../packages/platform/src/control/keys';
import {
  allowanceFrom,
  classifyRelease,
  countRecipients,
  emailField,
  manageToken,
  notesExcerpt,
  NOTES_MAX,
  parseVersion,
  pruneUnconfirmed,
  QUOTA_RESERVE,
  SHRED_AFTER_MS,
  shredExpired,
  queueReleaseIssue,
  sendIssueBatch,
  subscriberForToken,
  UNCONFIRMED_TTL_MS,
  type ReleaseLevel,
  type ReleasePref,
} from '../../../packages/platform/src/control/newsletter/core';
import { releaseSignature } from '../../../packages/platform/src/control/newsletter/hooks';
import { meNewsletterApp, platformNewsletterApp } from '../../../packages/platform/src/control/newsletter/routes';
import { runNewsletterSend } from '../../../packages/platform/src/control/newsletter/workflow';
import { keysEnv } from './helpers/keys-env';
import { insertRow } from './helpers/tenancy-fixtures';
import { purgeUser } from '../../../packages/platform/src/control/tenancy/lifecycle';
import { staffUser } from './helpers/system-harness';

// ---- setup ----------------------------------------------------------------------------------------

interface Created {
  id: string;
  params: unknown;
}
function fakeWorkflow() {
  const created: Created[] = [];
  const binding = {
    async create(opts: { id: string; params: unknown }) {
      created.push(opts);
      return { id: opts.id } as unknown as WorkflowInstance;
    },
  } as unknown as Workflow;
  return { created, binding };
}

const HOOK_SECRET = 'test-release-hook-secret';
const wf = fakeWorkflow();
const base = (over: Partial<Env> = {}): Env =>
  keysEnv({ NEWSLETTER_FROM: 'worca <news@worca.dev>', NEWSLETTER_SEND: wf.binding, RESEND_API_KEY: undefined, LOCAL_DEV: '1', ...over });
let E = base();
const ORIGIN = () => E.APP_ORIGIN;

/** Through the real Worker: the global middleware (origin check, security headers) included. */
function call(path: string, init: RequestInit = {}, env: Env = E) {
  return worker.fetch(new Request(`${ORIGIN()}${path}`, init), env, createExecutionContext());
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}, env?: Env) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);

let n = 0;
const addr = () => `nl-${Date.now()}-${n++}@example.com`;

type Captured = { subject: string; text: string; html: string; kind: string; ref?: string; from?: string; headers?: Record<string, string> };
const mails = async (to: string) => (await readDevMail(E, to)) as Captured[];

const fragment = (text: string, key: 'c' | 't') => {
  const m = new RegExp(`#${key}=([^&\\s]+)`).exec(text);
  if (!m) throw new Error(`no #${key}= link in ${text}`);
  return decodeURIComponent(m[1]!);
};

async function row(email: string) {
  const index = await getKeyRing(E).emailIndex(email);
  return E.DB.prepare('SELECT * FROM newsletter_subscribers WHERE email_index = ?')
    .bind(index)
    .first<{ id: string; email: string | null; email_index: string; status: string; releases: string; product: number; token_version: number; source: string | null; confirmed_at: number | null; confirm_expires_at: number | null; shred_after: number | null }>();
}

/** Subscribes through the API and confirms; returns the manage token. */
async function activeSubscriber(email: string, releases: ReleasePref = 'minor', product = true): Promise<string> {
  expect((await post('/api/public/newsletter/subscribe', { email, releases, product })).status).toBe(202);
  const confirm = fragment((await mails(email)).at(-1)!.text, 'c');
  const res = await post('/api/public/newsletter/confirm', { token: confirm });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  E = base();
  wf.created.length = 0;
  await E.DB.batch([
    E.DB.prepare('DELETE FROM newsletter_subscribers'),
    E.DB.prepare('DELETE FROM newsletter_issues'),
    E.DB.prepare('DELETE FROM mail_daily'),
    E.DB.prepare('DELETE FROM mail_messages'),
  ]);
});

// ---- subscribe ------------------------------------------------------------------------------------

describe('POST /api/public/newsletter/subscribe', () => {
  it('400 invalid_input on a bad address, preference or body, and when nothing is chosen', async () => {
    for (const body of [
      { email: 'not-an-address', releases: 'minor', product: true },
      { email: addr(), releases: 'weekly', product: true },
      { email: addr(), releases: 'minor' },
      { email: addr(), releases: 'none', product: false },
      { email: addr(), releases: 'minor', product: true, source: 'has spaces <b>' },
    ]) {
      const res = await post('/api/public/newsletter/subscribe', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_input' });
    }
    const raw = await call('/api/public/newsletter/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(raw.status).toBe(400);
  });

  it('answers 202 { ok: true } whatever it knows about the address (no enumeration)', async () => {
    const fresh = addr();
    const active = addr();
    const suppressed = addr();
    await activeSubscriber(active);
    await activeSubscriber(suppressed);
    await E.DB.prepare("UPDATE newsletter_subscribers SET status = 'suppressed' WHERE id = ?").bind((await row(suppressed))!.id).run();
    const answers = [];
    for (const email of [fresh, active, suppressed, fresh]) {
      const res = await post('/api/public/newsletter/subscribe', { email, releases: 'major', product: false });
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify([202, '{"ok":true}'])]));
  });

  it('is rate limited per IP and guarded by Turnstile, like the other mail-sending endpoints', () => {
    expect(RATE_LIMITS['/api/public/newsletter/subscribe']).toBeDefined();
    expect(RATE_LIMITS['/api/public/newsletter/link']).toBeDefined();
    expect(TURNSTILE_PATHS.has('/api/public/newsletter/subscribe')).toBe(true);
  });

  it('answers the website origin with CORS; refuses other cross-site origins', async () => {
    const site = E.PUBLIC_FORM_ORIGINS!.split(',')[0]!.trim();
    const ok = await post('/api/public/newsletter/subscribe', { email: addr(), releases: 'minor', product: true }, { origin: site });
    expect(ok.status).toBe(202);
    expect(ok.headers.get('access-control-allow-origin')).toBe(site);
    const evil = await post('/api/public/newsletter/subscribe', { email: addr(), releases: 'minor', product: true }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });
});

describe('double opt-in', () => {
  it('stores an unconfirmed, encrypted subscriber and mails a confirmation link; confirming activates', async () => {
    const email = addr();
    await post('/api/public/newsletter/subscribe', { email, releases: 'micro', product: false, source: 'website:footer' });
    const r = await row(email);
    expect(r).toMatchObject({ status: 'unconfirmed', releases: 'micro', product: 0, source: 'website:footer', confirmed_at: null });
    expect(r!.id).toMatch(/^nl_/);
    const stored = await E.DB.prepare('SELECT email FROM newsletter_subscribers WHERE id = ?').bind(r!.id).first<{ email: string }>();
    expect(stored!.email).not.toContain('@');
    expect(await getKeyRing(E).decrypt(emailField(r!.id), stored!.email)).toBe(email);

    const [mail] = await mails(email);
    expect(mail).toMatchObject({ kind: 'newsletter_confirm', from: 'worca <news@worca.dev>', replyTo: 'hello@example.com', ref: `newsletter:${r!.id}:confirm` });
    expect(mail!.subject).toMatch(/Confirm your subscription/);
    expect(mail!.text).toContain(`${ORIGIN()}/newsletter#c=`);

    // Opening the page changes nothing (scanners prefetch); the page's script posts the token.
    const page = await call('/newsletter');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/newsletter/page.js');
    expect((await row(email))!.status).toBe('unconfirmed');

    const token = fragment(mail!.text, 'c');
    const res = await post('/api/public/newsletter/confirm', { token });
    expect(res.status).toBe(200);
    const { token: manage } = (await res.json()) as { token: string };
    expect(await subscriberForToken(E, manage)).toMatchObject({ id: r!.id, status: 'active' });
    expect((await row(email))!.confirmed_at).toBeGreaterThan(0);

    // Opening the link again while it is valid answers the same (preview, then browser).
    const again = await post('/api/public/newsletter/confirm', { token });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { token: string }).token).toBe(manage);
    // ...but only for an hour after the first confirmation.
    expect((await row(email))!.confirm_expires_at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    const { confirmSubscription } = await import('../../../packages/platform/src/control/newsletter/core');
    expect(await confirmSubscription(E, token, Date.now() + 61 * 60 * 1000)).toBeNull();
    expect((await post('/api/public/newsletter/confirm', { token: 'x'.repeat(43) })).status).toBe(410);
  });

  it('an active subscriber signing up again gets nothing but their manage link, at most once an hour', async () => {
    const email = addr();
    await activeSubscriber(email);
    const before = (await mails(email)).length;
    await post('/api/public/newsletter/subscribe', { email, releases: 'rc', product: false });
    await post('/api/public/newsletter/subscribe', { email, releases: 'rc', product: false });
    const after = await mails(email);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ kind: 'newsletter_confirm', subject: 'Your Worca newsletter settings' });
    expect((await row(email))!.releases).toBe('minor'); // the public form can't change an active subscription
  });

  it('a suppressed address gets no mail at all', async () => {
    const email = addr();
    await activeSubscriber(email);
    await E.DB.prepare("UPDATE newsletter_subscribers SET status = 'suppressed' WHERE id = ?").bind((await row(email))!.id).run();
    const before = (await mails(email)).length;
    await post('/api/public/newsletter/subscribe', { email, releases: 'minor', product: true });
    await post('/api/public/newsletter/link', { email });
    expect((await mails(email)).length).toBe(before);
  });
});

// ---- manage tokens and preferences ------------------------------------------------------------------

describe('manage tokens', () => {
  it('verifies the signature and the version; unsubscribe-all bumps the version and kills old links', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    const r = (await row(email))!;
    expect(token.startsWith(`${r.id}.1.`)).toBe(true);
    expect(await subscriberForToken(E, token)).not.toBeNull();
    const sig = token.split('.')[2]!;
    const flipped = `${r.id}.1.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await subscriberForToken(E, flipped)).toBeNull();
    expect(await subscriberForToken(E, `${r.id}.2.${sig}`)).toBeNull();
    // Another secret signs differently: the key is derived from BETTER_AUTH_SECRET.
    expect(await manageToken(keysEnv({ BETTER_AUTH_SECRET: 'another-secret-another-secret-0123456' }), r.id, 1)).not.toBe(token);

    const prefs = await post('/api/public/newsletter/prefs', { token });
    expect(prefs.status).toBe(200);
    expect(await prefs.json()).toEqual({ email: expect.stringMatching(/^n….*@example\.com$/), status: 'active', releases: 'minor', product: true });

    const off = await post('/api/public/newsletter/unsubscribe-all', { token });
    expect(await off.json()).toEqual({ ok: true, status: 'unsubscribed' });
    expect(await row(email)).toMatchObject({ status: 'unsubscribed', token_version: 2 });
    expect((await post('/api/public/newsletter/prefs', { token })).status).toBe(410);
    expect((await post('/api/public/newsletter/unsubscribe-all', { token })).status).toBe(410);
  });

  it('updates preferences; an unsubscribed (not revoked) token subscribes again; nothing chosen is 400', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    const res = await post('/api/public/newsletter/prefs/update', { token, releases: 'rc', product: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'active', releases: 'rc', product: false });
    expect((await post('/api/public/newsletter/prefs/update', { token, releases: 'none', product: false })).status).toBe(400);
    expect((await post('/api/public/newsletter/prefs/update', { token: 'garbage', releases: 'major', product: true })).status).toBe(410);

    await call(`/api/public/newsletter/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await row(email))!.status).toBe('unsubscribed');
    const again = await post('/api/public/newsletter/prefs/update', { token, releases: 'major', product: true });
    expect(await again.json()).toMatchObject({ status: 'active', releases: 'major' });

    await E.DB.prepare("UPDATE newsletter_subscribers SET status = 'suppressed' WHERE id = ?").bind((await row(email))!.id).run();
    expect((await post('/api/public/newsletter/prefs/update', { token, releases: 'major', product: true })).status).toBe(409);
  });

  it('"email me a manage link": 202 for anyone, a link only to active subscribers, once an hour', async () => {
    const email = addr();
    await activeSubscriber(email);
    const before = (await mails(email)).length;
    for (const e of [email, email, addr()]) expect((await post('/api/public/newsletter/link', { email: e })).status).toBe(202);
    const after = await mails(email);
    expect(after.length).toBe(before + 1);
    const token = fragment(after.at(-1)!.text, 't');
    expect(await subscriberForToken(E, token)).not.toBeNull();
    expect((await post('/api/public/newsletter/link', { email: 'nope' })).status).toBe(400);
  });
});

describe('one-click unsubscribe (RFC 8058)', () => {
  it('POST from a mail provider (form body, no Origin) unsubscribes; GET only shows the page', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    const url = `/api/public/newsletter/unsubscribe?t=${encodeURIComponent(token)}`;

    const get = await call(url, { redirect: 'manual' });
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toBe(`/newsletter#t=${encodeURIComponent(token)}&u=1`);
    expect((await row(email))!.status).toBe('active');

    const res = await call(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(res.status).toBe(200);
    expect((await row(email))!.status).toBe('unsubscribed');
    // Idempotent: a provider repeating the POST still gets 200.
    expect((await call(url, { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status).toBe(200);
    expect((await call('/api/public/newsletter/unsubscribe?t=bogus', { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status).toBe(410);
  });
});

// ---- releases --------------------------------------------------------------------------------------

describe('classification', () => {
  it.each([
    ['1.9.0-rc.1', ['1.8.0'], 'rc'],
    ['2.0.0-beta.2', [], 'rc'],
    ['1.0.0', [], 'major'],
    ['1.8.0', [], 'minor'],
    ['1.8.3', [], 'minor'],
    ['2.0.0', ['1.8.2'], 'major'],
    ['1.9.0', ['1.8.2', '1.9.0-rc.1'], 'minor'],
    ['1.9.1', ['1.8.2', '1.9.0'], 'micro'],
    ['v1.9.2', ['1.9.1'], 'micro'],
    ['1.8.3', ['1.8.2', '1.9.0'], 'micro'], // a patch to an older line
    ['2.1.0', ['1.9.0', '2.0.0'], 'minor'],
  ] as const)('%s after %j is %s', (version, announced, level) => {
    expect(classifyRelease(version, announced)).toBe(level);
  });

  it('parses versions strictly', () => {
    expect(parseVersion('v1.2.3+build.5')).toMatchObject({ version: '1.2.3', prerelease: null });
    expect(parseVersion('1.2.3-rc.1')).toMatchObject({ version: '1.2.3-rc.1', prerelease: 'rc.1' });
    for (const bad of ['1.2', '1.2.3.4', 'latest', '1.2.3-', '']) expect(parseVersion(bad), bad).toBeNull();
  });

  it('cuts notes at a line, never inside a list item, and marks the cut', () => {
    expect(notesExcerpt('  \n ')).toBeNull();
    const long = 'word '.repeat(1000);
    const cut = notesExcerpt(long)!;
    expect(cut.length).toBeLessThanOrEqual(NOTES_MAX + 3);
    expect(cut.endsWith('\n\n…')).toBe(true);
    const list = Array.from({ length: 60 }, (_, i) => `* Change number ${i} by @someone in https://github.com/o/r/pull/${i}`).join('\n');
    const listCut = notesExcerpt(list)!;
    const kept = listCut.split('\n\n…')[0]!.split('\n');
    expect(kept.every((l) => /^\* Change number \d+ by @someone in https:\/\/github\.com\/o\/r\/pull\/\d+$/.test(l))).toBe(true);
  });
});

async function seed(email: string, releases: ReleasePref, product: boolean, status = 'active'): Promise<string> {
  const ring = getKeyRing(E);
  const id = `nl_${crypto.randomUUID()}`;
  await ring.ensureKey({ type: 'user', id });
  const now = Date.now();
  await E.DB.prepare(
    `INSERT INTO newsletter_subscribers (id, email, email_index, status, releases, product, token_version, source, created_at, confirmed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'test', ?, ?, ?)`,
  )
    .bind(id, await ring.encrypt(emailField(id), email), await ring.emailIndex(email), status, releases, product ? 1 : 0, now, now, now)
    .run();
  return id;
}

describe('recipients by threshold', () => {
  it('a release of each level reaches the preferences at or below it', async () => {
    const prefs: ReleasePref[] = ['none', 'major', 'minor', 'micro', 'rc'];
    for (const p of prefs) await seed(addr(), p, false);
    await seed(addr(), 'rc', true, 'unsubscribed');
    await seed(addr(), 'rc', true, 'suppressed');
    await seed(addr(), 'rc', true, 'unconfirmed');
    const expected: Record<ReleaseLevel, number> = { major: 4, minor: 3, micro: 2, rc: 1 };
    for (const [level, count] of Object.entries(expected)) {
      expect(await countRecipients(E, { kind: 'release', release_level: level as ReleaseLevel }), level).toBe(count);
    }
    expect(await countRecipients(E, { kind: 'product', release_level: null })).toBe(0);
  });
});

describe('POST /api/hooks/release', () => {
  const body = (v: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: v, url: `https://github.com/SinishaDjukic/worca-cc/releases/tag/v${v}`, ...extra });
  const hook = async (raw: string, sig?: string, env = base({ RELEASE_HOOK_SECRET: HOOK_SECRET })) =>
    call('/api/hooks/release', { method: 'POST', headers: { 'content-type': 'application/json', 'x-worca-signature': sig ?? (await releaseSignature(HOOK_SECRET, raw)) }, body: raw }, env);

  it('404 while RELEASE_HOOK_SECRET is unset', async () => {
    const raw = body('1.9.0');
    expect((await hook(raw, undefined, base({ RELEASE_HOOK_SECRET: undefined }))).status).toBe(404);
  });

  it('401 on a missing, wrong or tampered signature; nothing queued', async () => {
    const raw = body('1.9.0');
    expect((await call('/api/hooks/release', { method: 'POST', body: raw }, base({ RELEASE_HOOK_SECRET: HOOK_SECRET }))).status).toBe(401);
    expect((await hook(raw, await releaseSignature('wrong-secret', raw))).status).toBe(401);
    expect((await hook(body('1.9.1'), await releaseSignature(HOOK_SECRET, raw))).status).toBe(401);
    expect(await E.DB.prepare('SELECT COUNT(*) AS n FROM newsletter_issues').first('n')).toBe(0);
    expect(wf.created).toEqual([]);
  });

  it('202 with the classification, starts the send Workflow; the same version again is a 200 duplicate', async () => {
    await seed(addr(), 'minor', false);
    await seed(addr(), 'major', true);
    const raw = body('1.9.0', { notes: 'Faster <b>pipelines</b>.' });
    const sig = await releaseSignature(HOOK_SECRET, raw);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const res = await hook(raw, sig.toUpperCase().replace('SHA256=', 'sha256=')); // hex case doesn't matter
    expect(res.status).toBe(202);
    const out = (await res.json()) as { issueId: string; level: string; recipients: number };
    expect(out).toMatchObject({ ok: true, version: '1.9.0', level: 'minor', recipients: 1 }); // 'major' doesn't get a minor release
    expect(wf.created).toHaveLength(1);
    expect(wf.created[0]!.params).toEqual({ issueId: out.issueId, notes: 'Faster <b>pipelines</b>.' });
    const issue = await E.DB.prepare('SELECT * FROM newsletter_issues WHERE id = ?').bind(out.issueId).first();
    expect(issue).toMatchObject({ kind: 'release', version: '1.9.0', release_level: 'minor', subject: 'Worca 1.9.0 is out', status: 'sending', recipients: 1 });

    const again = await hook(raw);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true, issueId: out.issueId });
    expect(wf.created).toHaveLength(1);

    const rc = await hook(body('2.0.0-rc.1'));
    expect(await rc.json()).toMatchObject({ level: 'rc', recipients: 0 });
    const major = await hook(body('2.0.0'));
    expect(await major.json()).toMatchObject({ level: 'major', recipients: 2 });
    expect((await hook(JSON.stringify({ version: '2.0.1', url: 'http://insecure.example' }))).status).toBe(400);
    expect((await hook(JSON.stringify({ version: 'two', url: 'https://x.example' }))).status).toBe(400);
  });
});

// ---- sending ----------------------------------------------------------------------------------------

describe('sending an issue', () => {
  it('each recipient gets their own copy with one-click unsubscribe headers and the footer', async () => {
    E = base({ NEWSLETTER_POSTAL_ADDRESS: 'worca, Example Street 1, 10115 Berlin' });
    const a = addr();
    const b = addr();
    const none = addr();
    const ida = await seed(a, 'micro', false);
    await seed(b, 'rc', false);
    await seed(none, 'major', true);
    const q = await queueReleaseIssue(E, { version: '1.9.1-rc.1', url: 'https://github.com/x/releases/1', notes: 'Fixes & <things>' });
    expect(q).toMatchObject({ duplicate: false, level: 'rc', recipients: 1 });
    const q2 = await queueReleaseIssue(E, { version: '1.9.1', url: 'https://github.com/x/releases/2', notes: 'Fixes & <things>' });
    expect(q2).toMatchObject({ level: 'minor' }); // first stable announced, not x.0.0
    const r = await sendIssueBatch(E, q2.issueId, '', { notes: 'Fixes & <things>' });
    expect(r).toMatchObject({ state: 'progress', sent: 2, last: true });

    const [mail] = await mails(a);
    expect(mail).toMatchObject({ kind: 'newsletter', from: 'worca <news@worca.dev>', subject: 'Worca 1.9.1 is out', ref: `newsletter:${ida}:${q2.issueId}` });
    const token = fragment(mail!.text, 't');
    expect(await subscriberForToken(E, token)).toMatchObject({ id: ida });
    expect(mail!.headers).toEqual({
      'List-Unsubscribe': `<${ORIGIN()}/api/public/newsletter/unsubscribe?t=${encodeURIComponent(token)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail!.text).toContain('You get this because you subscribed at example.com');
    expect(mail!.text).toContain(`Unsubscribe: ${ORIGIN()}/newsletter#t=`);
    expect(mail!.text).toContain('Example Street 1');
    expect(mail!.html).toContain('Fixes &amp; &lt;things&gt;');
    expect(mail!.html).not.toContain('<things>');
    expect(mail!.html).toContain('Manage preferences');
    expect(mail!.html).toContain('Example Street 1');
    expect((await mails(b)).length).toBe(1);
    expect((await mails(none)).length).toBe(0);
    expect(await E.DB.prepare('SELECT sent_count FROM newsletter_issues WHERE id = ?').bind(q2.issueId).first('sent_count')).toBe(2);
    const counted = await E.DB.prepare("SELECT count FROM mail_daily WHERE day = ? AND kind = 'newsletter'").bind(utcDay(Date.now())).first('count');
    expect(counted).toBe(2);
  });

  it('leaves the postal line out when NEWSLETTER_POSTAL_ADDRESS is unset', async () => {
    const a = addr();
    await seed(a, 'major', false);
    const q = await queueReleaseIssue(E, { version: '3.0.0', url: 'https://github.com/x/releases/3' });
    await sendIssueBatch(E, q.issueId, '');
    const [mail] = await mails(a);
    expect(mail!.text.trimEnd().split('\n').at(-1)).toMatch(/^Unsubscribe: /);
  });

  it('sends through Resend as a batch with headers and an idempotency key', async () => {
    const a = addr();
    await seed(a, 'major', false);
    const q = await queueReleaseIssue(E, { version: '4.0.0', url: 'https://github.com/x/releases/4' });
    const calls: { url: string; headers: Headers; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ data: [{ id: 're_batch_1' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await sendIssueBatch(base({ RESEND_API_KEY: 're_test', LOCAL_DEV: undefined }), q.issueId, '');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails/batch');
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(new RegExp(`^newsletter-${q.issueId}-nl_`));
    const [sent] = calls[0]!.body as { from: string; to: string[]; headers: Record<string, string> }[];
    expect(sent).toMatchObject({ from: 'worca <news@worca.dev>', to: [a], reply_to: ['hello@example.com'] });
    expect(Object.keys(sent!.headers).sort()).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
    expect(await E.DB.prepare('SELECT ref FROM mail_messages WHERE email_id = ?').bind('re_batch_1').first('ref')).toMatch(/^newsletter:nl_/);
  });
});

describe('quota reserve', () => {
  it.each([
    [{ today: 0, monthToDate: 0 }, 70],
    [{ today: 60, monthToDate: 60 }, 10],
    [{ today: 70, monthToDate: 70 }, 0],
    [{ today: 95, monthToDate: 95 }, 0],
    [{ today: 0, monthToDate: 2965 }, 5],
  ])('usage %j leaves %i newsletter mails', (usage, left) => {
    expect(allowanceFrom(usage, { daily: 100, monthly: 3000 })).toBe(left);
  });

  it('keeps QUOTA_RESERVE mails a day for transactional mail', () => {
    expect(QUOTA_RESERVE).toBeGreaterThanOrEqual(30);
    expect(allowanceFrom({ today: 0, monthToDate: 0 }, { daily: 1000, monthly: 50000 })).toBe(100); // one batch at most
  });

  it('the Workflow sleeps until the next UTC day when the quota is used up, then carries on', async () => {
    const a = addr();
    await seed(a, 'major', false);
    const q = await queueReleaseIssue(E, { version: '5.0.0', url: 'https://github.com/x/releases/5' });
    const today = utcDay(Date.now());
    await E.DB.prepare("INSERT INTO mail_daily (day, kind, count) VALUES (?, 'sign_in_code', 70)").bind(today).run();
    expect(await sendIssueBatch(E, q.issueId, '')).toMatchObject({ state: 'wait' });

    const steps: string[] = [];
    const sleeps: number[] = [];
    const result = await runNewsletterSend(
      E,
      { issueId: q.issueId },
      async (name, fn) => {
        steps.push(name);
        return fn();
      },
      async (_name, ms) => {
        sleeps.push(ms);
        await E.DB.prepare('DELETE FROM mail_daily').run(); // a new day
      },
    );
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(86_400_000 + 60_000);
    expect(result).toEqual({ state: 'sent', sent: 1 });
    expect(steps).toEqual(['batch 0', 'batch 1', 'finish']);
    expect(await E.DB.prepare('SELECT status FROM newsletter_issues WHERE id = ?').bind(q.issueId).first('status')).toBe('sent');
    expect((await mails(a)).length).toBe(1);
  });

  it('marks the issue failed when a batch keeps failing', async () => {
    await seed(addr(), 'major', false);
    const q = await queueReleaseIssue(E, { version: '6.0.0', url: 'https://github.com/x/releases/6' });
    const broken = base({ RESEND_API_KEY: undefined, LOCAL_DEV: undefined }); // no transport: sends throw
    const result = await runNewsletterSend(broken, { issueId: q.issueId }, async (_n, fn) => fn(), async () => {});
    expect(result.state).toBe('failed');
    expect(await E.DB.prepare('SELECT status FROM newsletter_issues WHERE id = ?').bind(q.issueId).first('status')).toBe('failed');
  });
});

// ---- bounces, upkeep ----------------------------------------------------------------------------------

describe('bounces and complaints', () => {
  const SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`;
  async function event(type: string, emailId: string) {
    const raw = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId } });
    const id = `msg_${crypto.randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    return call(
      '/api/webhooks/resend',
      { method: 'POST', body: raw, headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': await signSvix(SECRET, id, ts, raw), 'content-type': 'application/json' } },
      base({ RESEND_WEBHOOK_SECRET: SECRET }),
    );
  }

  it.each(['email.bounced', 'email.complained'])('%s on a newsletter mail suppresses the subscriber', async (type) => {
    const id = await seed(addr(), 'minor', true);
    const other = await seed(addr(), 'minor', true);
    await recordSentMail(E, { emailId: `re_${type}`, ref: `newsletter:${id}:issue-1`, kind: 'newsletter' });
    await recordSentMail(E, { emailId: `re_${type}_ok`, ref: `newsletter:${other}:issue-1`, kind: 'newsletter' });
    expect((await event(type, `re_${type}`)).status).toBe(200);
    expect((await event('email.delivered', `re_${type}_ok`)).status).toBe(200);
    const statuses = await E.DB.prepare('SELECT id, status FROM newsletter_subscribers').all<{ id: string; status: string }>();
    expect(Object.fromEntries(statuses.results.map((r) => [r.id, r.status]))).toEqual({ [id]: 'suppressed', [other]: 'active' });
    expect(await countRecipients(E, { kind: 'release', release_level: 'major' })).toBe(1);
  });
});

describe('upkeep', () => {
  it('deletes unconfirmed subscribers (and their keys) after 30 days; keeps everyone else', async () => {
    const old = await seed(addr(), 'minor', true, 'unconfirmed');
    const recent = await seed(addr(), 'minor', true, 'unconfirmed');
    const oldActive = await seed(addr(), 'minor', true, 'active');
    const past = Date.now() - UNCONFIRMED_TTL_MS - 86_400_000;
    await E.DB.prepare('UPDATE newsletter_subscribers SET created_at = ?, updated_at = ? WHERE id IN (?, ?)').bind(past, past, old, oldActive).run();
    expect(await pruneUnconfirmed(E)).toBe(1);
    const ids = (await E.DB.prepare('SELECT id FROM newsletter_subscribers').all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(ids).toEqual([recent, oldActive].sort());
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM data_keys WHERE owner_type = 'user' AND owner_id = ?").bind(old).first('n')).toBe(0);
  });
});

// ---- account card and console ------------------------------------------------------------------------

function harness() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user');
    c.set('requestId', 'test');
    c.set('user', id ? { id, email: c.req.header('x-test-email') ?? 'x@example.com', name: 'x', status: 'active' } : null);
    c.set(
      'session',
      id ? { id: 's', userId: id, method: 'passkey', mfa: c.req.header('x-test-mfa') !== '0', ssoOrgId: null, expiresAt: Date.now() + 3_600_000, activeOrganizationId: null } : null,
    );
    await next();
  });
  app.route('/api/me/newsletter', meNewsletterApp);
  app.route('/api/platform/newsletter', platformNewsletterApp);
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: err.message }, status as 400);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });
  return (path: string, init: RequestInit & { user?: string; email?: string; mfa?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    if (init.user) headers.set('x-test-user', init.user);
    if (init.email) headers.set('x-test-email', init.email);
    if (init.mfa === false) headers.set('x-test-mfa', '0');
    return app.request(path, { ...init, headers }, E);
  };
}

describe('/api/me/newsletter (account card)', () => {
  const h = harness();
  it('shows the status, subscribes directly (verified address, no mail), changes and unsubscribes', async () => {
    const email = addr();
    const user = crypto.randomUUID();
    expect((await h('/api/me/newsletter')).status).toBe(401);
    expect(await (await h('/api/me/newsletter', { user, email })).json()).toEqual({ subscribed: false, status: null, releases: 'minor', product: true });

    const put = (body: unknown) => h('/api/me/newsletter', { method: 'PUT', user, email, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await put({ releases: 'micro', product: false })).json()).toEqual({ subscribed: true, status: 'active', releases: 'micro', product: false });
    expect(await row(email)).toMatchObject({ status: 'active', source: 'account' });
    expect(await mails(email)).toEqual([]);
    expect(await (await put({ releases: 'none', product: true })).json()).toMatchObject({ subscribed: true, releases: 'none', product: true });
    expect(await (await put({ releases: 'none', product: false })).json()).toMatchObject({ subscribed: false, status: 'unsubscribed' });
    expect((await put({ releases: 'sometimes', product: false })).status).toBe(400);
    // A subscription made on the website shows up on the account by address.
    const web = addr();
    await activeSubscriber(web, 'rc', false);
    expect(await (await h('/api/me/newsletter', { user: crypto.randomUUID(), email: web.toUpperCase() })).json()).toMatchObject({ subscribed: true, releases: 'rc' });
  });
});

describe('GET /api/platform/newsletter (console)', () => {
  const h = harness();
  it('admins and superadmins with MFA see counts and recent issues; support and others do not', async () => {
    await seed(addr(), 'minor', true);
    await seed(addr(), 'rc', false);
    await seed(addr(), 'major', true, 'unsubscribed');
    await queueReleaseIssue(E, { version: '7.0.0', url: 'https://github.com/x/releases/7' });

    const admin = await staffUser('admin');
    const res = await h('/api/platform/newsletter', { user: admin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscribers: unknown; issues: { version: string; level: string; recipients: number; status: string }[] };
    expect(body.subscribers).toEqual({
      total: 3,
      byStatus: { unconfirmed: 0, active: 2, unsubscribed: 1, suppressed: 0 },
      active: { releases: { none: 0, major: 0, minor: 1, micro: 0, rc: 1 }, product: 1 },
    });
    expect(body.issues).toEqual([expect.objectContaining({ version: '7.0.0', level: 'major', recipients: 2, status: 'sending', sent: 0 })]);
    expect(JSON.stringify(body)).not.toContain('@');

    expect((await h('/api/platform/newsletter', { user: await staffUser('superadmin') })).status).toBe(200);
    expect((await h('/api/platform/newsletter', { user: await staffUser('support') })).status).toBe(403);
    expect((await h('/api/platform/newsletter', { user: await staffUser(null) })).status).toBe(403);
    expect((await h('/api/platform/newsletter', { user: admin, mfa: false })).status).toBe(403);
    expect((await h('/api/platform/newsletter')).status).toBe(401);
  });
});

// ---- retention (shredding), account deletion, no addresses in KV keys --------------------------------

const keyCount = (id: string) => E.DB.prepare("SELECT COUNT(*) AS n FROM data_keys WHERE owner_type = 'user' AND owner_id = ?").bind(id).first('n');

describe('address retention', () => {
  it('keeps an unsubscribed address 30 days (undo works), then shreds it: key gone, email NULL, index kept', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    const oneClick = `/api/public/newsletter/unsubscribe?t=${encodeURIComponent(token)}`;
    await call(oneClick, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
    const r1 = (await row(email))!;
    expect(r1.shred_after).toBeGreaterThan(Date.now() + SHRED_AFTER_MS - 60_000);
    expect(await shredExpired(E)).toBe(0); // not yet
    // Undo from the manage page within the 30 days.
    const undo = await post('/api/public/newsletter/prefs/update', { token, releases: 'minor', product: true });
    expect(await undo.json()).toMatchObject({ status: 'active' });
    expect((await row(email))!.shred_after).toBeNull();

    await call(oneClick, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
    const before = (await row(email))!;
    expect(await keyCount(before.id)).toBe(1);
    expect(await shredExpired(E, Date.now() + SHRED_AFTER_MS + 86_400_000)).toBe(1);
    const shredded = (await row(email))!;
    expect(shredded).toMatchObject({ id: before.id, email: null, status: 'unsubscribed', email_index: before.email_index });
    expect(await keyCount(before.id)).toBe(0);
    expect((await post('/api/public/newsletter/prefs', { token })).status).toBe(410);

    // Signing up again: double opt-in again, a fresh address under a new id and key.
    await post('/api/public/newsletter/subscribe', { email, releases: 'rc', product: false });
    const fresh = (await row(email))!;
    expect(fresh.id).not.toBe(before.id);
    expect(fresh.status).toBe('unsubscribed'); // until confirmed
    expect(await keyCount(fresh.id)).toBe(1);
    expect(await getKeyRing(E).decrypt(emailField(fresh.id), fresh.email!)).toBe(email);
    const confirm = fragment((await mails(email)).at(-1)!.text, 'c');
    const res = await post('/api/public/newsletter/confirm', { token: confirm });
    expect(res.status).toBe(200);
    expect(await row(email)).toMatchObject({ id: fresh.id, status: 'active', releases: 'rc', shred_after: null });
  });

  it('an address re-entered on the public form but never confirmed is shredded again', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    await post('/api/public/newsletter/unsubscribe-all', { token });
    await shredExpired(E, Date.now() + SHRED_AFTER_MS + 1000);
    // Anyone can type the address in again; without a confirmation it must not be kept.
    await post('/api/public/newsletter/subscribe', { email, releases: 'minor', product: true });
    const restored = (await row(email))!;
    expect(restored.email).not.toBeNull();
    expect(restored.shred_after).toBeGreaterThan(Date.now() + SHRED_AFTER_MS - 60_000);
    expect(await shredExpired(E, Date.now() + 2 * SHRED_AFTER_MS + 2000)).toBe(1);
    expect(await row(email)).toMatchObject({ id: restored.id, email: null, status: 'unsubscribed' });
    expect(await keyCount(restored.id)).toBe(0);
  });

  it('a suppressed address is shredded too and stays suppressed (nothing sent on sign-up)', async () => {
    const email = addr();
    const id = await seed(email, 'minor', true);
    await recordSentMail(E, { emailId: 're_shred_bounce', ref: `newsletter:${id}:x`, kind: 'newsletter' });
    const { suppressForMail } = await import('../../../packages/platform/src/control/newsletter/core');
    expect(await suppressForMail(E, 're_shred_bounce')).toBe(true);
    expect(await shredExpired(E, Date.now() + SHRED_AFTER_MS + 1000)).toBe(1);
    expect(await row(email)).toMatchObject({ email: null, status: 'suppressed' });
    await post('/api/public/newsletter/subscribe', { email, releases: 'minor', product: true });
    expect(await mails(email)).toEqual([]);
    expect(await row(email)).toMatchObject({ id, email: null, status: 'suppressed' });
  });

  it('the account page re-subscribes a shredded address with a new key', async () => {
    const email = addr();
    const token = await activeSubscriber(email);
    await post('/api/public/newsletter/unsubscribe-all', { token });
    await shredExpired(E, Date.now() + SHRED_AFTER_MS + 1000);
    const old = (await row(email))!;
    const h = harness();
    const res = await h('/api/me/newsletter', { method: 'PUT', user: crypto.randomUUID(), email, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releases: 'major', product: false }) });
    expect(await res.json()).toMatchObject({ subscribed: true, status: 'active' });
    const now = (await row(email))!;
    expect(now.id).not.toBe(old.id);
    expect(await getKeyRing(E).decrypt(emailField(now.id), now.email!)).toBe(email);
  });
});

describe('account deletion', () => {
  it('removes the account address from the newsletter (row and key)', async () => {
    const email = addr();
    await activeSubscriber(email);
    const sub = (await row(email))!;
    const userId = crypto.randomUUID();
    const ring = getKeyRing(E);
    await insertRow('user', {
      id: userId,
      name: await ring.encrypt({ table: 'user', column: 'name', rowId: userId, owner: { type: 'user', id: userId } }, 'X'),
      email: await ring.encrypt({ table: 'user', column: 'email', rowId: userId, owner: { type: 'user', id: userId } }, email),
      emailIndex: await ring.emailIndex(email),
      emailVerified: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await purgeUser(E, userId, { id: userId, role: 'user' });
    expect(await row(email)).toBeNull();
    expect(await keyCount(sub.id)).toBe(0);
  });
});

describe('no plain addresses in KV keys', () => {
  it('per-address limits key on the blind index', async () => {
    const email = addr();
    await activeSubscriber(email);
    await post('/api/public/newsletter/subscribe', { email, releases: 'minor', product: true });
    await post('/api/public/newsletter/link', { email });
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await E.KV.list({ cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    // dev:mail:<to> is the local-dev mail capture (LOCAL_DEV only, never deployed).
    const leaking = keys.filter((k) => !k.startsWith('dev:mail:') && k.toLowerCase().includes(email.split('@')[0]!.toLowerCase()));
    expect(leaking).toEqual([]);
    expect(keys.some((k) => k.startsWith('nl:link:') || k.startsWith('nl:confirm:'))).toBe(true);
  });
});
