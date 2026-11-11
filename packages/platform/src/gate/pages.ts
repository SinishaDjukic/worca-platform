// Small pages and JSON answers the gate serves itself, in the look of the web UI (ui/assets/app.css,
// "Refined"). The gate is another origin than the app, so each page carries its own minimal
// stylesheet and, on the status pages, the status poll inline; a per-response nonce in the page's
// own CSP allows exactly those two and nothing else (no third-party or cross-origin resources:
// the logo is an inline data: mask, fonts fall back to the system's).
import { GATE_PATHS } from '../shared/contracts';
import { platform } from '../shared/platform';
import type { Site } from '../shared/site';
import { LOGO_MASK_DATA_URI } from './logo';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Tokens and components from ui/assets/app.css, reduced to what these pages use.
const LIGHT = '--bg:#F1F1EF;--panel:#FFFFFF;--field:#F6F6F4;--ink:#19191B;--ink-2:#5C5C63;--ink-3:#8E8E95;--on-ink:#FFFFFF;--line:#ECECEA;--line-2:#E3E3E0;--hover-outline:#9A9AA1;--green-bg:#E2F3DF;--green-ink:#2F7A38;--red-bg:#FBE3E0;--red-ink:#C5483A;--blue-bg:#DEEFF7;--blue-ink:#2B6A8C;--amber-bg:#FCE8C8;--amber-ink:#A66510;--violet-bg:#EAE6F8;--violet-ink:#6353B8;--slate-bg:#E8ECF0;--slate-ink:#58646F;--shadow:0 6px 28px rgba(25,25,27,.05),0 1px 2px rgba(25,25,27,.04);';
const DARK = '--bg:#161614;--panel:#222220;--field:#2C2C29;--ink:#ECECE8;--ink-2:#B4B4AE;--ink-3:#9E9E98;--on-ink:#161614;--line:#30302D;--line-2:#494944;--hover-outline:#9E9E98;--green-bg:#1C2F1D;--green-ink:#8FD48F;--red-bg:#34201D;--red-ink:#F08C7E;--blue-bg:#1A2A33;--blue-ink:#86C4E3;--amber-bg:#332715;--amber-ink:#F0B45A;--violet-bg:#262336;--violet-ink:#B3A8EE;--slate-bg:#262A2E;--slate-ink:#B3BEC8;--shadow:0 6px 28px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.35);color-scheme:dark;';
/** The logo rule: the deployment's gate logo (definePlatform branding.gateLogo), else Worca's. */
function logoCss(): string {
  const own = platform()?.branding.gateLogo;
  const uri = own?.dataUri ?? LOGO_MASK_DATA_URI;
  const aspect = own?.aspect ?? '205/76';
  return `.logo{display:block;align-self:center;height:40px;aspect-ratio:${aspect};background:var(--ink);-webkit-mask:url(${uri}) center/contain no-repeat;mask:url(${uri}) center/contain no-repeat}`;
}

/** The pages' stylesheet; the logo rule comes from logoCss(). */
const GATE_CSS_BASE =
  `:root{${LIGHT}color-scheme:light dark;--sans:'Poppins',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}` +
  `@media (prefers-color-scheme:dark){:root{${DARK}}}` +
  '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}' +
  'main{width:min(440px,100%);margin:0 auto;padding:clamp(28px,9vh,96px) 16px 32px;display:flex;flex-direction:column;gap:22px}' +
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:30px 28px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px}' +
  'h1{font-size:24px;font-weight:700;letter-spacing:-.025em;line-height:1.2;margin:0;text-wrap:balance;overflow-wrap:anywhere}' +
  'p{margin:0;color:var(--ink-2);max-width:38ch}a{color:var(--blue-ink)}:focus-visible{outline:2px solid var(--ink);outline-offset:2px}' +
  '.mono{font-family:var(--mono);font-size:13px;color:var(--ink);overflow-wrap:anywhere}' +
  '.g{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}.g svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}' +
  '.green{background:var(--green-bg);color:var(--green-ink)}.blue{background:var(--blue-bg);color:var(--blue-ink)}.amber{background:var(--amber-bg);color:var(--amber-ink)}' +
  '.red{background:var(--red-bg);color:var(--red-ink)}.violet{background:var(--violet-bg);color:var(--violet-ink)}.slate{background:var(--slate-bg);color:var(--slate-ink)}' +
  '.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px}' +
  '.phase{font-size:13px;color:var(--ink-3)}.phase:empty{display:none}' +
  '.acts{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:4px}' +
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--panel);border:1.5px solid var(--line-2);color:var(--ink);font:600 13px var(--sans);padding:10px 18px;border-radius:999px;text-decoration:none;white-space:nowrap}' +
  '.btn:hover{border-color:var(--hover-outline)}.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}' +
  '.foot{margin:0 auto;text-align:center;font-size:12.5px;color:var(--ink-3)}.foot a{color:var(--ink-2);font-weight:500}' +
  '.spin svg{animation:spin 1.4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin svg{animation:none}}' +
  '@media (max-width:480px){.card{padding:24px 18px}h1{font-size:22px}}';

