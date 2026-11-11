// Access requests for hosted worca (D69), the public side: the website's form, the emailed
// confirmation (a page on the app origin that posts the token; nothing happens on GET), the
// superadmins' notice, the join hook and retention. Staff decide in the console
// (tenancy/access-requests-routes.ts).
//
// The form never says whether an address has an account or an open request: every valid
// submission answers 202 { ok: true }, and only the address's owner learns more, by mail.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { sha256Hex, type FieldContext } from '../keys-api';
import { forgetKeyCache } from '../keys';
import { FEEDBACK_JS, glyph, pageDocument } from '../auth/pages';
import { deps } from '../tenancy/deps';
import { randomToken, userProfile } from '../tenancy/util';
import { accessConfirmEmail, accessStaffNoticeEmail } from './access-request-mail';
import { siteOf, type Site } from '../../shared/site';

export const CONFIRM_TTL_MS = 7 * 86_400_000;
/** A second submission while unconfirmed resends the link, at most this often. */
export const RESEND_AFTER_MS = 3_600_000;
/** Superadmins hear about new requests at most this often (first one at once, then a digest). */
export const NOTICE_EVERY_MS = 3_600_000;
/** An unconfirmed request is deleted this long after its link expired. */
export const UNCONFIRMED_GRACE_MS = 7 * 86_400_000;
/** Decided requests lose their personal data this long after the decision (or the sign-up). */
export const RETENTION_MS = 180 * 86_400_000;

export const ACCESS_REQUEST_PAGE_PATH = '/access-request';
const PAGE_JS_PATH = '/access-request.js';
const NOTICE_SETTING = 'access_requests_noticed_at';

/**
 * An error's message for a log line, with anything shaped like an address replaced: logs and
 * audit entries never carry a requester's address or text (D69), whatever a transport says.
 */
export const logSafe = (err: unknown): string => String((err as Error)?.message ?? err).replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[address]');

export type AccessRequestStatus = 'unconfirmed' | 'pending' | 'granted' | 'declined' | 'joined';

/**
 * Each request has its own data key ({ type: 'user', id: <request id> }; data_keys only knows org
 * and user owners). Ids start with `ar_`, which no user id (Better Auth: alphanumeric) or newsletter
 * subscriber id (`nl_`) does. Deleting the key (crypto-shredding) makes the request's personal
 * data unreadable everywhere, database backups included.
 */
export const ACCESS_REQUEST_ID_PREFIX = 'ar_';
export const newAccessRequestId = () => `${ACCESS_REQUEST_ID_PREFIX}${crypto.randomUUID()}`;
export type AccessRequestColumn = 'email' | 'use_case' | 'company' | 'decision_note';
export const accessRequestField = (id: string, column: AccessRequestColumn): FieldContext => ({
  table: 'access_requests',
  column,
  rowId: id,
  owner: { type: 'user', id },
});

/** Deletes the requests' data keys outright (not a destroyed-key tombstone: the id is never reused). */
async function shredKeys(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM data_keys WHERE owner_type = 'user' AND owner_id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .run();
    for (const id of chunk) forgetKeyCache({ type: 'user', id });
  }
}

/** Whatever the outcome: the caller learns nothing about the address. */
export type SubmitOutcome = 'created' | 'resent' | 'open' | 'has_account';

export interface AccessRequestInput {
  email: string;
  useCase: string;
  company?: string;
  source?: string;
}

export const accessRequestBody = z.object({
  email: z.email().trim().max(254),
  useCase: z.string().trim().min(1).max(2000),
  company: z.string().trim().max(200).optional(),
  source: z.string().trim().max(100).optional(),
});

async function sendConfirmation(env: Env, email: string, token: string): Promise<void> {
  const mail = accessConfirmEmail(`${env.APP_ORIGIN}${ACCESS_REQUEST_PAGE_PATH}#t=${token}`, siteOf(env));
  try {
    await deps().sendEmail(env, { to: email, ...mail });
  } catch (err) {
    // The answer stays 202; a later submission (after an hour) sends a new link.
    console.error(JSON.stringify({ at: 'access_request.confirm_mail_failed', message: logSafe(err) }));
  }
}

/**
 * Records a request and mails the confirmation link. An address with an account gets nothing; one
 * with an open request gets the link again (at most hourly) while unconfirmed, nothing once pending.
 */
