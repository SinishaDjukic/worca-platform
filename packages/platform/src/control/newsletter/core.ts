// Newsletter (D70): subscribers, double opt-in, signed manage tokens, release classification,
// recipient selection and the batch send the NewsletterSendWorkflow drives. Routes live in
// public/newsletter.ts (website and the /newsletter page), newsletter/routes.ts (account and
// console) and newsletter/hooks.ts (the release hook).
//
// Addresses are encrypted with the subscriber's own data key ({ type: 'user', id: <subscriber id> };
// subscriber ids start with `nl_`, so they never collide with a user id) and found by their blind
// index. Nothing about a subscriber is ever returned to someone who doesn't hold their token.
// Retention: unconfirmed rows go after 30 days (row and key); unsubscribed and suppressed rows
// keep the address for SHRED_AFTER_MS (so an unsubscribe can be undone), then it is shredded
// (key deleted, email NULL) while the blind index and status stay as a suppression list. Logs,
// audit entries, errors and KV keys never hold an address: per-address limits use the index.
import type { Env } from '../env';
import { fromBase64Url, randomToken, timingSafeEqual, toBase64Url, utf8 } from '../crypto';
import { sha256Hex, type FieldContext } from '../keys-api';
import { forgetKeyCache } from '../keys';
import { BATCH_MAX, sendEmail, sendEmailBatch, type Mail } from '../auth/email';
import { bumpCounter, readCounter } from '../auth/rate-limit';
import { mailUsage, RESEND_PLAN } from '../system/mail';
import { deps } from '../tenancy/deps';
import { confirmSubscriptionEmail, issueMail, manageLinkEmail, newsletterLinks } from './mails';

export const RELEASE_PREFS = ['none', 'major', 'minor', 'micro', 'rc'] as const;
export type ReleasePref = (typeof RELEASE_PREFS)[number];
export const RELEASE_LEVELS = ['major', 'minor', 'micro', 'rc'] as const;
export type ReleaseLevel = (typeof RELEASE_LEVELS)[number];
export type SubscriberStatus = 'unconfirmed' | 'active' | 'unsubscribed' | 'suppressed';

/** Which preferences a release of each level reaches: a preference is a threshold. */
export const LEVEL_AUDIENCE: Record<ReleaseLevel, readonly ReleasePref[]> = {
  major: ['major', 'minor', 'micro', 'rc'],
  minor: ['minor', 'micro', 'rc'],
  micro: ['micro', 'rc'],
  rc: ['rc'],
};

export const CONFIRM_TTL_MS = 7 * 86_400_000;
/** Unconfirmed subscribers are deleted after this (daily cron). */
export const UNCONFIRMED_TTL_MS = 30 * 86_400_000;
/** After the first confirmation, the same link keeps answering this long. */
export const CONFIRM_REUSE_MS = 60 * 60 * 1000;

/** Unsubscribed or suppressed: the address is shredded this long after (daily cron). */
export const SHRED_AFTER_MS = 30 * 86_400_000;
/** Mails a day (and a month) left for transactional mail: the newsletter never uses them. */
export const QUOTA_RESERVE = 30;
/** Per address and hour: confirmation mails, and manage links. */
export const CONFIRM_MAILS_PER_HOUR = 3;
export const LINK_MAILS_PER_HOUR = 1;
export const NOTES_MAX = 1500;

const MANAGE_HKDF_INFO = 'worca-run newsletter manage-token v1';

export interface SubscriberRow {
  id: string;
  email: string | null; // null once shredded
  email_index: string;
  status: SubscriberStatus;
  releases: ReleasePref;
  product: number;
  token_version: number;
  confirm_token_hash: string | null;
  confirm_expires_at: number | null;
  source: string | null;
  created_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  updated_at: number;
  shred_after: number | null;
}

export const newSubscriberId = () => `nl_${crypto.randomUUID()}`;

/** The address column's field context: the subscriber's own key. */
export const emailField = (id: string): FieldContext => ({ table: 'newsletter_subscribers', column: 'email', rowId: id, owner: { type: 'user', id } });