// Icon paths from the web UI (ui/assets/js/core.mjs ICONS).
const ICONS = {
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
} as const;
type Glyph = [keyof typeof ICONS, 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate', spin?: boolean];

const glyph = ([name, color, spin]: Glyph) =>
  `<span class="g ${color}${spin ? ' spin' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg></span>`;

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** The page CSP: the inline stylesheet and script of this response only, the logo, the status poll. */
export function pageCsp(n: string): string {
  return `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

interface PageSpec {
  title: string;
  glyph: Glyph;
  /** Trusted markup: paragraphs, actions. */
  body: string;
  /** Inline script source (without the tag). */
  script?: string;
}

function page(p: PageSpec, n: string, site: Site): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex"><title>${escapeHtml(p.title)} · ${escapeHtml(site.productName)}</title>
<style nonce="${n}">${GATE_CSS_BASE}${logoCss()}</style>
</head><body><main><span class="logo" role="img" aria-label="${escapeHtml(site.productName)}"></span>
<section class="card">${glyph(p.glyph)}<h1>${escapeHtml(p.title)}</h1>${p.body}</section>
<p class="foot">${escapeHtml(site.serviceName)} · <a href="${escapeHtml(site.aboutUrl)}">What is this?</a></p>
</main>${p.script ? `<script nonce="${n}">${p.script}</script>` : ''}</body></html>`;
}

/** Every page carries the deployment's "What is this?" link (Site.aboutUrl) in its footer. */
export function htmlResponse(site: Site, status: number, spec: PageSpec, init: ResponseInit = {}): Response {
  const n = nonce();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', pageCsp(n));
  return new Response(page(spec, n, site), { ...init, status, headers });
}

export function jsonResponse(status: number, data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, status, headers });
}