export async function submitAccessRequest(env: Env, input: AccessRequestInput, now = Date.now()): Promise<SubmitOutcome> {
  const ring = deps().keyRing(env);
  const emailIndex = await ring.emailIndex(input.email);
  if (await env.DB.prepare('SELECT 1 FROM user WHERE emailIndex = ?').bind(emailIndex).first()) return 'has_account';

  const open = await env.DB.prepare(
    "SELECT id, status, confirm_sent_at FROM access_requests WHERE email_index = ? AND status IN ('unconfirmed', 'pending')",
  )
    .bind(emailIndex)
    .first<{ id: string; status: AccessRequestStatus; confirm_sent_at: number | null }>();
  if (open) {
    if (open.status !== 'unconfirmed' || (open.confirm_sent_at ?? 0) > now - RESEND_AFTER_MS) return 'open';
    // A new link replaces the old one; the request keeps what was first written.
    const token = randomToken();
    const res = await env.DB.prepare(
      "UPDATE access_requests SET confirm_token_hash = ?, confirm_expires_at = ?, confirm_sent_at = ? WHERE id = ? AND status = 'unconfirmed' AND (confirm_sent_at IS NULL OR confirm_sent_at <= ?)",
    )
      .bind(await sha256Hex(token), now + CONFIRM_TTL_MS, now, open.id, now - RESEND_AFTER_MS)
      .run();
    if (!res.meta.changes) return 'open';
    await sendConfirmation(env, input.email, token);
    return 'resent';
  }

  const id = newAccessRequestId();
  const token = randomToken();
  const company = input.company?.trim() ? await ring.encrypt(accessRequestField(id, 'company'), input.company.trim()) : null;
  // The partial unique index (one open request per address) settles two submissions at once.
  const res = await env.DB.prepare(
    `INSERT INTO access_requests (id, email, email_index, use_case, company, source, status, confirm_token_hash, confirm_expires_at, confirm_sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      await ring.encrypt(accessRequestField(id, 'email'), input.email.trim()),
      emailIndex,
      await ring.encrypt(accessRequestField(id, 'use_case'), input.useCase),
      company,
      input.source?.trim() || null,
      await sha256Hex(token),
      now + CONFIRM_TTL_MS,
      now,
      now,
    )
    .run();
  if (!res.meta.changes) {
    await shredKeys(env, [id]); // lost the race: the key we made has no row
    return 'open';
  }
  await sendConfirmation(env, input.email, token);
  return 'created';
}

export type ConfirmOutcome = 'confirmed' | 'already_confirmed' | 'invalid';

/** The emailed token makes the request pending; superadmins are told (at most hourly). */
export async function confirmAccessRequest(env: Env, token: string, now = Date.now()): Promise<ConfirmOutcome> {
  if (!token) return 'invalid';
  const hash = await sha256Hex(token);
  const claimed = await env.DB.prepare(
    "UPDATE access_requests SET status = 'pending', confirmed_at = ? WHERE confirm_token_hash = ? AND status = 'unconfirmed' AND confirm_expires_at > ? RETURNING id",
  )
    .bind(now, hash, now)
    .first<{ id: string }>();
  if (!claimed) {
    // A second click on the same link: say so instead of "invalid".
    const row = await env.DB.prepare("SELECT 1 FROM access_requests WHERE confirm_token_hash = ? AND status <> 'unconfirmed'").bind(hash).first();
    return row ? 'already_confirmed' : 'invalid';
  }
  try {
    await notifyStaff(env, now);
  } catch (err) {
    // The 5-minute cron tries again.
    console.error(JSON.stringify({ at: 'access_request.notify_failed', message: logSafe(err) }));
  }
  return 'confirmed';
}

/**
 * Tells every superadmin how many requests came in since the last notice. Runs on each
 * confirmation and on the 5-minute cron; the hourly slot is claimed atomically, so the first
 * request is announced at once and later ones are batched into at most one digest per hour.
 * Returns how many requests the notice covered (0 when none was sent).
 */
export async function notifyStaff(env: Env, now = Date.now()): Promise<number> {
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending' AND notified_at IS NULL").first<{ n: number }>();
  if (!waiting?.n) return 0;
  const slot = await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES (?1, ?2, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE CAST(platform_settings.value AS INTEGER) <= ?3`,
  )
    .bind(NOTICE_SETTING, now, now - NOTICE_EVERY_MS)
    .run();
  if (!slot.meta.changes) return 0;
  const marked = await env.DB.prepare("UPDATE access_requests SET notified_at = ? WHERE status = 'pending' AND notified_at IS NULL").bind(now).run();
  const fresh = marked.meta.changes ?? 0;
  if (!fresh) return 0;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'").first<{ n: number }>();
  const mail = accessStaffNoticeEmail({ fresh, pending: pending?.n ?? fresh, site: siteOf(env) });
  const admins = await env.DB.prepare("SELECT user_id FROM platform_roles WHERE role = 'superadmin'").all<{ user_id: string }>();
  for (const { user_id } of admins.results) {
    const profile = await userProfile(env, user_id);
    if (!profile?.email) continue;
    try {
      await deps().sendEmail(env, { to: profile.email, ...mail });
    } catch (err) {
      console.error(JSON.stringify({ at: 'access_request.staff_notice_failed', userId: user_id, message: logSafe(err) }));
    }
  }
  return fresh;
}