const ring = (env: Env) => deps().keyRing(env);

async function byIndex(env: Env, index: string): Promise<SubscriberRow | null> {
  return env.DB.prepare('SELECT * FROM newsletter_subscribers WHERE email_index = ?').bind(index).first<SubscriberRow>();
}

export async function subscriberById(env: Env, id: string): Promise<SubscriberRow | null> {
  return env.DB.prepare('SELECT * FROM newsletter_subscribers WHERE id = ?').bind(id).first<SubscriberRow>();
}

export async function findSubscriber(env: Env, email: string): Promise<SubscriberRow | null> {
  return byIndex(env, await ring(env).emailIndex(email));
}

/** The decrypted address, or null when the key is gone or the value isn't ours. */
export async function subscriberEmail(env: Env, row: Pick<SubscriberRow, 'id' | 'email'>): Promise<string | null> {
  if (!row.email) return null;
  try {
    return await ring(env).decrypt(emailField(row.id), row.email);
  } catch {
    return null;
  }
}

/** a…z@example.com: enough to recognise, not enough to learn an address from a forwarded link. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '…';
  const local = email.slice(0, at);
  return `${local[0]}${local.length > 2 ? '…' : ''}${local.length > 1 ? local.at(-1) : ''}${email.slice(at)}`;
}

/** Inserts a new subscriber; null when another request created the address meanwhile. */
async function insertSubscriber(
  env: Env,
  input: { email: string; index: string; status: SubscriberStatus; releases: ReleasePref; product: boolean; source: string | null; confirmHash: string | null; now: number },
): Promise<string | null> {
  const id = newSubscriberId();
  const r = ring(env);
  await r.ensureKey({ type: 'user', id });
  const enc = await r.encrypt(emailField(id), input.email);
  const active = input.status === 'active';
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO newsletter_subscribers
       (id, email, email_index, status, releases, product, token_version, confirm_token_hash, confirm_expires_at, source, created_at, confirmed_at, unsubscribed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      id,
      enc,
      input.index,
      input.status,
      input.releases,
      input.product ? 1 : 0,
      input.confirmHash,
      input.confirmHash ? input.now + CONFIRM_TTL_MS : null,
      input.source,
      input.now,
      active ? input.now : null,
      input.now,
    )
    .run();
  if ((res.meta.changes ?? 0) > 0) return id;
  await deleteKeys(env, [id]); // lost the race: the key we made has no row
  return null;
}

async function deleteKeys(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.prepare(`DELETE FROM data_keys WHERE owner_type = 'user' AND owner_id IN (${ids.map(() => '?').join(', ')})`)
    .bind(...ids)
    .run();
  for (const id of ids) forgetKeyCache({ type: 'user', id });
}

/**
 * A shredded row (email NULL) gets the address again under a new subscriber id, so a new data
 * key: the old key is gone, and every link to the old id stays dead. Returns the row's id.
 * `shredAfter` is when the restored address is shredded again unless the subscriber becomes
 * active: anyone can type an address into the public form, so an unconfirmed restore must not
 * keep it forever. Callers that activate the row right after pass null.
 */
async function restoreAddress(env: Env, row: SubscriberRow, email: string, shredAfter: number | null): Promise<string> {
  if (row.email) return row.id;
  const id = newSubscriberId();
  const r = ring(env);
  await r.ensureKey({ type: 'user', id });
  const enc = await r.encrypt(emailField(id), email);
  const res = await env.DB.prepare('UPDATE newsletter_subscribers SET id = ?, email = ?, token_version = 1, shred_after = ?, updated_at = ? WHERE id = ? AND email IS NULL')
    .bind(id, enc, shredAfter, Date.now(), row.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    await deleteKeys(env, [id]);
    throw new Error('subscriber changed meanwhile');
  }
  return id;
}

/** One mail per window per address and purpose; false once the limit is reached. */
async function allowMail(env: Env, purpose: 'confirm' | 'link', index: string, perHour: number, now: number): Promise<boolean> {
  const key = `nl:${purpose}:${index}:${Math.floor(now / 3_600_000)}`;
  if ((await readCounter(env.KV, key)) >= perHour) return false;
  await bumpCounter(env.KV, key, 3600);
  return true;
}

