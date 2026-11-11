// Newsletter mail (D70): the double opt-in mail, the manage-link mail and issues. All of it is
// sent from NEWSLETTER_FROM (EMAIL_FROM when unset). Issues carry RFC 8058 one-click unsubscribe
// headers and a footer with the reason, the manage and unsubscribe links and, when set, the
// postal address (NEWSLETTER_POSTAL_ADDRESS).
import { siteOf, websiteHost, type Site } from '../../shared/site';
import type { Env } from '../env';
import { btn, esc, fine, footLink, h1, kicker, layout, p, type MailContent } from '../auth/email';
import type { IssueRow, ReleaseLevel, ReleasePref } from './core';
import { notesHtml, notesText } from './notes';

export const newsletterFrom = (env: Env) => env.NEWSLETTER_FROM || env.EMAIL_FROM;
/** The newsletter sender usually only sends: replies go to the operator's contact address, if set. */
export const newsletterReplyTo = (site: Site): string | undefined => site.contactEmail ?? undefined;

export interface NewsletterLinks {
  manage: string; // the manage page
  unsubscribe: string; // the manage page, opened on its unsubscribe step
  oneClick: string; // RFC 8058 List-Unsubscribe target (POST unsubscribes, GET shows the page)
}

export function newsletterLinks(env: Env, token: string): NewsletterLinks {
  const t = encodeURIComponent(token);
  return {
    manage: `${env.APP_ORIGIN}/newsletter#t=${t}`,
    unsubscribe: `${env.APP_ORIGIN}/newsletter#t=${t}&u=1`,
    oneClick: `${env.APP_ORIGIN}/api/public/newsletter/unsubscribe?t=${t}`,
  };
}

/** Why a subscriber gets an issue: where they subscribed (the website), when there is one. */
export function issueReason(site: Site): string {
  const host = websiteHost(site);
  return host ? `You get this because you subscribed at ${host}.` : 'You get this because you subscribed to this newsletter.';
}

export const PREF_TEXT: Record<ReleasePref, string> = {
  none: 'no release mail',
  major: 'major releases',
  minor: 'major and minor releases',
  micro: 'every stable release, patches included',
  rc: 'every release, release candidates included',
};

export const LEVEL_TEXT: Record<ReleaseLevel, string> = {
  major: 'A major release.',
  minor: 'A feature release.',
  micro: 'A patch release.',
  rc: 'A release candidate: a preview of the next release, for testing.',
};

function subscribeReason(site: Site): string {
  const host = websiteHost(site);
  return host ? `Someone entered this address in a ${host} subscription form.` : 'Someone entered this address in a subscription form.';
}

function choiceText(releases: ReleasePref, product: boolean): string {
  const parts = [releases === 'none' ? null : `release mail for ${PREF_TEXT[releases]}`, product ? 'product news' : null].filter(Boolean);
  return parts.join(' and ');
}

function postalLine(env: Env): string | null {
  const a = env.NEWSLETTER_POSTAL_ADDRESS?.trim();
  return a ? a : null;
}

/** Footer of every issue: manage, unsubscribe, postal address (text and HTML). */
export function issueFooter(env: Env, links: NewsletterLinks): { text: string; html: string } {
  const postal = postalLine(env);
  const text = `\n--\n${issueReason(siteOf(env))}\nManage your preferences: ${links.manage}\nUnsubscribe: ${links.unsubscribe}\n${postal ? `${postal}\n` : ''}`;
  const html = `<br>${footLink(links.manage, 'Manage preferences')} &middot; ${footLink(links.unsubscribe, 'Unsubscribe')}${postal ? `<br>${esc(postal)}` : ''}`;
  return { text, html };
}

