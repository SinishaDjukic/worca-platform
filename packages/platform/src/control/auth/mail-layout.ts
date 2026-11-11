// The one branded layout every worca mail goes through, styled after the Worca website: warm grey page, white rounded card, ink headings, pill buttons, Poppins and JetBrains
// Mono. Written for real mail clients, not browsers:
//  - tables for layout, every style inlined on its element (Gmail drops classes it can't match,
//    Outlook ignores most of CSS); the <style> block only adds dark mode, mobile tweaks and web
//    fonts, so a client that strips it still shows the light design;
//  - no flex, grid, var() or shorthand that Outlook (Word engine) misreads; rounded corners and
//    the max-width degrade to square and a fixed 600px ghost table there;
//  - the button is VML for classic Outlook, a padded link in a table cell everywhere else;
//  - the logo is a PNG on the app origin with width, height and alt, on its own pill, so it stays
//    legible when a client inverts the page into dark mode without telling us (Gmail apps).
// Muted text is a shade darker than the site's --ink-3 so small print stays above 4.5:1 contrast.
// The footer's operator, contact and legal links come from the deployment (Site, shared/site.ts).
import type { Site } from '../../shared/site';

/** HTML-escape for text and attribute positions. */
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const SANS = "Poppins,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
export const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

/** The Worca website's tokens (light), plus the dark values the <style> block switches to. */
const C = {
  bg: '#ECEAE4',
  card: '#FFFFFF',
  card2: '#F6F4EF',
  ink: '#19191B',
  ink2: '#56534C',
  muted: '#6B6760',
  line: '#E2DFD7',
} as const;
const D = {
  bg: '#0F0F13',
  card: '#17171D',
  card2: '#1F1F26',
  ink: '#F4F3EE',
  ink2: '#A8A6B0',
  muted: '#8E8C97',
  line: '#2A2A34',
} as const;

/** Accent dots of the kicker, as on the site (.kicker .dot). */
const TONES = { violet: '#8C7FD6', green: '#5BAE5B', peach: '#EFA63C', red: '#E76A5A', blue: '#5BA6CC' } as const;
export type Tone = keyof typeof TONES;

/** The mail logo's size when the deployment doesn't set one (Site.mailLogo, branding.mailLogoSize). */
export const DEFAULT_MAIL_LOGO = { width: 148, height: 44 } as const;

// ---- Building blocks (each returns inline-styled HTML; callers escape their own text) -------

/** A small uppercase label above the heading, with a coloured dot (the site's .kicker). */
export const kicker = (label: string, tone: Tone = 'violet') =>
  `<p class="em-fg" style="margin:0 0 14px;font-family:${SANS};font-size:11.5px;line-height:16px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${C.ink2};">` +
  `<span style="color:${TONES[tone]};font-size:12px;">&#9679;</span>&nbsp;&nbsp;${esc(label)}</p>`;

export const h1 = (t: string) =>
  `<h1 class="em-h em-h1" style="margin:0 0 16px;font-family:${SANS};font-size:26px;line-height:32px;font-weight:700;letter-spacing:-0.6px;color:${C.ink};">${t}</h1>`;

export const p = (inner: string) =>
  `<p class="em-fg" style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:24px;font-weight:400;color:${C.ink2};">${inner}</p>`;

/** Small print at the end of the card. */
export const fine = (inner: string) =>
  `<p class="em-muted" style="margin:22px 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">${inner}</p>`;

/** A section heading inside the card (release notes' "## What's Changed"). Escaped by the caller. */
export const h2 = (t: string) =>
  `<h2 class="em-h" style="margin:22px 0 10px;font-family:${SANS};font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.2px;color:${C.ink};">${t}</h2>`;

/** A bullet list; each item is already-escaped inline HTML. */
export const ul = (items: string[]) =>
  `<ul style="margin:0 0 16px;padding:0 0 0 20px;font-family:${SANS};font-size:15px;line-height:24px;color:${C.ink2};">` +
  items.map((i) => `<li class="em-fg" style="margin:0 0 6px;color:${C.ink2};">${i}</li>`).join('') +
  `</ul>`;

/** Inline code in body copy. Escaped by the caller. */
export const codeSpan = (t: string) =>
  `<code style="font-family:${MONO};font-size:13px;background:${C.card2};border:1px solid ${C.line};border-radius:6px;padding:1px 5px;color:${C.ink};">${t}</code>`;

