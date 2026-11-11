// End-to-end building blocks: people (a browser + an authenticator), sign-in by email code and
// passkey, the first superadmin, registration codes, orgs, teams, invitations, instances.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Browser } from './browser.mjs';
import { APP_ORIGIN, CONTROL_PORT, STUB_ORIGIN, instanceOrigin, readDevVars } from './config.mjs';
import { request } from './http.mjs';
import { extractCode, extractLink, mailMark, waitForMail } from './mail.mjs';
import { VirtualAuthenticator, registerPasskey, signInWithPasskey } from './webauthn.mjs';

export const AUTH = `${APP_ORIGIN}/api/auth`;
export const API = `${APP_ORIGIN}/api`;
export const SUPERADMIN_EMAIL = process.env.E2E_SUPERADMIN_EMAIL || 'superadmin@e2e.test';

const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
let seq = 0;
/**
 * A fresh address per call, unique across runs. With E2E_EMAIL_BASE (a real mailbox, test/smoke)
 * it is a plus-address of that mailbox.
 */
export const uniqueEmail = (prefix = 'user') => {
  const tag = `${prefix}-${RUN}-${++seq}`;
  const base = process.env.E2E_EMAIL_BASE;
  if (!base) return `${tag}@e2e.test`;
  const [local, domain] = base.split('@');
  return `${local}+${tag}@${domain}`;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; returns that value. */
export async function eventually(fn, { timeoutMs = 30_000, intervalMs = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(intervalMs);
  }
}

/** Throws with the response described unless the status is one of `ok`. */
export function expectStatus(res, ok, what = '') {
  const list = Array.isArray(ok) ? ok : [ok];
  assert.ok(list.includes(res.status), `${what ? `${what}: ` : ''}expected ${list.join('/')}, got ${res.describe()}`);
  return res;
}

export class Person {
  constructor(email, label) {
    this.email = email;
    this.browser = new Browser(label ?? email.split('@')[0]);
    this.authenticator = new VirtualAuthenticator();
    this.id = null;
  }

  get(path, opts) {
    return this.browser.fetch(path.startsWith('http') ? path : `${APP_ORIGIN}${path}`, opts);
  }
  post(path, body, opts = {}) {
    return this.browser.fetch(path.startsWith('http') ? path : `${APP_ORIGIN}${path}`, { method: 'POST', body: body ?? {}, ...opts });
  }
  put(path, body, opts = {}) {
    return this.browser.fetch(`${APP_ORIGIN}${path}`, { method: 'PUT', body: body ?? {}, ...opts });
  }
  patch(path, body, opts = {}) {
    return this.browser.fetch(`${APP_ORIGIN}${path}`, { method: 'PATCH', body: body ?? {}, ...opts });
  }
  del(path, body, opts = {}) {
    return this.browser.fetch(`${APP_ORIGIN}${path}`, { method: 'DELETE', body, ...opts });
  }

  async me() {
    const res = await this.get('/api/me');
    return res.status === 200 ? res.json() : null;
  }

  /**
   * Email-code sign-in (creates the account on first use, subject to the registration mode).
   * Returns the /sign-in/email-otp response; doesn't throw on refusal.
   */
  async signInWithCode({ signupCode } = {}) {
    const before = await mailMark(this.email);
    const send = await this.post(`${AUTH}/email-otp/send-verification-otp`, { email: this.email, type: 'sign-in' });
    expectStatus(send, 200, 'send-verification-otp');
    const mail = await waitForMail(this.email, { after: before, match: (m) => /code/i.test(m.subject) });
    const headers = signupCode ? { 'x-signup-code': signupCode } : {};
    const res = await this.post(`${AUTH}/sign-in/email-otp`, { email: this.email, otp: extractCode(mail) }, { headers });
    if (res.status === 200) this.id = res.json().user?.id ?? this.id;
    return res;
  }

  /** Adds a passkey (needs a fresh session) and signs in again with it, giving an MFA session (D24). */
  async upgradeToPasskey() {
    await registerPasskey(this.browser, this.authenticator);
    return this.signInWithPasskey();
  }

  async signInWithPasskey() {
    const out = await signInWithPasskey(this.browser, this.authenticator);
    this.id = out.user?.id ?? this.id;
    const me = await this.me();
    assert.equal(me?.session?.mfa, true, `passkey session should count as MFA: ${JSON.stringify(me)}`);
    return out;
  }

  async signOut() {
    return this.browser.fetch(`${APP_ORIGIN}/sign-out`, { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
}

// ---- platform -----------------------------------------------------------------------------------

let superadmin = null;

// Better Auth lets an account that already has a passkey add another only from a passkey session,
// so the superadmin's virtual passkey is kept between test processes and runs (per control port).
const SA_KEY_FILE = new URL(
  `../../../.wrangler/e2e/superadmin-passkey-${process.env.E2E_APP_ORIGIN ? new URL(APP_ORIGIN).hostname : CONTROL_PORT}.json`,
  import.meta.url,
);

function loadSuperadminKey(p) {
  try {
    if (!existsSync(SA_KEY_FILE)) return false;
    const saved = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8'));
    if (saved.email !== p.email) return false;
    p.authenticator.import(saved.credentials);
    return true;
  } catch {
    return false;
  }
}

function saveSuperadminKey(p) {
  mkdirSync(new URL('.', SA_KEY_FILE), { recursive: true });
  writeFileSync(SA_KEY_FILE, JSON.stringify({ email: p.email, credentials: p.authenticator.export() }), { mode: 0o600 });
}

/**
 * The e2e superadmin with a passkey (MFA) session. Bootstraps with SETUP_TOKEN on a fresh database;
 * on later runs (409 already_initialized) signs in as SUPERADMIN_EMAIL, which must be the
 * superadmin of this database.
 */
export async function getSuperadmin() {
  if (superadmin) return superadmin;
  const p = new Person(SUPERADMIN_EMAIL, 'superadmin');
  let signedIn = false;
  // The saved passkey first: POST /api/setup is rate limited (5 per 15 minutes), so repeated runs
  // against a deployed stack only bootstrap when they have to.
  if (loadSuperadminKey(p)) {
    try {
      await p.signInWithPasskey();
      signedIn = true;
    } catch {
      p.authenticator.credentials = []; // a key from an earlier database
    }
  }
  if (!signedIn) {
    const token = readDevVars().SETUP_TOKEN;
    assert.ok(token, 'SETUP_TOKEN missing from .dev.vars');
    const setup = await request(`${API}/setup`, { method: 'POST', body: { token, email: SUPERADMIN_EMAIL, name: 'E2E Superadmin' } });
    expectStatus(setup, [200, 409], 'POST /api/setup');
    expectStatus(await p.signInWithCode(), 200, 'superadmin email-code sign-in');
    try {
      await p.upgradeToPasskey();
    } catch (e) {
      throw new Error(
        `cannot give ${SUPERADMIN_EMAIL} a passkey session (${e.message}). Its saved virtual passkey ` +
          `(${SA_KEY_FILE.pathname}) is missing or from another database; reset the local database or set E2E_SUPERADMIN_EMAIL.`,
      );
    }
  }
  saveSuperadminKey(p);
  const me = await p.me();
  assert.ok(me?.platformRoles?.includes('superadmin'), `${SUPERADMIN_EMAIL} is not the superadmin of this database (set E2E_SUPERADMIN_EMAIL); /api/me: ${JSON.stringify(me)}`);
  superadmin = p;
  return p;
}

export async function createRegistrationCode({ tier = 'free', uses = 1 } = {}) {
  const sa = await getSuperadmin();
  const res = expectStatus(await sa.post('/api/platform/registration/codes', { tier, uses }), 201, 'create registration code');
  return res.json().code;
}

export async function getRegistrationMode() {
  const sa = await getSuperadmin();
  return expectStatus(await sa.get('/api/platform/registration'), 200).json().mode;
}

export async function setRegistrationMode(mode) {
  const sa = await getSuperadmin();
  expectStatus(await sa.put('/api/platform/registration', { mode }), 200, `set registration mode ${mode}`);
}

/** Runs `fn` with the registration mode set to `mode`, restoring the previous one afterwards. */
export async function withRegistrationMode(mode, fn) {
  const prev = await getRegistrationMode();
  await setRegistrationMode(mode);
  try {
    return await fn();
  } finally {
    await setRegistrationMode(prev);
  }
}

// ---- tenants ------------------------------------------------------------------------------------

/** A new active account through a registration code. */
export async function signUp(prefix = 'user', { passkey = false } = {}) {
  const p = new Person(uniqueEmail(prefix));
  const code = await createRegistrationCode();
  expectStatus(await p.signInWithCode({ signupCode: code }), 200, `sign-up of ${p.email}`);
  if (passkey) await p.upgradeToPasskey();
  return p;
}

/** A tenant admin (with a passkey session) and their new org. */
export async function newTenant(prefix = 'admin') {
  const admin = await signUp(prefix, { passkey: true });
  const res = expectStatus(await admin.post('/api/orgs', { name: `Org of ${admin.email}` }), 201, 'create org');
  return { admin, orgId: res.json().id, orgName: `Org of ${admin.email}` };
}

export async function createTeam(admin, orgId, name = 'Team') {
  const res = expectStatus(await admin.post(`/api/orgs/${orgId}/teams`, { name }), 201, 'create team');
  return res.json().id;
}

export async function addToTeam(admin, orgId, teamId, userId) {
  expectStatus(await admin.post(`/api/orgs/${orgId}/teams/${teamId}/members`, { userId }), 201, 'add team member');
}

export async function removeFromTeam(admin, orgId, teamId, userId) {
  expectStatus(await admin.del(`/api/orgs/${orgId}/teams/${teamId}/members/${userId}`), 200, 'remove team member');
}

/**
 * Invites a new address, signs that person in (the pending invitation lets them register in any
 * mode), accepts through the emailed link, returns the Person.
 */
/** Invites a new person (or `person`, an existing signed-in Person) to the org and joins them. */
export async function inviteAndJoin(admin, orgId, prefix = 'member', { role = 'tenant_user', teamId, person } = {}) {
  const p = person ?? new Person(uniqueEmail(prefix));
  const before = await mailMark(p.email);
  const inv = expectStatus(await admin.post(`/api/orgs/${orgId}/invitations`, { email: p.email, role, ...(teamId ? { teamId } : {}) }), 201, 'invite');
  const mail = await waitForMail(p.email, { after: before, match: (m) => /invit/i.test(m.subject) });
  const link = extractLink(mail, '/invite/');
  assert.ok(link.includes(inv.json().id), 'invitation link carries the invitation id');
  if (!person) expectStatus(await p.signInWithCode(), 200, 'invitee sign-in');
  const page = await p.browser.fetch(link, { navigate: true });
  expectStatus(page, 200, 'invitation page');
  const accept = await p.browser.fetch(link, { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' }, navigate: true });
  expectStatus(accept, [302, 303], 'accept invitation');
  const me = await p.me();
  assert.ok(me.orgs.some((o) => o.id === orgId), `joined org: ${JSON.stringify(me.orgs)}`);
  p.id = me.user.id;
  return p;
}

// ---- instances ----------------------------------------------------------------------------------

export async function getInstance(person, orgId, id) {
  const res = await person.get(`/api/orgs/${orgId}/instances/${id}`);
  return res.status === 200 ? res.json() : null;
}

export async function waitForStatus(person, orgId, id, status, timeoutMs = 60_000) {
  return eventually(
    async () => {
      const inst = await getInstance(person, orgId, id);
      return inst?.status === status ? inst : false;
    },
    { timeoutMs, what: `instance ${id} to be ${status}` },
  );
}

/**
 * Creates an instance in `teamId` (also granted to `teamIds`) and waits until it runs. An instance
 * always has a team (D71): without one given, a team of its own is created for it.
 */
export async function createRunningInstance(admin, orgId, { name = `inst-${RUN}`, teamId, teamIds = [] } = {}) {
  const team = teamId ?? teamIds[0] ?? (await createTeam(admin, orgId, `${name} team`));
  const res = expectStatus(await admin.post(`/api/orgs/${orgId}/instances`, { name, teamId: team, teamIds }), 201, 'create instance');
  const created = res.json();
  const running = await waitForStatus(admin, orgId, created.id, 'running');
  await waitForGateHost(running.host);
  return { ...running, name };
}

/**
 * The status turns `running` on the first heartbeat, before the create Workflow writes the gate's
 * hostname entries (its next poll, up to 10 s later); waits until the gate knows the host (a 401
 * for an API call instead of its 404 page).
 */
export async function waitForGateHost(host, timeoutMs = 60_000) {
  await eventually(async () => (await request(`${instanceOrigin(host)}/`, { headers: { 'sec-fetch-mode': 'cors' } })).status !== 404, {
    timeoutMs,
    what: `gate to serve ${host}`,
  });
}

/** Stub admin view of an instance ({ state, variables, beats, ... }), or null. */
export async function stubInstance(id) {
  const res = await request(`${STUB_ORIGIN}/__admin/instances/${encodeURIComponent(id)}`);
  return res.status === 200 ? res.json() : null;
}

export async function stubAdmin(method, path, body) {
  return request(`${STUB_ORIGIN}/__admin/instances${path}`, { method, body });
}

/** What the next heartbeats report (pipelines, suspendable, nextScheduledAt, health, version). */
export async function setStubReport(id, report) {
  expectStatus(await stubAdmin('POST', `/${encodeURIComponent(id)}/state`, report), 200, 'stub state');
}

/**
 * A full instance sign-in as a browser: visit → /authorize → (signed in already) → callback →
 * back to the path. Returns { hops, final }.
 */
export async function visitInstance(person, host, path = '/') {
  return person.browser.navigate(`${instanceOrigin(host)}${path}`);
}

/** Signs `person` in to the instance and returns the stub's echo of `path`. */
export async function signInToInstance(person, host, path = '/') {
  let { hops, final } = await visitInstance(person, host, path);
  if (final.status === 503 && /starting/i.test(final.text)) {
    // Idle-suspended meanwhile (E2E_FAST idles after 20 s): the visit woke it; wait like the page does.
    await eventually(async () => {
      const s = await instanceFetch(person, host, '/.gate/status');
      return s.status === 200 && s.json().status === 'running';
    }, { timeoutMs: 60_000, what: `${host} to wake` });
    final = await person.browser.fetch(`${instanceOrigin(host)}${path}`, { navigate: true });
    hops = [...hops, final];
  }
  assert.equal(final.status, 200, `instance sign-in ended with ${final.describe()}; hops: ${hops.map((h) => `${h.status} ${h.url}`).join(' -> ')}`);
  return { hops, final, echo: final.json() };
}

/** Same-origin request on an instance, as worca's own JavaScript would make it. */
export function instanceFetch(person, host, path, opts = {}) {
  return person.browser.fetch(`${instanceOrigin(host)}${path}`, opts);
}

/**
 * Starts an instance deletion (the admin needs a passkey session, D24) and returns the link of the
 * emailed confirmation (D30).
 */
export async function deleteInstanceConfirmed(admin, orgId, inst) {
  const before = await mailMark(admin.email);
  const res = expectStatus(await admin.post(`/api/orgs/${orgId}/instances/${inst.id}/delete`, { confirmName: inst.name }), 202, 'start delete');
  assert.equal(res.json().status, 'confirmation_sent');
  const mail = await waitForMail(admin.email, { after: before, match: (m) => /confirm/i.test(m.subject) });
  return extractLink(mail, '/confirm/');
}

/** Submits a confirmation page's form like a browser (POST, form-encoded, Origin = app). */
export async function submitConfirmation(person, link) {
  const u = new URL(link);
  const t = u.searchParams.get('t');
  return person.browser.fetch(`${u.origin}${u.pathname}`, {
    method: 'POST',
    body: new URLSearchParams({ t }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    navigate: true,
  });
}

/**
 * A tenant with a team, a tenant user in that team (signed in to the control plane), and a running
 * instance granted to the team.
 */
export async function instanceFixture(prefix = 'fx') {
  const { admin, orgId } = await newTenant(`${prefix}-admin`);
  const teamId = await createTeam(admin, orgId, `${prefix} team`);
  const member = await inviteAndJoin(admin, orgId, `${prefix}-member`);
  await addToTeam(admin, orgId, teamId, member.id);
  const inst = await createRunningInstance(admin, orgId, { name: `${prefix}-${RUN}`, teamId });
  return { admin, orgId, teamId, member, inst };
}

/** The gate object's state through the platform console (superadmin), or null if not exposed. */
export async function gateState(instanceId) {
  const sa = await getSuperadmin();
  const res = await sa.get(`/api/platform/instances/${instanceId}`);
  return res.status === 200 ? res.json().gate ?? null : null;
}

/** The payload of a JWT, unverified (the stub verifies; tests only read claims). */
export function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}