/** Called when an account was created with a registration code: its request, if any, joined. */
export async function markAccessRequestJoined(env: Env, registrationCodeId: string, now = Date.now()): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE access_requests SET status = 'joined', joined_at = ? WHERE registration_code_id = ? AND status = 'granted'")
    .bind(now, registrationCodeId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Daily retention (D69). Unconfirmed requests go, row and key, 7 days after their link expired.
 * Granted, declined and joined requests are shredded 180 days after the decision (joined: the
 * sign-up): key deleted, personal columns and the blind index emptied, the anonymous row kept for
 * the funnel counts. Pending requests wait for a decision. Returns how many rows each step touched.
 */
export async function pruneAccessRequests(env: Env, now = Date.now()): Promise<{ deleted: number; shredded: number }> {
  const deleted = await env.DB.prepare("DELETE FROM access_requests WHERE status = 'unconfirmed' AND confirm_expires_at < ? RETURNING id")
    .bind(now - UNCONFIRMED_GRACE_MS)
    .all<{ id: string }>();
  const shredded = await env.DB.prepare(
    `UPDATE access_requests
     SET email = NULL, email_index = NULL, use_case = NULL, company = NULL, decision_note = NULL, confirm_token_hash = NULL, shredded_at = ?1
     WHERE shredded_at IS NULL AND (
       (status IN ('granted', 'declined') AND decided_at < ?2) OR (status = 'joined' AND COALESCE(joined_at, decided_at) < ?2))
     RETURNING id`,
  )
    .bind(now, now - RETENTION_MS)
    .all<{ id: string }>();
  await shredKeys(env, [...deleted.results, ...shredded.results].map((r) => r.id));
  return { deleted: deleted.results.length, shredded: shredded.results.length };
}

// ---- /api/public/access-requests -----------------------------------------------------------------

async function jsonBody(c: Context<AppContext>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export const accessRequestsPublicApp = new Hono<AppContext>();

accessRequestsPublicApp.post('/', async (c) => {
  const parsed = accessRequestBody.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  await submitAccessRequest(c.env, parsed.data);
  return c.json({ ok: true }, 202);
});

accessRequestsPublicApp.post('/confirm', async (c) => {
  const parsed = z.object({ token: z.string().trim().min(1).max(200) }).safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const outcome = await confirmAccessRequest(c.env, parsed.data.token);
  if (outcome === 'invalid') return c.json({ error: 'invalid_token' }, 410);
  return c.json({ ok: true, status: outcome });
});

// ---- the page the confirmation mail links to ----------------------------------------------------

// The token travels in the URL fragment, so it never reaches a server log or a Referer; the
// script posts it when the person presses the button. Mail scanners that open the link do nothing.
export const ACCESS_REQUEST_JS = `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('ar-confirm');
  if (!form) return;
  const status = $('ar-status');
  const website = document.body.dataset.website || ''; // the operator's site, where the form is (auth/pages.ts)
${FEEDBACK_JS}
  const say = (msg, err) => showStatus(status, msg, !!err);
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  if (token) history.replaceState(null, '', location.pathname);
  const button = form.querySelector('button');
  if (!token) { say('This link is incomplete. Open it again from the email, or copy the whole address.', true); button.disabled = true; return; }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    button.disabled = true;
    say('Confirming…');
    try {
      const res = await fetch('/api/public/access-requests/confirm', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      if (res.ok) {
        form.hidden = true;
        $('ar-lead').textContent = 'Thanks, your request is confirmed. We review requests by hand and will email you either way.';
        say('');
        return;
      }
      say(res.status === 410 ? 'This link has expired or is not valid. ' + (website ? 'Send the form on ' + website + ' again for a new one.' : 'Send the request form again for a new one.') : 'Something went wrong. Try again in a moment.', true);
      button.disabled = res.status === 410;
    } catch (e) {
      say('Could not reach Worca. Check your connection and try again.', true);
      button.disabled = false;
    }
  });
})();`;

export function accessRequestPage(site: Site): string {
  const body = `${glyph('mail', 'blue')}<h1>Confirm your request</h1>
<p class="sp-lead" id="ar-lead">Press the button to confirm that this email address is yours. Then we review your request for hosted Worca.</p>
<p id="ar-status" role="status" aria-live="polite" class="sp-status"></p>
<form id="ar-confirm" class="sp-actions"><button type="submit" class="btn primary">Confirm my request</button></form>`;
  return pageDocument('Confirm your request', body, { cardClass: 'center', scriptPath: PAGE_JS_PATH, site });
}

/** Mounted at the app's root (index.ts), before the web UI's catch-all. No session needed. */
export const accessRequestPageApp = new Hono<AppContext>();

accessRequestPageApp.get(ACCESS_REQUEST_PAGE_PATH, (c) => {
  c.header('Referrer-Policy', 'same-origin'); // the token stays on the site; no-referrer would send Origin: null with the page's POSTs
  return c.html(accessRequestPage(siteOf(c.env)));
});

accessRequestPageApp.get(PAGE_JS_PATH, (c) =>
  c.body(ACCESS_REQUEST_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }),
);