// ---- manage tokens ----------------------------------------------------------------------------

const manageKeys = new Map<string, Promise<CryptoKey>>();

/** HMAC key for manage tokens: HKDF-SHA256(BETTER_AUTH_SECRET, info MANAGE_HKDF_INFO). No new secret. */
function manageKey(env: Env): Promise<CryptoKey> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not configured');
  let k = manageKeys.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey('raw', utf8(secret) as BufferSource, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(MANAGE_HKDF_INFO) as BufferSource },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      );
    })();
    manageKeys.set(secret, k);
    k.catch(() => manageKeys.delete(secret));
  }
  return k;
}

async function manageSig(env: Env, id: string, version: number): Promise<string> {
  return toBase64Url(await crypto.subtle.sign('HMAC', await manageKey(env), utf8(`newsletter|${id}|${version}`) as BufferSource));
}

/** `<subscriber id>.<token version>.<HMAC>`; never expires, dies when token_version moves on. */
export async function manageToken(env: Env, id: string, version: number): Promise<string> {
  return `${id}.${version}.${await manageSig(env, id, version)}`;
}

/** The subscriber a manage token names, if the signature and the version still hold. */
export async function subscriberForToken(env: Env, token: unknown): Promise<SubscriberRow | null> {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^(nl_[0-9a-f-]{36})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, id, v, sig] = m as unknown as [string, string, string, string];
  const version = Number(v);
  try {
    fromBase64Url(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(sig, await manageSig(env, id, version))) return null;
  const row = await subscriberById(env, id);
  // A shredded subscriber has no live links: there is no address left to manage.
  return row && row.token_version === version && row.email ? row : null;
}

// ---- subscribe, confirm, preferences ----------------------------------------------------------

export interface SubscribeInput {
  email: string;
  releases: ReleasePref;
  product: boolean;
  source?: string | null;
}

/**
 * The public subscribe. Never tells the caller what it found (the route always answers 202):
 * new, unconfirmed or unsubscribed addresses get a confirmation mail (double opt-in), active ones
 * at most their manage link once an hour, suppressed ones (bounced, complained) nothing.
 */
export async function subscribe(env: Env, input: SubscribeInput, now = Date.now()): Promise<'confirm_sent' | 'link_sent' | 'nothing'> {
  const email = input.email.trim();
  const index = await ring(env).emailIndex(email);
  const row = await byIndex(env, index);
  if (row?.status === 'suppressed') return 'nothing';
  if (row?.status === 'active') return (await sendManageLink(env, row, email, now)) ? 'link_sent' : 'nothing';
  if (!(await allowMail(env, 'confirm', index, CONFIRM_MAILS_PER_HOUR, now))) return 'nothing';

  const token = randomToken();
  const hash = await sha256Hex(token);
  let id: string | null;
  if (row) {
    // Unconfirmed rows take the newest choice; unsubscribed ones stay unsubscribed until confirmed.
    id = await restoreAddress(env, row, email, now + SHRED_AFTER_MS);
    await env.DB.prepare(
      `UPDATE newsletter_subscribers SET releases = ?, product = ?, source = ?, confirm_token_hash = ?, confirm_expires_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('unconfirmed', 'unsubscribed')`,
    )
      .bind(input.releases, input.product ? 1 : 0, input.source ?? null, hash, now + CONFIRM_TTL_MS, now, id)
      .run();
  } else {
    id = await insertSubscriber(env, { email, index, status: 'unconfirmed', releases: input.releases, product: input.product, source: input.source ?? null, confirmHash: hash, now });
    if (!id) return 'nothing';
  }
  await sendEmail(env, { to: email, ...confirmSubscriptionEmail(env, { subscriberId: id, token, releases: input.releases, product: input.product }) });
  return 'confirm_sent';
}

