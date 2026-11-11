// Server-rendered pages on the app origin: sign-in, sign-out, invitations, message pages, and the
// shell the D30 confirmation pages and /authorize answers use. They look like the web UI: they
// load the app's stylesheet (/assets/app.css, served from ui/assets by ui.ts) plus
// /assets/pages.css for the centered card layout. The sign-in script is served by routes.ts from
// this file. No inline styles or scripts, so the page CSP (middleware.ts PAGE_CSP) needs no
// inline allowances.
import { websiteHost, type Site } from '../../shared/site';
import { esc } from './email';

export const APP_CSS_PATH = '/assets/app.css';
export const PAGES_CSS_PATH = '/assets/pages.css';
/** The deployment's colour overrides (branding/theme.css; empty by default, docs/branding.md). */
export const THEME_CSS_PATH = '/assets/theme.css';
export const SIGN_IN_JS_PATH = '/auth/sign-in.js';

/**
 * A strict CSP for pages that set their own (the D30 confirmation pages): only the two
 * same-origin stylesheets, their fonts and logo, and same-origin form posts.
 */
export const STRICT_PAGE_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Icon paths from the web UI (ui/assets/js/core.mjs ICONS).
const ICONS = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  fingerprint:
    '<path d="M7 10.5a5 5 0 0 1 10 0v2.5M12 10.5v4.5c0 2.5-.8 4.6-2 6M9 21c-.6-1-1-2.6-1-4.5v-6M16.5 16.5c-.2 1.7-.6 3.1-1.2 4.3M4.5 16c-.3-1.3-.5-3.2-.5-5.5a8 8 0 0 1 14-5.3M20 9.5c.3 1 .5 2.1.5 3.5"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M10 21v-3h4v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
} as const;
export type IconName = keyof typeof ICONS;
export type GlyphColor = 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate';

