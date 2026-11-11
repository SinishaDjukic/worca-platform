// Mails of the access-request funnel (D69): the requester's confirmation link, grant and decline,
// and the superadmins' notice. Same layout as every other worca mail (auth/email.ts).
import { websiteHost, type Site } from '../../shared/site';
import { a, btn, code, esc, fine, h1, kicker, layout, p, quote, type MailContent } from '../auth/email';

const REQUESTER_REASON = 'You asked for access to hosted Worca.';

/** "21 October 2026" in UTC, so the date doesn't depend on where the Worker ran. */
export const mailDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function accessConfirmEmail(link: string, site: Site): MailContent {
  const subject = 'Confirm your request for hosted Worca';
  const text = `Thanks for asking for access to hosted Worca.\n\nConfirm that this address is yours, so we can review your request:\n${link}\n\nThe link works for 7 days. If you didn't ask for this, ignore this email; nothing else will be sent.\n`;
  const body =
    kicker('Hosted Worca', 'violet') +
    h1('Confirm your request') +
    p('Thanks for asking for access to hosted Worca. Confirm that this address is yours, so we can review your request.') +
    btn(link, 'Confirm my request') +
    fine("The link works for 7 days. If you didn't ask for this, ignore this email; nothing else will be sent.");
  return { subject, text, html: layout({ preheader: 'One click to confirm your request', body, reason: REQUESTER_REASON, site }), kind: 'access_request' };
}

export function accessGrantedEmail(opts: { code: string; expiresAt: number; message?: string | null; site: Site }): MailContent {
  const appUrl = opts.site.appOrigin;
  const url = `${appUrl}/sign-in#code=${encodeURIComponent(opts.code)}`;
  const until = mailDate(opts.expiresAt);
  const subject = 'Your access to hosted Worca';
  const note = opts.message?.trim() ? `\n\n${opts.message.trim()}\n` : '';
  const text = `Your request for hosted Worca was approved.${note}\n\nCreate your account: ${url}\n\nYour sign-up code: ${opts.code}\nIt works once, only with this email address, until ${until}.\n`;
  const body =
    kicker('Access granted', 'green') +
    h1('Your access to hosted Worca') +
    p('Your request was approved. Create your account with this email address; the button fills in your sign-up code for you.') +
    (opts.message?.trim() ? quote(opts.message.trim()) : '') +
    btn(url, 'Create your account') +
    p('Your sign-up code:') +
    code(opts.code, { size: 'md' }) +
    fine(`It works once, only with this email address, until ${esc(until)}. If the button doesn't work, open ${a(`${appUrl}/sign-in`, `${appUrl.replace(/^https?:\/\//, '')}/sign-in`)} and enter the code there.`);
  return { subject, text, html: layout({ preheader: 'Your sign-up code is inside', body, reason: REQUESTER_REASON, site: opts.site }), kind: 'access_request' };
}

export function accessDeclinedEmail(opts: { message?: string | null; site: Site }): MailContent {
  const subject = 'Your request for hosted Worca';
  const note = opts.message?.trim() ? `\n\n${opts.message.trim()}` : '';
  // The request form is on the operator's website; without one, no place to point at.
  const host = websiteHost(opts.site);
  const text = `Thank you for your interest in hosted Worca. We can't offer you access right now.${note}\n\nYou can ask again later${host ? ` at ${host}` : ''}.\n`;
  const body =
    kicker('Hosted Worca', 'violet') +
    h1('About your request') +
    p("Thank you for your interest in hosted Worca. We can't offer you access right now.") +
    (opts.message?.trim() ? quote(opts.message.trim()) : '') +
    fine(`You can ask again later${host ? ` at ${a(opts.site.aboutUrl, host)}` : ''}.`);
  return { subject, text, html: layout({ preheader: 'About your request for hosted Worca', body, reason: REQUESTER_REASON, site: opts.site }), kind: 'access_request' };
}

/** To superadmins: counts only, never who asked (the console shows that). */
export function accessStaffNoticeEmail(opts: { fresh: number; pending: number; site: Site }): MailContent {
  const url = `${opts.site.appOrigin}/platform/access-requests`;
  const what = opts.fresh === 1 ? 'A new access request' : `${opts.fresh} new access requests`;
  const subject = `${what} for hosted Worca`;
  const waiting = `${opts.pending} ${opts.pending === 1 ? 'request is' : 'requests are'} waiting for a decision.`;
  const text = `${what} for hosted Worca. ${waiting}\n\nReview them: ${url}\n\nAt most one of these notices is sent per hour.\n`;
  const body = kicker('Platform', 'peach') + h1(esc(what)) + p(esc(waiting)) + btn(url, 'Review requests') + fine('At most one of these notices is sent per hour.');
  return {
    subject,
    text,
    html: layout({ preheader: waiting, body, reason: 'You get this as a Worca superadmin.', site: opts.site }),
    kind: 'staff_digest',
  };
}