/** RFC 8058 one-click unsubscribe: providers POST `List-Unsubscribe=One-Click` to the URL. */
export const unsubscribeHeaders = (links: NewsletterLinks): Record<string, string> => ({
  'List-Unsubscribe': `<${links.oneClick}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

export function confirmSubscriptionEmail(env: Env, o: { subscriberId: string; token: string; releases: ReleasePref; product: boolean }): MailContent {
  const site = siteOf(env);
  const url = `${env.APP_ORIGIN}/newsletter#c=${encodeURIComponent(o.token)}`;
  const subject = 'Confirm your subscription to Worca news';
  const what = choiceText(o.releases, o.product);
  const text = `Confirm your subscription\n\nYou asked for ${what} from Worca. Confirm it by opening this link within 7 days:\n${url}\n\nIf you didn't ask for this, ignore this email: nothing is sent unless you confirm.\n`;
  const body =
    kicker('Newsletter', 'blue') +
    h1('Confirm your subscription') +
    p(`You asked for ${esc(what)} from Worca.`) +
    btn(url, 'Confirm subscription') +
    fine("The link works for 7 days. If you didn't ask for this, ignore this email: nothing is sent unless you confirm.");
  return {
    subject,
    text,
    html: layout({ preheader: 'One click to confirm', body, reason: subscribeReason(site), site }),
    kind: 'newsletter_confirm',
    ref: `newsletter:${o.subscriberId}:confirm`,
    from: newsletterFrom(env),
    replyTo: newsletterReplyTo(site),
  };
}

export function manageLinkEmail(env: Env, o: { subscriberId: string; token: string }): MailContent {
  const site = siteOf(env);
  const links = newsletterLinks(env, o.token);
  const subject = 'Your Worca newsletter settings';
  const text = `Your Worca newsletter settings\n\nChoose what Worca sends you, or unsubscribe:\n${links.manage}\n\nIf you didn't ask for this link, ignore this email.\n`;
  const body =
    kicker('Newsletter', 'blue') +
    h1('Your newsletter settings') +
    p('Choose which release mail and news Worca sends you, or unsubscribe.') +
    btn(links.manage, 'Manage preferences') +
    fine("If you didn't ask for this link, ignore this email. Nothing changes until you save.");
  return {
    subject,
    text,
    html: layout({ preheader: 'Your manage link', body, reason: 'Someone asked for the manage link of this subscription.', site }),
    kind: 'newsletter_confirm',
    ref: `newsletter:${o.subscriberId}:link`,
    from: newsletterFrom(env),
    replyTo: newsletterReplyTo(site),
  };
}

/** One recipient's copy of an issue. `notes` is the release's Markdown (rendered safely by notes.ts). */
export function issueMail(env: Env, issue: Pick<IssueRow, 'kind' | 'version' | 'release_level' | 'subject' | 'url'>, links: NewsletterLinks, notes: string | null): MailContent {
  const site = siteOf(env);
  const footer = issueFooter(env, links);
  const level = issue.release_level ?? 'minor';
  const lead = issue.kind === 'release' ? LEVEL_TEXT[level] : '';
  const textParts = [issue.subject, lead, notes ? notesText(notes) : '', issue.url ? `Release notes: ${issue.url}` : ''].filter(Boolean);
  const notesPart = notes ? notesHtml(notes, site) : '';
  const label = issue.kind === 'release' ? (level === 'rc' ? 'Release candidate' : 'Release') : 'News';
  const body = kicker(label, issue.kind === 'release' ? 'green' : 'blue') + h1(esc(issue.subject)) + (lead ? p(esc(lead)) : '') + notesPart + (issue.url ? btn(issue.url, 'Read the release notes') : '');
  return {
    subject: issue.subject,
    text: `${textParts.join('\n\n')}\n${footer.text}`,
    html: layout({ preheader: lead || issue.subject, body, reason: issueReason(site), site, footer: footer.html }),
    kind: 'newsletter',
    from: newsletterFrom(env),
    replyTo: newsletterReplyTo(site),
    headers: unsubscribeHeaders(links),
  };
}