/**
 * The double opt-in link, valid CONFIRM_TTL_MS. Returns the manage token on success. Opening the
 * link again answers the same (the page is often loaded twice: a mail app's preview, then the
 * browser), but only for CONFIRM_REUSE_MS after the first confirmation: each answer hands out a
 * manage token, so a forwarded or leaked confirmation mail stops working soon after. The page asks for a click before it calls this, so a link scanner can't confirm.
 */
export async function confirmSubscription(env: Env, token: unknown, now = Date.now()): Promise<string | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `UPDATE newsletter_subscribers
        SET status = 'active', confirmed_at = CASE WHEN status = 'active' THEN confirmed_at ELSE ?1 END,
            confirm_expires_at = MIN(confirm_expires_at, ?1 + ?3),
            unsubscribed_at = NULL, shred_after = NULL, updated_at = ?1
      WHERE confirm_token_hash = ?2 AND confirm_expires_at > ?1 AND status IN ('unconfirmed', 'unsubscribed', 'active') AND email IS NOT NULL
      RETURNING id, token_version`,
  )
    .bind(now, hash, CONFIRM_REUSE_MS)
    .first<{ id: string; token_version: number }>();
  return row ? manageToken(env, row.id, row.token_version) : null;
}

/** Emails an active subscriber their manage link, at most once an hour per address. */
export async function sendManageLink(env: Env, row: SubscriberRow, email: string, now = Date.now()): Promise<boolean> {
  if (row.status !== 'active') return false;
  if (!(await allowMail(env, 'link', row.email_index, LINK_MAILS_PER_HOUR, now))) return false;
  const token = await manageToken(env, row.id, row.token_version);
  await sendEmail(env, { to: email, ...manageLinkEmail(env, { subscriberId: row.id, token }) });
  return true;
}

/** "Email me a manage link": always the same answer for the caller. */
export async function requestManageLink(env: Env, email: string, now = Date.now()): Promise<void> {
  const row = await findSubscriber(env, email);
  if (row) await sendManageLink(env, row, email.trim(), now);
}

export interface PrefsView {
  email: string; // masked
  status: SubscriberStatus;
  releases: ReleasePref;
  product: boolean;
}

export async function prefsView(env: Env, row: SubscriberRow): Promise<PrefsView> {
  const email = await subscriberEmail(env, row);
  return { email: email ? maskEmail(email) : '…', status: row.status, releases: row.releases, product: row.product === 1 };
}

/**
 * New preferences through a manage token. The token proves the mailbox, so an unsubscribed (but
 * not suppressed) subscriber is active again. Null when suppressed.
 */
export async function updatePrefs(env: Env, row: SubscriberRow, prefs: { releases: ReleasePref; product: boolean }, now = Date.now()): Promise<SubscriberRow | null> {
  return env.DB.prepare(
    `UPDATE newsletter_subscribers
        SET releases = ?1, product = ?2, updated_at = ?3,
            status = 'active', unsubscribed_at = NULL, shred_after = NULL, confirmed_at = COALESCE(confirmed_at, ?3),
            confirm_token_hash = NULL, confirm_expires_at = NULL
      WHERE id = ?4 AND token_version = ?5 AND status <> 'suppressed' AND email IS NOT NULL RETURNING *`,
  )
    .bind(prefs.releases, prefs.product ? 1 : 0, now, row.id, row.token_version)
    .first<SubscriberRow>();
}

/**
 * Unsubscribes (idempotent). `revokeLinks` also bumps token_version, so every link mailed so far
 * stops working ("unsubscribe from everything"); the one-click header URL doesn't, so a mail
 * provider repeating the POST still gets a 200. Suppressed rows stay suppressed.
 */
export async function unsubscribe(env: Env, id: string, opts: { revokeLinks?: boolean } = {}, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `UPDATE newsletter_subscribers
        SET status = CASE WHEN status = 'suppressed' THEN status ELSE 'unsubscribed' END,
            unsubscribed_at = COALESCE(unsubscribed_at, ?1), updated_at = ?1,
            shred_after = COALESCE(shred_after, ?4),
            confirm_token_hash = NULL, confirm_expires_at = NULL,
            token_version = token_version + ?2
      WHERE id = ?3`,
  )
    .bind(now, opts.revokeLinks ? 1 : 0, id, now + SHRED_AFTER_MS)
    .run();
}

