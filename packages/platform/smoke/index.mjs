// @worca/platform/smoke: one instance end to end against a running deployment. Signs in as the
// smoke account (the first superadmin on a fresh deployment, made with SETUP_TOKEN), creates an
// instance in a "Smoke test" org, waits until it runs, signs in to it through the gate like a
// browser, then deletes it through the emailed confirmation and waits until it is gone.
//
// Mail is read through an inbox reader: { getMail(to) → [{ subject, text, html, at, id? }] }.
// devCaptureInbox() reads a local stack's mail capture; for a deployed stack pass your own (a
// module exporting getMail, e.g. over your mail provider's API).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Browser } from './browser.mjs';
import { request } from './http.mjs';
import { VirtualAuthenticator, registerPasskey, signInWithPasskey } from './webauthn.mjs';

export const SMOKE_ORG = 'Smoke test';

/** A local stack's mail capture (LOCAL_DEV, no RESEND_API_KEY): GET /__dev/mail?to=. */
export function devCaptureInbox(appOrigin) {
  return {
    async getMail(to) {
      const res = await request(`${appOrigin}/__dev/mail?to=${encodeURIComponent(to)}`);
      if (res.status !== 200) throw new Error(`mail capture: ${res.describe()}`);
      const body = res.json();
      return Array.isArray(body) ? body : body.mail ?? body.messages ?? [];
    },
  };
}