const button = (href: string, label: string, primary = false) =>
  `<a class="btn${primary ? ' primary' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

/**
 * No instance at this host (or not a host the gate serves). `host` is shown when it is a
 * well-formed instance host; `appOrigin` links to the app.
 */
export function notFoundPage(site: Site, o: { host?: string | null; appOrigin?: string } = {}): Response {
  const where = o.host ? `at <span class="mono">${escapeHtml(o.host)}</span>` : 'at this address';
  const app = o.appOrigin ? button(o.appOrigin, 'Open Worca', true) : '';
  return htmlResponse(site, 404, {
    title: 'No instance here',
    glyph: ['search', 'slate'],
    body: `<p>There is no Worca instance ${where}. Check the address, or find your instances in Worca.</p><div class="acts">${app}${button(site.aboutUrl, `What is ${site.serviceName}?`)}</div>`,
  });
}

/** G1: the wake sub-state as the starting page words it (ControlRpcApi.wakePhase). */
export const WAKE_PHASE_TEXT = { starting: 'Starting services…', waiting: 'Waiting for Worca…' } as const;

/**
 * Polls the status path and reloads once the instance runs (instance-lifecycle.md, Waking). The
 * status answer carries the wake's phase (G1), shown under the text while it lasts.
 */
function pollScript(phases: boolean): string {
  return `(function(){var t=${JSON.stringify(phases ? WAKE_PHASE_TEXT : {})};function poll(){fetch(${JSON.stringify(GATE_PATHS.status)},{credentials:'same-origin'})
.then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.status==='running'){location.reload();return}
var p=document.getElementById('phase');if(p&&j&&t[j.phase]){p.textContent=t[j.phase]}setTimeout(poll,3000)})
.catch(function(){setTimeout(poll,5000)})}setTimeout(poll,1000)})()`;
}

/** Suspended for the moment, waking (D27): the visit started the wake; reloads when it runs. */
export function startingPage(site: Site): Response {
  return htmlResponse(site, 
    503,
    {
      title: 'Waking up',
      glyph: ['loader', 'blue', true],
      body:
        '<span class="pill blue">Suspended for the moment</span>' +
        '<p>This instance was asleep while nobody used it and is starting now. This page reloads by itself when it is ready, usually within a minute or two.</p>' +
        '<p id="phase" class="phase" aria-live="polite"></p>',
      script: pollScript(true),
    },
    { headers: { 'retry-after': '5' } },
  );
}

export function upgradingPage(site: Site): Response {
  return htmlResponse(site, 
    503,
    {
      title: 'Upgrading',
      glyph: ['refresh', 'violet', true],
      body: '<p>This instance is being upgraded to a new Worca version. This page reloads by itself when it is done, usually within a few minutes.</p><p id="phase" class="phase" aria-live="polite"></p>',
      script: pollScript(false),
    },
    { headers: { 'retry-after': '30' } },
  );
}

export function creatingPage(site: Site): Response {
  return htmlResponse(site, 
    503,
    {
      title: 'Being set up',
      glyph: ['loader', 'blue', true],
      body: '<p>This instance is still being set up. This page reloads by itself when it is ready, usually within a few minutes.</p><p id="phase" class="phase" aria-live="polite"></p>',
      script: pollScript(false),
    },
    { headers: { 'retry-after': '30' } },
  );
}

/** Where to report abuse: the deployment's address and form, whichever are set. */
function abuseReport(site: Site): string {
  const mail = site.abuseEmail ? `write to <a href="mailto:${escapeHtml(site.abuseEmail)}">${escapeHtml(site.abuseEmail)}</a>` : null;
  const form = site.abuseUrl ? `use the form on <a href="${escapeHtml(site.abuseUrl)}">${escapeHtml(new URL(site.abuseUrl).hostname)}</a>` : null;
  const ways = [mail, form].filter(Boolean);
  return ways.length ? `<p>To report abuse, ${ways.join(' or ')}.</p>` : '';
}

/** D47, D58: stopped for abuse; never wakes on a visit. */
export function stoppedPage(site: Site): Response {
  return htmlResponse(site, 403, {
    title: 'Stopped by the platform',
    glyph: ['stop', 'red'],
    body:
      '<p>This instance has been stopped by the platform operator and does not start on a visit. Its administrators have been notified; contact them if you need it.</p>' +
      abuseReport(site),
  });
}

/** Seconds before the "isn't answering" page tries again by itself. */
export const UNRESPONSIVE_RETRY_SECONDS = 20;

/** Counts down in #retry-in and reloads; the page answers again with whatever the instance does then. */
function retryScript(seconds: number): string {
  return `(function(){var n=${seconds},e=document.getElementById('retry-in');var t=setInterval(function(){n-=1;if(e)e.textContent=String(Math.max(n,0));if(n<=0){clearInterval(t);location.reload()}},1000)})()`;
}

/** A same-origin path to retry: never protocol-relative, never another origin. */
function retryPath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
}

/**
 * The gate object says running, but the instance didn't send response headers in time (504) or
 * couldn't be reached at all (502): worca crashed, is restarting, or is stuck. Shown instead of
 * letting the browser hang; it tries again by itself.
 */
export function unresponsivePage(site: Site, o: { host: string; path?: string; appOrigin?: string; status?: 502 | 504 }): Response {
  const app = o.appOrigin ? button(o.appOrigin, 'Your instances') : '';
  return htmlResponse(site, 
    o.status ?? 504,
    {
      title: `${o.host} isn't answering right now`,
      glyph: ['alert', 'amber'],
      body:
        '<span class="pill amber">Not answering</span>' +
        '<p>The instance is meant to be running but did not answer in time. It may be restarting or busy; if this keeps happening, tell its administrators.</p>' +
        `<p class="phase" aria-live="polite">Trying again in <span id="retry-in">${UNRESPONSIVE_RETRY_SECONDS}</span> s</p>` +
        `<div class="acts">${button(retryPath(o.path ?? '/'), 'Try again now', true)}${app}</div>`,
      script: retryScript(UNRESPONSIVE_RETRY_SECONDS),
    },
    { headers: { 'retry-after': String(UNRESPONSIVE_RETRY_SECONDS) } },
  );
}

/** security.md "Low" row: a cookie flood; clear cookies on this site and sign in again. */
export function recoveryPage(site: Site): Response {
  return htmlResponse(site, 
    400,
    {
      title: 'Your browser sent too many cookies',
      glyph: ['alert', 'amber'],
      body: `<p>The cookies for this site were too large or damaged and have been cleared. Continue to sign in again.</p><div class="acts">${button('/', 'Continue', true)}</div>`,
    },
    { headers: { 'clear-site-data': '"cookies"' } },
  );
}

export function signedOutPage(site: Site, headers: HeadersInit = {}): Response {
  return htmlResponse(site, 
    200,
    {
      title: 'Signed out',
      glyph: ['logout', 'slate'],
      body: `<p>You are signed out of this instance. Your Worca account stays signed in.</p><div class="acts">${button('/', 'Sign in again', true)}</div>`,
    },
    { headers },
  );
}

export function errorPage(site: Site, status: number, message: string): Response {
  return htmlResponse(site, status, {
    title: 'Something went wrong',
    glyph: ['alert', 'amber'],
    body: `<p>${escapeHtml(message)}</p><div class="acts">${button('/', 'Open the instance again', true)}</div>`,
  });
}