// ---- the signed-in person's own subscription (account page) -------------------------------------

export interface MyNewsletter {
  subscribed: boolean;
  status: SubscriberStatus | null;
  releases: ReleasePref;
  product: boolean;
}

export async function myNewsletter(env: Env, email: string): Promise<MyNewsletter> {
  const row = await findSubscriber(env, email);
  if (!row) return { subscribed: false, status: null, releases: 'minor', product: true };
  return { subscribed: row.status === 'active', status: row.status, releases: row.releases, product: row.product === 1 };
}

/**
 * Account page: the address is verified, so no double opt-in. Everything off unsubscribes.
 * Choosing to subscribe here also lifts a suppression: the person asked for it, signed in.
 */
export async function setMyNewsletter(env: Env, email: string, prefs: { releases: ReleasePref; product: boolean }, now = Date.now()): Promise<MyNewsletter> {
  const index = await ring(env).emailIndex(email);
  const row = await byIndex(env, index);
  const off = prefs.releases === 'none' && !prefs.product;
  if (off) {
    if (row) await unsubscribe(env, row.id, {}, now);
  } else if (row) {
    const id = await restoreAddress(env, row, email.trim(), null);
    await env.DB.prepare(
      `UPDATE newsletter_subscribers
          SET releases = ?1, product = ?2, updated_at = ?3, unsubscribed_at = NULL, shred_after = NULL,
              confirm_token_hash = NULL, confirm_expires_at = NULL,
              source = CASE WHEN status = 'active' THEN source ELSE 'account' END,
              confirmed_at = CASE WHEN status = 'active' THEN confirmed_at ELSE ?3 END,
              status = 'active'
        WHERE id = ?4`,
    )
      .bind(prefs.releases, prefs.product ? 1 : 0, now, id)
      .run();
  } else {
    await insertSubscriber(env, { email: email.trim(), index, status: 'active', releases: prefs.releases, product: prefs.product, source: 'account', confirmHash: null, now });
  }
  return myNewsletter(env, email);
}

// ---- releases ---------------------------------------------------------------------------------

const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;