/** An inbox reader from a module file that exports getMail (or a default with getMail). */
export async function moduleInbox(file) {
  const mod = await import(pathToFileURL(file).href);
  const getMail = mod.getMail ?? mod.default?.getMail;
  if (typeof getMail !== 'function') throw new Error(`${file} exports no getMail(to)`);
  return { getMail };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mailKey = (m) => m.id ?? `${m.at}|${m.subject}|${m.text}`;

/**
 * Runs the smoke. Options:
 *   appOrigin        the control plane, e.g. https://app.example.com
 *   instanceOrigin   (host) => origin of an instance, e.g. h => `https://${h}`
 *   email            the smoke account (the superadmin on a fresh deployment)
 *   inbox            an inbox reader for that address
 *   setupToken       SETUP_TOKEN, to bootstrap a deployment without a superadmin yet
 *   passkeyFile      where the smoke account's virtual passkey is kept between runs (mode 600)
 *   turnstileBypassToken   TURNSTILE_BYPASS_TOKEN, when Turnstile is on
 *   timeoutMs        how long the instance may take to run (default 30 minutes; Railway pulls images)
 *   mailTimeoutMs, pollMs, log
 */
export async function runSmoke(opts) {
  const { appOrigin, instanceOrigin, email, inbox, setupToken, passkeyFile, turnstileBypassToken } = opts;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const mailTimeoutMs = opts.mailTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2000;
  const log = opts.log ?? ((m) => console.log(m));
  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const started = Date.now();
  const timings = {};
  const lap = (name, t0) => (timings[name] = Math.round((Date.now() - t0) / 100) / 10);
  const browser = new Browser('smoke', { turnstileBypass: turnstileBypassToken ? { origin: appOrigin, token: turnstileBypassToken } : null });
  const authenticator = new VirtualAuthenticator({ origin: appOrigin });
  const api = (method, path, body) => browser.fetch(`${appOrigin}${path}`, { method, ...(body !== undefined ? { body } : {}) });
  const expect = (res, ok, what) => {
    if (![ok].flat().includes(res.status)) throw new Error(`${what}: ${res.describe()}`);
    return res;
  };
  const me = async () => {
    const r = await api('GET', '/api/me');
    return r.status === 200 ? r.json() : null;
  };
  async function eventually(what, fn, ms) {
    const deadline = Date.now() + ms;
    let last;
    for (;;) {
      last = await fn().catch((e) => e);
      if (last?.fatal) throw last;
      if (last && !(last instanceof Error)) return last;
      if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
      await sleep(pollMs);
    }
  }
  const mark = async () => new Set((await inbox.getMail(email)).map(mailKey));
  const waitForMail = (seen, match) =>
    eventually(`mail to ${email}`, async () => (await inbox.getMail(email)).filter((m) => !seen.has(mailKey(m)) && match(m)).at(-1) ?? false, mailTimeoutMs);
  const links = (m) => [...`${m.text ?? ''}\n${(m.html ?? '').replace(/&amp;/g, '&')}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0]);

  // ---- 1. the deployment answers
  let t = Date.now();
  expect(await request(`${appOrigin}/health`), 200, 'GET /health');
  log(`ok - ${appOrigin} answers`);

  // ---- 2. the smoke account, with a passkey session (deleting an instance needs one, D24)
  let signedIn = false;
  if (passkeyFile && existsSync(passkeyFile)) {
    const saved = JSON.parse(readFileSync(passkeyFile, 'utf8'));
    if (saved.email === email) {
      authenticator.import(saved.credentials);
      try {
        await signInWithPasskey(browser, authenticator);
        signedIn = true;
      } catch {
        authenticator.credentials = [];
      }
    }
  }
  if (!signedIn) {
    if (setupToken) {
      const s = await request(`${appOrigin}/api/setup`, { method: 'POST', body: { token: setupToken, email, name: 'Smoke' }, headers: { origin: appOrigin } });
      expect(s, [200, 409], 'POST /api/setup');
      if (s.status === 200) log(`ok - ${email} is the first superadmin`);
    }
    const seen = await mark();
    expect(await api('POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }), 200, 'send sign-in code');
    const mail = await waitForMail(seen, (m) => /code/i.test(m.subject));
    const code = `${mail.subject}\n${mail.text}`.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code in mail "${mail.subject}"`);
    expect(await api('POST', '/api/auth/sign-in/email-otp', { email, otp: code }), 200, `email-code sign-in of ${email}`);
    try {
      await registerPasskey(browser, authenticator);
      await signInWithPasskey(browser, authenticator);
    } catch (e) {
      throw new Error(`${email} can't get a passkey session (${e.message}). If it has a passkey from an earlier run, restore ${passkeyFile ?? 'the passkey file'} or use another address.`);
    }
    if (passkeyFile) {
      mkdirSync(dirname(passkeyFile), { recursive: true });
      writeFileSync(passkeyFile, JSON.stringify({ email, credentials: authenticator.export() }), { mode: 0o600 });
      chmodSync(passkeyFile, 0o600);
    }
  }
  const self = await me();
  if (!self?.session?.mfa) throw new Error(`no passkey session for ${email}: ${JSON.stringify(self)}`);
  lap('signIn', t);
  log(`ok - signed in as ${email} with a passkey`);

  // ---- 3. org, team, instance
  t = Date.now();
  let org = self.orgs?.find((o) => o.name === SMOKE_ORG && /admin/.test(o.role ?? 'tenant_admin'));
  const orgId = org?.id ?? expect(await api('POST', '/api/orgs', { name: SMOKE_ORG }), 201, 'create org').json().id;
  const teamId = expect(await api('POST', `/api/orgs/${orgId}/teams`, { name: `smoke ${run}` }), 201, 'create team').json().id;
  // Instances are reached through team membership (D71), admins included.
  expect(await api('POST', `/api/orgs/${orgId}/teams/${teamId}/members`, { userId: self.user.id }), 201, 'join team');
  const name = `smoke-${run}`;
  const created = expect(await api('POST', `/api/orgs/${orgId}/instances`, { name, teamId }), 201, 'create instance').json();
  log(`ok - instance ${created.id} (${name}) created`);
  let inst = null;
  const result = { instanceId: created.id, host: null, timings };
  let failure = null;
  try {
    inst = await eventually(`instance ${created.id} to run`, async () => {
      const r = await api('GET', `/api/orgs/${orgId}/instances/${created.id}`);
      if (r.status !== 200) return false;
      const i = r.json();
      if (/fail|error/.test(i.status ?? '')) throw Object.assign(new Error(`instance ${i.status}: ${JSON.stringify(i.lastError ?? i.error ?? i.operation ?? '')}`), { fatal: true });
      return i.status === 'running' ? i : false;
    }, timeoutMs);
    result.host = inst.host;
    lap('running', t);
    log(`ok - running at ${inst.host} after ${timings.running} s`);

    // ---- 4. through the gate, like a browser
    t = Date.now();
    const origin = instanceOrigin(inst.host);
    await eventually(`the gate to serve ${inst.host}`, async () => (await browser.fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'cors' } })).status !== 404, 120_000);
    const { hops, final } = await browser.navigate(`${origin}/`);
    if (final.status !== 200) throw new Error(`gate sign-in ended with ${final.describe()}; hops: ${hops.map((h) => `${h.status} ${h.url}`).join(' -> ')}`);
    lap('gate', t);
    log(`ok - signed in to ${inst.host} through the gate (${hops.length} hops)`);
  } catch (e) {
    failure = e;
    log(`not ok - ${e.message}`);
  }
  // ---- 5. delete, always: an emailed confirmation (D30), then the row disappears
  try {
    t = Date.now();
    const seen = await mark();
    const del = await api('POST', `/api/orgs/${orgId}/instances/${created.id}/delete`, { confirmName: name });
    if (del.status === 202) {
      const mail = await waitForMail(seen, (m) => /confirm/i.test(m.subject));
      const link = links(mail).find((l) => l.includes('/confirm/'));
      if (!link) throw new Error(`no confirmation link in "${mail.subject}"`);
      const u = new URL(link);
      const done = await browser.fetch(`${u.origin}${u.pathname}`, {
        method: 'POST',
        body: new URLSearchParams({ t: u.searchParams.get('t') }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        navigate: true,
      });
      if (done.status !== 200) throw new Error(`confirm delete: ${done.describe()}`);
      await eventually(`instance ${created.id} to be deleted`, async () => (await api('GET', `/api/orgs/${orgId}/instances/${created.id}`)).status === 404, timeoutMs);
      lap('delete', t);
      log(`ok - instance deleted after ${timings.delete} s`);
    } else {
      log(`not ok - delete of ${created.id} answered ${del.describe()}; delete it in the console`);
    }
    await api('DELETE', `/api/orgs/${orgId}/teams/${teamId}`).catch(() => {});
  } catch (e) {
    log(`not ok - cleanup: ${e.message}; delete instance ${created.id} in the console`);
    failure ??= e;
  }
  if (failure) throw failure;
  timings.total = Math.round((Date.now() - started) / 100) / 10;
  log(`smoke passed in ${timings.total} s`);
  return result;
}