/** Emphasis inside p(): ink colour, semibold. */
export const strong = (inner: string) => `<strong class="em-h" style="font-weight:600;color:${C.ink};">${inner}</strong>`;

/** An inline link in body copy. */
export const a = (href: string, label: string) =>
  `<a class="em-h" href="${esc(href)}" style="color:${C.ink};text-decoration:underline;font-weight:500;">${esc(label)}</a>`;

/** A footer link (muted, underlined). */
export const footLink = (href: string, label: string) =>
  `<a class="em-muted" href="${esc(href)}" style="color:${C.muted};text-decoration:underline;">${esc(label)}</a>`;

/**
 * The one primary action of a mail: the site's .btn-primary (ink pill, white label). VML for
 * classic Outlook (which can't round or pad a link), a padded link in a cell everywhere else.
 */
export const btn = (href: string, label: string) => {
  const url = esc(href);
  const text = esc(label);
  const w = Math.round(label.length * 9 + 60);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px;"><tr><td>` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:${w}px;" arcsize="50%" stroke="f" fillcolor="${C.ink}"><w:anchorlock/><center style="color:#FFFFFF;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!--><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="em-btn" bgcolor="${C.ink}" style="border-radius:999px;background:${C.ink};">` +
    `<a class="em-btn-a" href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px;">${text}</a>` +
    `</td></tr></table><!--<![endif]-->` +
    `</td></tr></table>`
  );
};

/**
 * A code to type or paste (sign-in code, sign-up code): JetBrains Mono in a --card-2 chip.
 * `size` shrinks long codes so they fit a phone screen on one line.
 */
export const code = (value: string, opts: { size?: 'lg' | 'md' } = {}) => {
  const lg = (opts.size ?? 'lg') === 'lg';
  const fs = lg ? 30 : 19;
  const ls = lg ? 8 : 2;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;border-collapse:separate;"><tr>` +
    `<td class="em-chip" bgcolor="${C.card2}" style="background:${C.card2};border:1px solid ${C.line};border-radius:12px;padding:16px ${24 - ls}px 16px 24px;">` +
    `<span class="em-h em-mono" style="font-family:${MONO};font-size:${fs}px;line-height:${fs + 8}px;font-weight:600;letter-spacing:${ls}px;color:${C.ink};white-space:nowrap;">${esc(value)}</span>` +
    `</td></tr></table>`
  );
};