export interface ParsedVersion {
  version: string; // normalized: no leading v, no build metadata
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseVersion(raw: string): ParsedVersion | null {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const prerelease = m[4] ?? null;
  return { version: `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`, major, minor, patch, prerelease };
}

const cmpStable = (a: ParsedVersion, b: ParsedVersion) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * A prerelease is 'rc'. A stable version is compared with the highest stable version announced
 * before it (so a patch to an older line counts as a patch): a new major is 'major', a new minor
 * 'minor', else 'micro'. The first stable version ever announced is 'major' when it is x.0.0,
 * otherwise 'minor'.
 */
export function classifyRelease(version: string, announced: readonly string[]): ReleaseLevel | null {
  const v = parseVersion(version);
  if (!v) return null;
  if (v.prerelease) return 'rc';
  const prev = announced
    .map(parseVersion)
    .filter((p): p is ParsedVersion => !!p && !p.prerelease && cmpStable(p, v) < 0)
    .sort(cmpStable)
    .at(-1);
  if (!prev) return v.minor === 0 && v.patch === 0 ? 'major' : 'minor';
  if (v.major !== prev.major) return 'major';
  if (v.minor !== prev.minor) return 'minor';
  return 'micro';
}

export interface IssueRow {
  id: string;
  kind: 'release' | 'product';
  version: string | null;
  release_level: ReleaseLevel | null;
  subject: string;
  url: string | null;
  status: 'sending' | 'sent' | 'failed';
  recipients: number;
  sent_count: number;
  created_at: number;
  finished_at: number | null;
}

/** WHERE clause (and binds) for an issue's recipients: active subscribers who asked for it. */
export function audienceWhere(issue: Pick<IssueRow, 'kind' | 'release_level'>): { sql: string; binds: string[] } {
  if (issue.kind === 'product') return { sql: "status = 'active' AND product = 1", binds: [] };
  const prefs = LEVEL_AUDIENCE[issue.release_level ?? 'rc'];
  return { sql: `status = 'active' AND releases IN (${prefs.map(() => '?').join(', ')})`, binds: [...prefs] };
}

export async function countRecipients(env: Env, issue: Pick<IssueRow, 'kind' | 'release_level'>): Promise<number> {
  const a = audienceWhere(issue);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE ${a.sql}`)
    .bind(...a.binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export const releaseSubject = (version: string, level: ReleaseLevel) =>
  level === 'rc' ? `Worca ${version} (release candidate)` : `Worca ${version} is out`;

/**
 * The release's Markdown, at most NOTES_MAX characters, cut at a line so a list item or link is
 * never split; a cut ends with an "…" line (the mail's button links the full notes).
 */
export function notesExcerpt(notes: string | undefined | null): string | null {
  const t = (notes ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) return null;
  if (t.length <= NOTES_MAX) return t;
  const cut = t.slice(0, NOTES_MAX);
  const nl = cut.lastIndexOf('\n');
  const kept = nl > NOTES_MAX / 2 ? cut.slice(0, nl) : cut.slice(0, Math.max(cut.lastIndexOf(' '), 1));
  return `${kept.trimEnd()}\n\n…`;
}

export interface NewsletterSendParams {
  issueId: string;
  notes?: string | null;
}

export type QueueResult =
  | { duplicate: true; issueId: string }
  | { duplicate: false; issueId: string; level: ReleaseLevel; recipients: number; version: string };

export class ReleaseVersionError extends Error {}

/**
 * The release hook's work: one issue per version (a repeat is a duplicate unless the earlier one
 * failed before sending anything), classified against the stable versions announced so far, then
 * handed to the NewsletterSendWorkflow.
 */
export async function queueReleaseIssue(env: Env, input: { version: string; url: string; notes?: string | null }, now = Date.now()): Promise<QueueResult> {
  const parsed = parseVersion(input.version);
  if (!parsed) throw new ReleaseVersionError('invalid_version');
  const version = parsed.version;
  const existing = await env.DB.prepare("SELECT id, status, sent_count FROM newsletter_issues WHERE kind = 'release' AND version = ?")
    .bind(version)
    .first<{ id: string; status: string; sent_count: number }>();
  if (existing && !(existing.status === 'failed' && existing.sent_count === 0)) return { duplicate: true, issueId: existing.id };

  const announced = await env.DB.prepare(
    "SELECT version FROM newsletter_issues WHERE kind = 'release' AND version IS NOT NULL AND version <> ? AND NOT (status = 'failed' AND sent_count = 0)",
  )
    .bind(version)
    .all<{ version: string }>();
  const level = classifyRelease(version, announced.results.map((r) => r.version)) as ReleaseLevel;
  const subject = releaseSubject(version, level);
  const recipients = await countRecipients(env, { kind: 'release', release_level: level });
  const id = existing?.id ?? crypto.randomUUID();
  const status = recipients === 0 ? 'sent' : 'sending';
  if (existing) {
    const res = await env.DB.prepare(
      `UPDATE newsletter_issues SET release_level = ?, subject = ?, url = ?, status = ?, recipients = ?, sent_count = 0, created_at = ?, finished_at = ?
       WHERE id = ? AND status = 'failed' AND sent_count = 0`,
    )
      .bind(level, subject, input.url, status, recipients, now, recipients === 0 ? now : null, id)
      .run();
    if ((res.meta.changes ?? 0) === 0) return { duplicate: true, issueId: id };
  } else {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO newsletter_issues (id, kind, version, release_level, subject, url, status, recipients, sent_count, created_at, finished_at)
       VALUES (?, 'release', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(id, version, level, subject, input.url, status, recipients, now, recipients === 0 ? now : null)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      const winner = await env.DB.prepare("SELECT id FROM newsletter_issues WHERE kind = 'release' AND version = ?").bind(version).first<{ id: string }>();
      return { duplicate: true, issueId: winner?.id ?? id };
    }
  }
  if (recipients > 0) {
    try {
      if (!env.NEWSLETTER_SEND) throw new Error('NEWSLETTER_SEND is not bound');
      const params: NewsletterSendParams = { issueId: id, notes: notesExcerpt(input.notes) };
      await env.NEWSLETTER_SEND.create({ id: `newsletter-${id}-${now}`, params });
    } catch (err) {
      await finishIssue(env, id, 'failed', now);
      throw err;
    }
  }
  return { duplicate: false, issueId: id, level, recipients, version };
}

export async function finishIssue(env: Env, issueId: string, status: 'sent' | 'failed', now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE newsletter_issues SET status = ?, finished_at = ? WHERE id = ? AND status = 'sending'").bind(status, now, issueId).run();
}

// ---- sending ----------------------------------------------------------------------------------

/** Start of the next UTC day, plus a minute of slack. */
export const nextUtcDay = (now: number) => (Math.floor(now / 86_400_000) + 1) * 86_400_000 + 60_000;

/**
 * How many newsletter mails may go out now: what is left of the plan's day and month after
 * QUOTA_RESERVE for transactional mail, at most one batch.
 */
export function allowanceFrom(usage: { today: number; monthToDate: number }, plan: { daily: number; monthly: number } = RESEND_PLAN): number {
  const daily = plan.daily - QUOTA_RESERVE - usage.today;
  const monthly = plan.monthly - QUOTA_RESERVE - usage.monthToDate;
  return Math.max(0, Math.min(daily, monthly, BATCH_MAX));
}

export type BatchResult =
  | { state: 'wait'; waitMs: number }
  | { state: 'progress'; cursor: string; sent: number; last: boolean }
  | { state: 'done' };

/**
 * One batch of an issue: the next active recipients after `cursor` (by id; preferences and
 * statuses are read now, so unsubscribes during a long send count), each with their own manage
 * and unsubscribe links, in one Resend batch call. 'wait' when today's quota is used up.
 */
export async function sendIssueBatch(env: Env, issueId: string, cursor: string, opts: { notes?: string | null; now?: number } = {}): Promise<BatchResult> {
  const now = opts.now ?? Date.now();
  const issue = await env.DB.prepare('SELECT * FROM newsletter_issues WHERE id = ?').bind(issueId).first<IssueRow>();
  if (!issue || issue.status !== 'sending') return { state: 'done' };
  const allowed = allowanceFrom(await mailUsage(env, now));
  if (allowed <= 0) return { state: 'wait', waitMs: Math.max(nextUtcDay(now) - now, 1000) };

  const a = audienceWhere(issue);
  const rows = await env.DB.prepare(`SELECT id, email, token_version FROM newsletter_subscribers WHERE ${a.sql} AND id > ? ORDER BY id LIMIT ?`)
    .bind(...a.binds, cursor, allowed)
    .all<{ id: string; email: string; token_version: number }>();
  if (rows.results.length === 0) return { state: 'done' };

  const mails: Mail[] = [];
  for (const r of rows.results) {
    const to = await subscriberEmail(env, r);
    if (!to) continue;
    const links = newsletterLinks(env, await manageToken(env, r.id, r.token_version));
    mails.push({ to, ...issueMail(env, issue, links, opts.notes ?? null), ref: `newsletter:${r.id}:${issue.id}` });
  }
  await sendEmailBatch(env, mails, { idempotencyKey: `newsletter-${issue.id}-${rows.results[0]!.id}` });
  await env.DB.prepare('UPDATE newsletter_issues SET sent_count = sent_count + ? WHERE id = ?').bind(mails.length, issue.id).run();
  return { state: 'progress', cursor: rows.results.at(-1)!.id, sent: mails.length, last: rows.results.length < allowed };
}

// ---- upkeep -----------------------------------------------------------------------------------

/** Daily: unconfirmed subscribers older than UNCONFIRMED_TTL_MS go, with their keys. */
export async function pruneUnconfirmed(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - UNCONFIRMED_TTL_MS;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const rows = await env.DB.prepare("SELECT id FROM newsletter_subscribers WHERE status = 'unconfirmed' AND created_at < ?1 AND updated_at < ?1 LIMIT 90")
      .bind(cutoff)
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    if (ids.length === 0) break;
    await env.DB.prepare(`DELETE FROM newsletter_subscribers WHERE status = 'unconfirmed' AND id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .run();
    await deleteKeys(env, ids);
    total += ids.length;
  }
  return total;
}

