// Outbound mail (D2, D6). Resend in deployed environments; captured in KV under local dev.
// The templates below build every mail through the one layout in mail-layout.ts.
import type { Env } from '../env';
import type { Site } from '../../shared/site';
import { captureQuotaHeaders, countMail, invitationMailRef, recordFailedSend, recordSentMail, type MailKind } from '../system/mail';
import { a, btn, code as codeChip, esc, fine, h1, kicker, layout, p, paragraphs, strong } from './mail-layout';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** For the per-day counts (P12); inferred when absent (see mailKindOf). Set by the templates. */
  kind?: MailKind;
  /** Links the Resend email id to e.g. `invitation:<id>` for delivery status (S2, deliveryStatusFor). */
  ref?: string;
  /** Sender; EMAIL_FROM when absent (the newsletter sends from NEWSLETTER_FROM). */
  from?: string;
  /** Extra headers, e.g. List-Unsubscribe (Resend's `headers` object). */
  headers?: Record<string, string>;
  /** Where replies go (Resend `reply_to`): the newsletter's sender subdomain receives no mail. */
  replyTo?: string;
}

/** Untagged mails: confirmations are recognisable by subject, everything else is a notification. */
export const mailKindOf = (mail: Pick<Mail, 'kind' | 'subject'>): MailKind =>
  mail.kind ?? (mail.subject.startsWith('Confirm:') ? 'confirmation' : 'notification');

/** Most recent mails kept per address in the local capture. */
const DEV_MAIL_CAP = 20;
const DEV_MAIL_TTL_S = 3600;

export const devMailKey = (to: string) => `dev:mail:${to.trim().toLowerCase()}`;

export async function sendEmail(env: Env, mail: Mail, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (env.RESEND_API_KEY) return sendViaResend(env, mail, fetchImpl);
  // Captured mail holds live sign-in codes in plaintext: never outside local dev.
  if (env.LOCAL_DEV === '1') return captureDevMail(env, mail);
  throw new Error('no email transport configured (RESEND_API_KEY)');
}

// Resend has one API host; the EU region (D6) is chosen per sending domain when the domain is
// added (resend.com/docs/dashboard/domains/regions), not by a separate endpoint.
async function sendViaResend(env: Env, mail: Mail, fetchImpl: typeof fetch): Promise<void> {
  const kind = mailKindOf(mail);
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(resendPayload(env, mail)),
  });
  await captureQuotaHeaders(env, res.headers);
  if (!res.ok) {
    // Better Auth swallows errors from its mail callbacks (anti-enumeration), so log here.
    console.error(JSON.stringify({ at: 'mail_failed', status: res.status, kind }));
    if (mail.ref) await recordFailedSend(env, { ref: mail.ref, kind });
    throw new Error(`Resend failed: ${res.status}`);
  }
  await countMail(env, kind);
  if (mail.ref) {
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id === 'string') await recordSentMail(env, { emailId: body.id, ref: mail.ref, kind });
  }
}

function resendPayload(env: Env, mail: Mail) {
  return {
    from: mail.from ?? env.EMAIL_FROM,
    to: [mail.to],
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
    ...(mail.replyTo ? { reply_to: [mail.replyTo] } : {}),
  };
}

/** Resend's batch endpoint takes at most this many mails per call. */
export const BATCH_MAX = 100;

/**
 * Sends up to BATCH_MAX individual mails in one call (Resend `POST /emails/batch`; captured one by
 * one under local dev). `idempotencyKey` makes a retried call a no-op at Resend for 24 hours: a
 * 409 for it means the batch already went out, and counts as sent. Each mail is counted under its
 * kind, and recorded under its ref when it has one. Throws when Resend refuses the batch.
 */