/** A quoted message from a person (staff note), set apart with a rule. Plain text, escaped here. */
export const quote = (message: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 18px;border-collapse:separate;"><tr>` +
  `<td class="em-quote" bgcolor="${C.card2}" style="background:${C.card2};border-left:3px solid ${TONES.violet};border-radius:0 12px 12px 0;padding:16px 20px 2px;">` +
  message
    .split(/\n{2,}/)
    .map((para) => p(esc(para).replace(/\n/g, '<br>')))
    .join('') +
  `</td></tr></table>`;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

/**
 * Hosts whose URLs become links: the deployment's own domains (Site.linkDomains) and their
 * subdomains. Notice text can carry names people chose (orgs, instances, members), so a URL
 * anywhere else stays plain text: a branded mail must not hand out a clickable link to someone
 * else's site.
 */
export function ownHost(url: string, domains: readonly string[]): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return protocol === 'http:';
    if (protocol !== 'https:') return false;
    return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Escapes plain text and turns its http(s) URLs on the deployment's own hosts into links. */
export const linkify = (text: string, site: Pick<Site, 'linkDomains'>) => {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += esc(text.slice(last, m.index));
    out += ownHost(m[0], site.linkDomains) ? a(m[0], m[0]) : esc(m[0]);
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
};

/** Plain text as paragraphs (blank line = new paragraph), URLs linked. */
export const paragraphs = (text: string, site: Pick<Site, 'linkDomains'>) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((para) => p(linkify(para, site).replace(/\n/g, '<br>')))
    .join('');

// ---- The layout ------------------------------------------------------------------------------

export interface LayoutOptions {
  /** Hidden preview line shown next to the subject in the inbox. */
  preheader: string;
  /** The card's content, already-escaped HTML built from the blocks above. */
  body: string;
  /** Why this address got the mail (plain text). */
  reason: string;
  /** The deployment: the logo is served from the app origin's /assets/mail/; footer links. */
  site: Site;
  /** Extra footer HTML after the reason (newsletter: manage, unsubscribe, postal address). */
  footer?: string;
}

const STYLE = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin:0 !important; padding:0 !important; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
.em-logo-d { display:none; }
@media (max-width:620px) {
  .em-outer { padding:20px 12px 28px !important; }
  .em-pad { padding:30px 24px 22px !important; }
  .em-card { border-radius:22px !important; }
  .em-h1 { font-size:23px !important; line-height:29px !important; }
  .em-foot { padding:20px 12px 0 !important; }
}
@media (prefers-color-scheme: dark) {
  .em-bg { background:${D.bg} !important; }
  .em-card { background:${D.card} !important; }
  .em-chip { background:${D.card2} !important; border-color:${D.line} !important; }
  .em-quote { background:${D.card2} !important; }
  .em-h { color:${D.ink} !important; }
  .em-fg { color:${D.ink2} !important; }
  .em-muted { color:${D.muted} !important; }
  .em-btn { background:${D.ink} !important; }
  .em-btn-a { color:${D.card} !important; }
  .em-logo-l { display:none !important; }
  .em-logo-d { display:block !important; }
}
[data-ogsb] .em-bg { background:${D.bg} !important; }
[data-ogsb] .em-card { background:${D.card} !important; }
[data-ogsb] .em-chip, [data-ogsb] .em-quote { background:${D.card2} !important; }
[data-ogsc] .em-h { color:${D.ink} !important; }
[data-ogsc] .em-fg { color:${D.ink2} !important; }
[data-ogsc] .em-muted { color:${D.muted} !important; }
`;

/** Operator and contact on one line (when set), then the website, the app and the legal pages. */
function siteFooter(site: Site, origin: string, host: string): string {
  const who = [site.operatorName ? esc(site.operatorName) : null, site.contactEmail ? footLink(`mailto:${site.contactEmail}`, site.contactEmail) : null].filter(Boolean);
  const website = site.websiteUrl ? footLink(site.websiteUrl, site.websiteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')) : null;
  const links = [website, footLink(origin, host), ...site.legal.map(([label, href]) => footLink(href, label))].filter(Boolean);
  return (who.length ? `${who.join(' &middot; ')}<br>` : '') + links.join(' &middot; ');
}

/** Wraps a body (already-escaped HTML) in the shared chrome. */
export function layout(opts: LayoutOptions): string {
  const { site } = opts;
  const origin = site.appOrigin;
  const host = origin.replace(/^https?:\/\//, '');
  const LOGO = site.mailLogo;
  // The file names stay worca-logo-*: mail already sent links them (a deployment's branding/
  // mail-logo-*.png is copied over them, docs/branding.md).
  const logo = (variant: 'light' | 'dark', cls: string, extra = '') =>
    `<img class="${cls}" src="${esc(origin)}/assets/mail/worca-logo-${variant}.png" width="${LOGO.width}" height="${LOGO.height}" alt="${esc(site.productName)}" style="display:block;width:${LOGO.width}px;height:${LOGO.height}px;border:0;outline:none;font-family:${SANS};font-size:20px;font-weight:700;color:${C.ink};${extra}">`;
  return `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(opts.preheader)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>body,table,td,p,a,h1,span{font-family:'Segoe UI',Arial,sans-serif !important;} .em-mono{font-family:Consolas,'Courier New',monospace !important;}</style><![endif]-->
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@600&amp;display=swap" rel="stylesheet"><!--<![endif]-->
<style>${STYLE}</style>
</head>
<body class="em-bg" style="margin:0;padding:0;width:100%;background:${C.bg};">
<div role="article" aria-roledescription="email" aria-label="${esc(opts.preheader)}" lang="en" class="em-bg" style="background:${C.bg};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="em-bg" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" class="em-outer" style="padding:36px 16px 40px;">
<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">
  <tr><td style="padding:0 4px 20px;">
    <a href="${esc(site.websiteUrl ?? origin)}" target="_blank" style="text-decoration:none;display:inline-block;">${logo('light', 'em-logo-l')}<!--[if !mso]><!-->${logo('dark', 'em-logo-d', 'display:none;')}<!--<![endif]--></a>
  </td></tr>
  <tr><td class="em-card em-pad" bgcolor="${C.card}" style="background:${C.card};border-radius:28px;padding:44px 48px 32px;">${opts.body}</td></tr>
  <tr><td class="em-muted em-foot" style="padding:22px 28px 0;font-family:${SANS};font-size:12.5px;line-height:20px;color:${C.muted};">${esc(opts.reason)}${opts.footer ?? ''}<br><br>${siteFooter(site, origin, host)}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</div>
</body>
</html>`;
}