/**
 * Daily: addresses of subscribers unsubscribed or suppressed more than SHRED_AFTER_MS ago are
 * shredded: their data key is deleted and email set to NULL. The blind index and status stay.
 */
export async function shredExpired(env: Env, now = Date.now()): Promise<number> {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const rows = await env.DB.prepare(
      "SELECT id FROM newsletter_subscribers WHERE shred_after IS NOT NULL AND shred_after < ? AND email IS NOT NULL AND status IN ('unsubscribed', 'suppressed') LIMIT 90",
    )
      .bind(now)
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    if (ids.length === 0) break;
    await env.DB.prepare(
      `UPDATE newsletter_subscribers SET email = NULL, confirm_token_hash = NULL, confirm_expires_at = NULL, updated_at = ?
       WHERE status IN ('unsubscribed', 'suppressed') AND id IN (${ids.map(() => '?').join(', ')})`,
    )
      .bind(now, ...ids)
      .run();
    await deleteKeys(env, ids);
    total += ids.length;
  }
  return total;
}

/** D59: deleting an account removes that address's subscriber, row and key. */
export async function deleteSubscriberByEmail(env: Env, email: string): Promise<boolean> {
  const row = await findSubscriber(env, email);
  if (!row) return false;
  await env.DB.prepare('DELETE FROM newsletter_subscribers WHERE id = ?').bind(row.id).run();
  await deleteKeys(env, [row.id]);
  return true;
}