export async function sendEmailBatch(env: Env, mails: Mail[], opts: { idempotencyKey?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (mails.length === 0) return;
  if (mails.length > BATCH_MAX) throw new Error(`batch of ${mails.length} mails exceeds ${BATCH_MAX}`);
  if (!env.RESEND_API_KEY) {
    if (env.LOCAL_DEV !== '1') throw new Error('no email transport configured (RESEND_API_KEY)');
    for (const mail of mails) await captureDevMail(env, mail);
    return;
  }
  const res = await fetchImpl('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify(mails.map((m) => resendPayload(env, m))),
  });
  await captureQuotaHeaders(env, res.headers);
  if (res.status === 409 && opts.idempotencyKey) {
    console.warn(JSON.stringify({ at: 'mail_batch_duplicate', count: mails.length }));
    return;
  }
  if (!res.ok) {
    console.error(JSON.stringify({ at: 'mail_batch_failed', status: res.status, count: mails.length }));
    throw new Error(`Resend batch failed: ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  for (const [i, mail] of mails.entries()) {
    const kind = mailKindOf(mail);
    await countMail(env, kind);
    const id = body?.data?.[i]?.id;
    if (mail.ref && typeof id === 'string') await recordSentMail(env, { emailId: id, ref: mail.ref, kind });
  }
}

async function captureDevMail(env: Env, mail: Mail): Promise<void> {
  await countMail(env, mailKindOf(mail));
  const key = devMailKey(mail.to);
  const list = (await env.KV.get<unknown[]>(key, 'json')) ?? [];
  list.push({ ...mail, at: new Date().toISOString() });
  await env.KV.put(key, JSON.stringify(list.slice(-DEV_MAIL_CAP)), { expirationTtl: DEV_MAIL_TTL_S });
}

export async function readDevMail(env: Env, to: string): Promise<unknown[]> {
  return (await env.KV.get<unknown[]>(devMailKey(to), 'json')) ?? [];
}

// ---- Layout -------------------------------------------------------------------------------
// Every mail's HTML goes through layout() in mail-layout.ts (the deployment's Site); the
// building blocks are re-exported here so templates import one module.
export { a, btn, code, esc, fine, footLink, h1, kicker, layout, linkify, p, paragraphs, quote, strong, type Tone } from './mail-layout';

export type MailContent = Omit<Mail, 'to'>;

// ---- Templates ----------------------------------------------------------------------------

export function signInCodeEmail(code: string, site: Site): MailContent {
  const subject = `Your Worca sign-in code: ${code}`;
  const text = `Your sign-in code is ${code}\n\nIt expires in 5 minutes. If you didn't try to sign in, ignore this email.\n`;
  const body =
    kicker('Sign in', 'violet') +
    h1('Your sign-in code') +
    p('Enter this code on the sign-in page to continue:') +
    codeChip(code) +
    fine("It expires in 5 minutes. If you didn't try to sign in, ignore this email.");
  return { subject, text, html: layout({ preheader: `Sign-in code ${code}`, body, reason: 'You asked to sign in to Worca.', site }), kind: 'sign_in_code' };
}

/** Sent after every passkey registration, so an unexpected new passkey doesn't go unnoticed. */
export function passkeyAddedEmail(site: Site): MailContent {
  const appUrl = site.appOrigin;
  const subject = 'A passkey was added to your Worca account';
  const text = `A new passkey was just added to your Worca account.\n\nIf this wasn't you, sign in at ${appUrl} and remove it, and contact your tenant admin.\n`;
  const body =
    kicker('Security', 'red') +
    h1('New passkey added') +
    p('A new passkey was just added to your Worca account. If that was you, there is nothing else to do.') +
    fine(`If this wasn't you, sign in at ${a(appUrl, appUrl.replace(/^https?:\/\//, ''))}, remove the passkey and contact your tenant admin.`);
  return {
    subject,
    text,
    html: layout({ preheader: 'A passkey was added to your account', body, reason: 'A passkey was added to your Worca account.', site }),
    kind: 'passkey_notice',
  };
}

export function orgInvitationEmail(opts: { orgName: string; inviterName: string; invitationId: string; site: Site }): MailContent {
  const url = `${opts.site.appOrigin}/invite/${encodeURIComponent(opts.invitationId)}`;
  const who = opts.inviterName || 'A tenant admin';
  const subject = `${who} invited you to ${opts.orgName} on Worca`;
  const text = `${who} invited you to join ${opts.orgName} on Worca.\n\nAccept the invitation: ${url}\n\nIf you weren't expecting this, ignore this email.\n`;
  const body =
    kicker('Invitation', 'green') +
    h1(`Join ${esc(opts.orgName)}`) +
    p(`${esc(who)} invited you to join ${strong(esc(opts.orgName))} on Worca.`) +
    btn(url, 'Accept invitation') +
    fine("If you weren't expecting this, ignore this email.");
  return {
    subject,
    text,
    html: layout({ preheader: `Invitation to ${opts.orgName}`, body, reason: 'Someone invited this address to an organization on Worca.', site: opts.site }),
    kind: 'invitation',
    ref: invitationMailRef(opts.invitationId),
  };
}

/** Generic one-action mail. `body` is plain text, escaped here. */
export function actionEmail(title: string, body: string, buttonLabel: string, url: string, site: Site): MailContent {
  const text = `${title}\n\n${body}\n\n${buttonLabel}: ${url}\n`;
  const html = layout({
    preheader: title,
    body: h1(esc(title)) + paragraphs(body, site) + btn(url, buttonLabel),
    reason: 'This email was sent because of activity on your Worca account.',
    site,
  });
  return { subject: title, text, html };
}

/** The link that confirms a sensitive action (tenancy/confirmations.ts). `summary` is plain text. */
export function confirmActionEmail(opts: { label: string; summary: string; link: string; site: Site }): MailContent {
  const subject = `Confirm: ${opts.label}`;
  const text = `${opts.summary}\n\nTo confirm, open this link within 30 minutes and press the button:\n${opts.link}\n\nIf you didn't ask for this, ignore this email.`;
  const body =
    kicker('Confirm', 'peach') +
    h1(esc(opts.label)) +
    paragraphs(opts.summary, opts.site) +
    p('To go ahead, open the link within 30 minutes and press the button on the page.') +
    btn(opts.link, 'Review and confirm') +
    fine("If you didn't ask for this, ignore this email: nothing happens unless you confirm.");
  return {
    subject,
    text,
    html: layout({ preheader: opts.summary.split('\n')[0]!.slice(0, 140), body, reason: 'Someone signed in to your Worca account asked for this action.', site: opts.site }),
    kind: 'confirmation',
  };
}

/** Platform support reset the account's sign-in (tenancy/support-routes.ts). */
export function signInResetEmail(site: Site): MailContent {
  const url = `${site.appOrigin}/sign-in`;
  const subject = 'Your Worca sign-in was reset';
  const text =
    'Platform support removed every passkey from your Worca account and signed you out everywhere.\n\n' +
    `Sign in with an email code at ${url} and add a new passkey.\n\n` +
    'If you did not ask for this, contact Worca support right away.';
  const body =
    kicker('Security', 'red') +
    h1('Your sign-in was reset') +
    p('Platform support removed every passkey from your Worca account and signed you out everywhere.') +
    p('Sign in with an email code, then add a new passkey.') +
    btn(url, 'Sign in') +
    fine('If you did not ask for this, contact Worca support right away.');
  return {
    subject,
    text,
    html: layout({ preheader: 'Sign in with an email code and add a new passkey', body, reason: 'Platform support changed your Worca account.', site }),
  };
}

/**
 * HTML for a notice that only has a subject and plain text (instance and membership notices):
 * the subject as heading, the text as paragraphs with linked URLs, in the same layout as every
 * other mail. The deps seams (tenancy, instances) use it for every mail sent without `html`.
 */
export function noticeEmailHtml(opts: { subject: string; text: string; site: Site }): string {
  return layout({
    preheader: opts.text.trim().split('\n')[0]!.slice(0, 140),
    body: kicker('Notice', 'blue') + h1(esc(opts.subject)) + paragraphs(opts.text, opts.site),
    reason: 'This email was sent because of activity on your Worca account.',
    site: opts.site,
  });
}

