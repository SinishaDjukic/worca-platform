// Captured mail (LOCAL_DEV=1, no RESEND_API_KEY): GET APP_ORIGIN/__dev/mail?to=<email>, a JSON
// array of { to, subject, text, html, at }, newest last.
// Against a deployed stack mail really goes out: E2E_INBOX_MODULE names a module exporting
// getMail(to) in the same shape (a real mailbox, e.g. a deployment's own inbox reader), and the
// tests read mail through it instead.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { request } from './http.mjs';
import { APP_ORIGIN } from './config.mjs';

const INBOX_MODULE = process.env.E2E_INBOX_MODULE;
let inbox = null;
async function moduleMail(to) {
  inbox ??= await import(pathToFileURL(resolve(INBOX_MODULE)).href);
  const getMail = inbox.getMail ?? inbox.default?.getMail;
  if (typeof getMail !== 'function') throw new Error(`${INBOX_MODULE} exports no getMail(to)`);
  return getMail(to);
}

export async function getMail(to) {
  if (INBOX_MODULE) return moduleMail(to);
  const res = await request(`${APP_ORIGIN}/__dev/mail?to=${encodeURIComponent(to)}`);
  if (res.status !== 200) throw new Error(`mail capture: ${res.describe()}`);
  const body = res.json();
  return Array.isArray(body) ? body : body.mail ?? body.messages ?? [];
}

const mailKey = (m) => m.id ?? `${m.at}|${m.subject}|${m.text}`;

/**
 * Waits for a mail to `to` that is not in `after` (a mark from mailMark(); the capture keeps only
 * the last 20 mails per address, so marks are sets of seen mails, not counts). Returns the newest
 * match.
 */
export async function waitForMail(to, { after = new Set(), match = () => true, timeoutMs = INBOX_MODULE ? 120_000 : 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = after instanceof Set ? after : new Set();
  for (;;) {
    const list = await getMail(to);
    const fresh = list.filter((m) => !seen.has(mailKey(m))).filter(match);
    if (fresh.length) return fresh[fresh.length - 1];
    if (Date.now() > deadline) throw new Error(`no new mail to ${to} after ${timeoutMs} ms (have ${list.length}: ${list.map((m) => m.subject).join(' | ')})`);
    await new Promise((r) => setTimeout(r, INBOX_MODULE ? 3000 : 300));
  }
}

/** A mark of the mails already there, for waitForMail({ after }). */
export async function mailMark(to) {
  return new Set((await getMail(to)).map(mailKey));
}

/** The first 6-digit code in a sign-in mail. */
export function extractCode(mail) {
  const m = `${mail.subject}\n${mail.text}`.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no code in mail "${mail.subject}"`);
  return m[1];
}

/** Every http(s) link in the text part (and the html part as a fallback), deduplicated. */
export function extractLinks(mail) {
  const found = new Set();
  for (const src of [mail.text ?? '', (mail.html ?? '').replace(/&amp;/g, '&')]) {
    for (const m of src.matchAll(/https?:\/\/[^\s"'<>)]+/g)) found.add(m[0]);
  }
  return [...found];
}

export function extractLink(mail, pattern) {
  const link = extractLinks(mail).find((l) => (pattern instanceof RegExp ? pattern.test(l) : l.includes(pattern)));
  if (!link) throw new Error(`no link matching ${pattern} in mail "${mail.subject}": ${extractLinks(mail).join(' ')}`);
  return link;
}