/** S2: a bounce or complaint on any newsletter mail suppresses its subscriber. */
export async function suppressForMail(env: Env, emailId: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare('SELECT ref FROM mail_messages WHERE email_id = ?').bind(emailId).first<{ ref: string }>();
  const m = row ? /^newsletter:(nl_[^:]+):/.exec(row.ref) : null;
  if (!m) return false;
  const res = await env.DB.prepare(
    "UPDATE newsletter_subscribers SET status = 'suppressed', updated_at = ?1, shred_after = COALESCE(shred_after, ?2) WHERE id = ?3 AND status <> 'suppressed'",
  )
    .bind(now, now + SHRED_AFTER_MS, m[1])
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- console ------------------------------------------------------------------------------------

export async function newsletterOverview(env: Env) {
  const [byStatus, byPrefs, issues] = await env.DB.batch([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM newsletter_subscribers GROUP BY status'),
    env.DB.prepare("SELECT releases, product, COUNT(*) AS n FROM newsletter_subscribers WHERE status = 'active' GROUP BY releases, product"),
    env.DB.prepare('SELECT * FROM newsletter_issues ORDER BY created_at DESC LIMIT 20'),
  ]);
  const status = { unconfirmed: 0, active: 0, unsubscribed: 0, suppressed: 0 } as Record<SubscriberStatus, number>;
  for (const r of (byStatus?.results ?? []) as { status: SubscriberStatus; n: number }[]) status[r.status] = r.n;
  const releases = Object.fromEntries(RELEASE_PREFS.map((p) => [p, 0])) as Record<ReleasePref, number>;
  let product = 0;
  for (const r of (byPrefs?.results ?? []) as { releases: ReleasePref; product: number; n: number }[]) {
    releases[r.releases] += r.n;
    if (r.product === 1) product += r.n;
  }
  return {
    subscribers: { total: Object.values(status).reduce((a, b) => a + b, 0), byStatus: status, active: { releases, product } },
    issues: ((issues?.results ?? []) as unknown as IssueRow[]).map((i) => ({
      id: i.id,
      kind: i.kind,
      version: i.version,
      level: i.release_level,
      subject: i.subject,
      url: i.url,
      status: i.status,
      recipients: i.recipients,
      sent: i.sent_count,
      createdAt: i.created_at,
      finishedAt: i.finished_at,
    })),
  };
}