const icon = (name: IconName, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

/**
 * Error feedback for the pages' scripts, as in the console (ui/assets/js/core.mjs fieldError): a
 * problem with one field shows under it (red border, aria-invalid, icon and sentence linked by
 * aria-describedby, focus, cleared on edit); a problem with the action as a whole shows in the
 * status box as a red alert with an icon. Pasted into each script; no dependencies.
 */
export const FEEDBACK_JS = `
  const ERR_ICON = ${JSON.stringify(icon('err'))};
  const FE_ICON = ${JSON.stringify(icon('err', 'i fe-ic'))};
  let feSeq = 0;
  const clearFieldError = (inp) => {
    const msg = inp && inp._feErr;
    if (!msg) return;
    msg.remove();
    for (const f of msg._fields) {
      f._feErr = null;
      f.classList.remove('field-invalid');
      f.removeAttribute('aria-invalid');
      const rest = (f.getAttribute('aria-describedby') || '').split(' ').filter((t) => t && t !== msg.id);
      if (rest.length) f.setAttribute('aria-describedby', rest.join(' ')); else f.removeAttribute('aria-describedby');
      f.removeEventListener('input', msg._off);
      f.removeEventListener('change', msg._off);
    }
  };
  // target: one input, or the inputs of a group sharing one rule (radios, checkboxes).
  const fieldError = (target, text) => {
    const fields = [].concat(target).filter(Boolean);
    if (!fields.length) return;
    fields.forEach(clearFieldError);
    const msg = document.createElement('span');
    msg.className = 'field-error';
    msg.id = 'fe-' + (++feSeq);
    msg.innerHTML = FE_ICON;
    const t = document.createElement('span');
    t.textContent = text;
    msg.append(t);
    (fields[0].closest('.field') || fields[0].parentElement).append(msg);
    msg._fields = fields;
    msg._off = () => clearFieldError(fields[0]);
    for (const f of fields) {
      f._feErr = msg;
      f.classList.add('field-invalid');
      f.setAttribute('aria-invalid', 'true');
      f.setAttribute('aria-describedby', ((f.getAttribute('aria-describedby') || '') + ' ' + msg.id).trim());
      f.addEventListener('input', msg._off);
      f.addEventListener('change', msg._off);
    }
    fields[0].focus();
  };
  const showStatus = (el, text, err) => {
    el.className = 'sp-status' + (text ? (err ? ' err' : ' info') : '');
    el.setAttribute('role', err ? 'alert' : 'status');
    el.setAttribute('aria-live', err ? 'assertive' : 'polite');
    el.textContent = '';
    if (!text) return;
    if (err) el.insertAdjacentHTML('afterbegin', ERR_ICON);
    const s = document.createElement('span');
    s.textContent = text;
    el.append(s);
  };
`;

/** The tinted round badge at the top of a message card. */
export const glyph = (name: IconName, color: GlyphColor) => `<span class="g lg ${color} sp-glyph">${icon(name)}</span>`;

export interface PageOpts {
  /** Load the sign-in script. */
  script?: boolean;
  /** Load another same-origin script instead (e.g. the access-request confirmation page's). */
  scriptPath?: string;
  /** Load another same-origin script (e.g. the newsletter page's). */
  scriptSrc?: string;
  turnstileSiteKey?: string;
  /** Extra class on the card (e.g. 'center' for message pages). */
  cardClass?: string;
  /** The deployment: the footer's "What is this?" link, the website scripts point people to. */
  site: Site;
}

/** The full HTML document: logo, one card, a short footer. `body` is trusted markup. */
export function pageDocument(title: string, body: string, opts: PageOpts): string {
  const website = websiteHost(opts.site);
  const scripts = [
    opts.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '',
    opts.script || opts.scriptPath ? `<script src="${esc(opts.scriptPath ?? SIGN_IN_JS_PATH)}" defer></script>` : '',
    opts.scriptSrc ? `<script src="${esc(opts.scriptSrc)}" defer></script>` : '',
  ].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · ${esc(opts.site.productName)}</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="preload" href="/assets/fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${APP_CSS_PATH}">
<link rel="stylesheet" href="${PAGES_CSS_PATH}">
<link rel="stylesheet" href="${THEME_CSS_PATH}">
${scripts}
</head>
<body class="sp"${website ? ` data-website="${esc(website)}"` : ''}>
<main class="sp-main">
<a class="sp-brand" href="/" aria-label="${esc(opts.site.productName)} home"><span class="logo" aria-hidden="true"></span></a>
<section class="card sp-card${opts.cardClass ? ` ${opts.cardClass}` : ''}">
${body}
</section>
<p class="sp-foot">${esc(opts.site.serviceName)} · <a href="${esc(opts.site.aboutUrl)}">What is this?</a></p>
</main>
</body>
</html>`;
}

/** Sign-in methods as an instance's policy names them (D23). */
const METHOD_LABELS: Record<string, string> = {
  'email-otp': 'an email code',
  passkey: 'a passkey',
  google: 'Google',
  microsoft: 'Microsoft',
  sso: "your company's single sign-on",
};

function orList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

export interface SignInPageOpts {
  next: string;
  google: boolean;
  microsoft: boolean;
  /** The registration mode; the optional sign-up code field shows unless it is `open`. */
  mode: 'invite_code' | 'waitlist' | 'open';
  turnstileSiteKey?: string;
  error?: string;
  /** D23: the instance this sign-in is for accepts only these methods (/authorize sent the person here). */
  methods?: string[];
  site: Site;
}

const CODE_HINT: Record<'invite_code' | 'waitlist', (site: Site) => string> = {
  invite_code: (site) =>
    `New accounts need a sign-up code while ${site.serviceName} is invite-only. Leave it empty if you already have an account or were invited to an organization.`,
  waitlist: () =>
    'Have a sign-up code? It creates your account right away. Without one, a new account joins the waitlist until it is approved. Leave it empty if you already have an account.',
};

export function signInPage(o: SignInPageOpts): string {
  const social = [
    o.google ? `<button type="button" class="btn block" data-provider="google">${icon('globe')}Continue with Google</button>` : '',
    o.microsoft ? `<button type="button" class="btn block" data-provider="microsoft">${icon('globe')}Continue with Microsoft</button>` : '',
  ].join('');
  const code =
    o.mode !== 'open'
      ? `<div class="field">
<label for="signup-code">Sign-up code <span class="opt">only for new accounts</span></label>
<input class="inp mono" id="signup-code" name="signupCode" autocomplete="off" spellcheck="false" aria-describedby="signup-code-hint">
<span class="hint" id="signup-code-hint">${esc(CODE_HINT[o.mode](o.site))}</span>
</div>`
      : '';
  const turnstile = o.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(o.turnstileSiteKey)}"></div>` : '';
  const methods = (o.methods ?? []).map((m) => METHOD_LABELS[m]).filter((m): m is string => !!m);
  const policy = methods.length
    ? `<div class="banner amber" id="policy-note">${icon('shield')}<div class="grow"><b>Sign in again to open this instance.</b> It only accepts ${esc(orList(methods))}.</div></div>`
    : '';
  const body = `<div class="sp-head">
<h1>Sign in to Worca</h1>
<p class="sp-lead">With your email, a passkey or your company account. New here? The same steps create your account.</p>
</div>
${policy}
<div id="signin" class="stack" data-next="${esc(o.next)}">
${o.error ? `<p id="status" role="alert" aria-live="assertive" class="sp-status err">${icon('err')}<span>${esc(o.error)}</span></p>` : '<p id="status" role="status" aria-live="polite" class="sp-status"></p>'}
<form id="email-step" class="form" novalidate>
<div class="field">
<label for="email">Email</label>
<input class="inp" id="email" name="email" type="email" autocomplete="username webauthn" placeholder="you@company.com" required>
</div>
${code}
${turnstile}
<button type="submit" class="btn primary block">${icon('mail')}Email me a code</button>
<button type="button" class="linkbtn sp-link" id="sso">${icon('building')}Use my company's single sign-on</button>
</form>
<form id="code-step" class="form" hidden>
<div class="field">
<label for="otp">Code from the email</label>
<input class="inp mono sp-otp" id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required aria-describedby="otp-hint">
<span class="hint" id="otp-hint">Six digits, valid for 5 minutes. Check your spam folder if it doesn't arrive.</span>
</div>
<button type="submit" class="btn primary block">Sign in</button>
<button type="button" class="linkbtn sp-link" id="restart">Use another email</button>
</form>
<div class="sp-or" role="separator"><span>or</span></div>
<div class="sp-alt">
<button type="button" class="btn block" id="passkey">${icon('fingerprint')}Sign in with a passkey</button>
${social}
</div>
</div>`;
  return pageDocument('Sign in', body, { script: true, turnstileSiteKey: o.turnstileSiteKey, site: o.site });
}

export interface MessageOpts {
  link?: { href: string; label: string };
  glyph?: [IconName, GlyphColor];
  site: Site;
}

/** A titled card with one paragraph and an optional button link. */
export function messagePage(title: string, text: string, link: { href: string; label: string } | undefined, opts: Omit<MessageOpts, 'link'>): string {
  const [g, color] = opts.glyph ?? ['info', 'slate'];
  const a = link ? `<div class="sp-actions"><a class="btn primary" href="${esc(link.href)}">${esc(link.label)}</a></div>` : '';
  return pageDocument(title, `${glyph(g, color)}<h1>${esc(title)}</h1><p class="sp-lead">${esc(text)}</p>${a}`, { cardClass: 'center', site: opts.site });
}

export function signOutPage(site: Site): string {
  const body = `${glyph('logout', 'slate')}<h1>Sign out of Worca?</h1>
<p class="sp-lead">This ends your session in this browser. Instances you opened sign you out too.</p>
<form method="post" action="/sign-out" class="sp-actions"><a class="btn" href="/">Cancel</a><button type="submit" class="btn primary">Sign out</button></form>`;
  return pageDocument('Sign out', body, { cardClass: 'center', site });
}

export function invitePage(o: { invitationId: string; orgName: string; inviterEmail?: string; site: Site }): string {
  const from = o.inviterEmail ? ` from <b>${esc(o.inviterEmail)}</b>` : '';
  const body = `${glyph('users', 'violet')}<h1>Join ${esc(o.orgName)}</h1>
<p class="sp-lead">You have an invitation${from} to join <strong>${esc(o.orgName)}</strong> on Worca. Its admins decide which instances you can open.</p>
<form method="post" action="/invite/${encodeURIComponent(o.invitationId)}" class="sp-actions"><a class="btn" href="/">Not now</a><button type="submit" class="btn primary">Accept invitation</button></form>`;
  return pageDocument('Invitation', body, { cardClass: 'center', site: o.site });
}

// Runs against the Better Auth endpoints. Kept dependency-free; `next` was sanitized server-side.
export const SIGN_IN_JS = `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const root = $('signin');
  if (!root) return;
  const next = root.dataset.next || '/';
  // A granted access request links here as /sign-in#code=<code> (D69): fill in the sign-up code.
  // The fragment never reaches the server; it is dropped from the address bar once read.
  const codeFromLink = new URLSearchParams(location.hash.slice(1)).get('code');
  if (codeFromLink) {
    if ($('signup-code')) $('signup-code').value = codeFromLink.trim();
    history.replaceState(null, '', location.pathname + location.search);
  }
  const status = $('status');
${FEEDBACK_JS}
  const say = (msg, err) => showStatus(status, msg, !!err);
  // An error that belongs to one field: shown under it instead of in the status box.
  const fieldErr = (id, message) => Object.assign(new Error(message), { field: $(id) });
  const OTP_FIELD = { INVALID_OTP: "That code isn't right. Check the email, or ask for a new code.", OTP_EXPIRED: 'That code has expired. Ask for a new one with "Use another email".' };
  const b64url = {
    decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
    encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''),
  };
  function headers() {
    const h = { 'content-type': 'application/json' };
    const codeInput = $('signup-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if (code) {
      h['x-signup-code'] = code;
      // OAuth round trips come back as plain GETs; the cookie carries the code through them.
      document.cookie = 'worca_signup_code=' + encodeURIComponent(code) + '; path=/api/auth; max-age=900; samesite=lax';
    }
    const t = document.querySelector('[name="cf-turnstile-response"]');
    if (t && t.value) h['x-turnstile-token'] = t.value;
    return h;
  }
  async function call(path, body) {
    const res = await fetch('/api/auth' + path, body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (window.turnstile && body !== undefined) window.turnstile.reset();
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || 'Something went wrong. Try again.');
      err.code = data && data.code;
      throw err;
    }
    return data;
  }
  const email = () => $('email').value.trim();
  const busy = (form, on) => { for (const b of form.querySelectorAll('button')) b.disabled = on; };
  const guard = (fn, form) => async (ev) => {
    if (ev) ev.preventDefault();
    if (form) busy(form, true);
    try { await fn(); } catch (e) {
      if (e.field) { say(''); fieldError(e.field, e.message); } else say(e.message, true);
    } finally { if (form) busy(form, false); }
  };
  const showEmailStep = () => { $('code-step').hidden = true; $('email-step').hidden = false; };
  $('email-step').addEventListener('submit', guard(async () => {
    if (!email() || !$('email').checkValidity()) throw fieldErr('email', 'Enter your email address.');
    say('Sending a code…');
    await call('/email-otp/send-verification-otp', { email: email(), type: 'sign-in' });
    $('email-step').hidden = true;
    $('code-step').hidden = false;
    $('otp').value = '';
    $('otp').focus();
    say('We sent a code to ' + email() + '.');
  }, $('email-step')));
  $('code-step').addEventListener('submit', guard(async () => {
    say('Signing in…');
    try {
      await call('/sign-in/email-otp', { email: email(), otp: $('otp').value.trim() });
    } catch (e) {
      // A new account without a (valid) sign-up code: back to the first step, where the code goes.
      if ($('signup-code') && /sign-up code/i.test(e.message)) {
        showEmailStep();
        throw fieldErr('signup-code', e.message + ' Enter it here, then ask for a new email code.');
      }
      if (OTP_FIELD[e.code]) throw fieldErr('otp', OTP_FIELD[e.code]);
      throw e;
    }
    location.assign(next);
  }, $('code-step')));
  $('restart').addEventListener('click', () => { showEmailStep(); say(''); clearFieldError($('otp')); $('email').focus(); });
  $('sso').addEventListener('click', guard(async () => {
    if (!email()) throw fieldErr('email', 'Enter your work email first.');
    const data = await call('/sign-in/sso', { email: email(), callbackURL: next });
    location.assign(data.url);
  }));
  for (const btn of document.querySelectorAll('[data-provider]')) {
    btn.addEventListener('click', guard(async () => {
      const data = await call('/sign-in/social', { provider: btn.dataset.provider, callbackURL: next });
      location.assign(data.url);
    }));
  }
  $('passkey').addEventListener('click', guard(async () => {
    if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys.');
    const opts = await call('/passkey/generate-authenticate-options');
    const publicKey = Object.assign({}, opts, {
      challenge: b64url.decode(opts.challenge),
      allowCredentials: (opts.allowCredentials || []).map((c) => Object.assign({}, c, { id: b64url.decode(c.id) })),
    });
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw new Error('No passkey was selected.');
      throw e;
    }
    if (!cred) throw new Error('No passkey was selected.');
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64url.encode(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64url.encode(r.clientDataJSON),
        authenticatorData: b64url.encode(r.authenticatorData),
        signature: b64url.encode(r.signature),
        userHandle: r.userHandle ? b64url.encode(r.userHandle) : undefined,
      },
    };
    say('Signing in…');
    await call('/passkey/verify-authentication', { response });
    location.assign(next);
  }));
})();
`;
