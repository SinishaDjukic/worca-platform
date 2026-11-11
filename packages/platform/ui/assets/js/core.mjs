// Shared runtime of the console UI: escaping templates, icons, the API client, the router,
// dialogs, toasts, polling, passkeys and the protected-action flow (D24, D30, D31).
// Plain ES modules, no build step, no dependencies (like worca's own UI in worca-cc/ui/public).
//
// Conventions every view follows:
// - Markup comes from the `html` tagged template: interpolated values are escaped unless they are
//   themselves `html`/`raw` results. Never build markup by string concatenation of data.
// - No inline style attributes (the CSP is style-src 'self'); use classes from app.css, or set
//   element.style from JS (allowed) for computed widths.
// - A view is { path, area, nav, title, render(ctx) } and lives in js/views/*.mjs (see main.mjs).

export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  team: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.2"/><circle cx="19" cy="10" r="2.2"/><path d="M7 20c.4-3 2.4-5 5-5s4.6 2 5 5M1.5 19c.3-2 1.5-3.3 3.3-3.6M22.5 19c-.3-2-1.5-3.3-3.3-3.6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7.5V12l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  fingerprint: '<path d="M7 10.5a5 5 0 0 1 10 0v2.5M12 10.5v4.5c0 2.5-.8 4.6-2 6M9 21c-.6-1-1-2.6-1-4.5v-6M16.5 16.5c-.2 1.7-.6 3.1-1.2 4.3M4.5 16c-.3-1.3-.5-3.2-.5-5.5a8 8 0 0 1 14-5.3M20 9.5c.3 1 .5 2.1.5 3.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M10 21v-3h4v3"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1Z"/><path d="M14 5v14" stroke-dasharray="2 2.5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.5"/>',
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  question: '<path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 18h.01"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
};

// ---- markup ---------------------------------------------------------------------------------
class Html {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Trusted markup (icons, already-built fragments). Never pass user or API data. */
export const raw = (s) => new Html(String(s ?? ''));
const part = (v) => (v instanceof Html ? v.s : Array.isArray(v) ? v.map(part).join('') : v === null || v === undefined || v === false ? '' : esc(v));
/** html`<b>${name}</b>`: escapes every value; arrays are joined; null/undefined/false render nothing. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Html(out);
}
export const icon = (name, cls = 'i') => raw(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
/** Replaces el's content with markup. */
export function setHtml(el, markup) { el.innerHTML = part(markup); return el; }

// ---- formatting -----------------------------------------------------------------------------
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const toMs = (t) => (t === null || t === undefined || t === '' ? null : typeof t === 'number' ? t : Date.parse(t));
/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Sep"; future times: "in 5 min". */
export function relTime(t) {
  const ms = toMs(t);
  if (ms === null || Number.isNaN(ms)) return '—';
  const d = Date.now() - ms, a = Math.abs(d), fut = d < 0;
  const say = (s) => (fut ? `in ${s}` : `${s} ago`);
  if (a < 45e3) return fut ? 'in a moment' : 'just now';
  if (a < 3600e3) return say(`${Math.round(a / 60e3)} min`);
  if (a < 86400e3) return say(`${Math.round(a / 3600e3)} h`);
  if (!fut && a < 2 * 86400e3) return 'yesterday';
  if (a < 7 * 86400e3) return say(`${Math.round(a / 86400e3)} days`);
  return dateShort(ms);
}
export function dateShort(t) {
  const ms = toMs(t);
  if (ms === null || Number.isNaN(ms)) return '—';
  const d = new Date(ms), now = new Date();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export function dateTime(t) {
  const ms = toMs(t);
  if (ms === null || Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Compute facts (src/control/instances/compute-facts.ts): what the compute provider reports for an instance.
/** The instance's services as the consoles name them. */
export const COMPUTE_SERVICES = [['worca', 'Worca'], ['broker', 'Broker'], ['cloudflared', 'Tunnel']];
/** Providers report in decimal units (Railway does): 4000 MB is 4 GB. */
export const gbOf = (mb) => `${+(mb / 1000).toFixed(1)} GB`;
const known = (v) => v !== null && v !== undefined;
/** One service's resources, e.g. "2 vCPU · 4 GB · 50 GB volume"; "—" when nothing is known. */
export function serviceSize(s) {
  if (!s) return '—';
  const parts = [
    known(s.cpu) ? `${s.cpu} vCPU` : null,
    known(s.memoryMb) ? gbOf(s.memoryMb) : null,
    known(s.volumeMb) ? `${gbOf(s.volumeMb)} volume` : null,
  ];
  return parts.filter(Boolean).join(' · ') || '—';
}

export const SIGN_IN_METHOD = { 'email-otp': 'Email code', passkey: 'Passkey', google: 'Google', microsoft: 'Microsoft', sso: 'Single sign-on' };

// ---- status vocabulary ------------------------------------------------------------------------
/** Instance states, shown the way worca shows run states. `motion`: spin only round icons; others pulse. */
export const STATUS = {
  running: { tone: 'green', icon: 'check', label: 'Running', line: 'Ready to open' },
  suspended: { tone: 'blue', icon: 'moon', label: 'Asleep', line: 'Wakes in a few seconds when opened' },
  creating: { tone: 'violet', icon: 'loader', label: 'Creating', line: 'Setting up, a few minutes', motion: 'spin' },
  upgrading: { tone: 'violet', icon: 'arrowUp', label: 'Upgrading', line: 'Back in a minute', motion: 'pulse' },
  stopped: { tone: 'red', icon: 'stop', label: 'Stopped', line: 'Stopped by the platform' },
  deleting: { tone: 'slate', icon: 'trash', label: 'Deleting', line: 'Being removed', motion: 'pulse' },
  failed: { tone: 'red', icon: 'alert', label: 'Failed', line: 'Setup did not finish' },
  degraded: { tone: 'amber', icon: 'alert', label: 'Degraded', line: 'Running, but reports a problem' },
};
const statusOf = (s) => STATUS[s] || { tone: 'slate', icon: 'info', label: s || 'Unknown', line: '' };
export const glyph = (status, big = false) => {
  const s = statusOf(status);
  return html`<span class="g ${s.tone}${big ? ' lg' : ''}${s.motion ? ` ${s.motion}` : ''}" title="${s.label}">${icon(s.icon)}</span>`;
};
export const statusPill = (status) => html`<span class="pill ${statusOf(status).tone}">${statusOf(status).label}</span>`;
/** running + health 'degraded' is shown as degraded; a create that stopped with an error as failed. */
export const shownStatus = (inst) => {
  if (inst.status === 'creating' && inst.error) return 'failed';
  return inst.status === 'running' && inst.health && inst.health !== 'ok' ? 'degraded' : inst.status;
};
export const statusLine = (status) => statusOf(status).line;

// ---- API --------------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, code, body) {
    super(code || `http_${status}`);
    this.status = status;
    this.code = code || `http_${status}`;
    this.body = body || {};
  }
}
/** Plain-language text for the error codes views don't handle themselves. */
const ERROR_TEXT = {
  unauthenticated: 'Your session ended. Sign in again.',
  forbidden: "You don't have permission to do that.",
  not_found: 'Not found. It may have been removed.',
  mfa_required: 'This needs a passkey sign-in.',
  passkey_required: 'This needs a passkey sign-in.',
  account_not_active: 'Your account is not active.',
  invalid_body: 'Some fields are not valid.',
  tier_limit: 'Your plan has no room for another one.',
  internal_error: 'Something went wrong on our side. Try again.',
  network: `Couldn't reach ${typeof location !== 'undefined' ? location.host : 'the server'}. Check your connection.`,
};
export const errorText = (e) => (e instanceof ApiError ? ERROR_TEXT[e.code] || e.code.replace(/_/g, ' ') : String(e?.message || e));

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, 'unauthenticated', data);
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || data?.code || data?.message, data);
  return data ?? {};
}
/** Same-origin JSON API. Errors throw ApiError { status, code, body }. 2xx bodies are returned
 *  as-is; callers that care about 202 vs 200 use api.raw. */
export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p, b) => request('DELETE', p, b),
  /** Like request, but resolves { status, body } for any 2xx. */
  async raw(method, p, b) {
    const res = await fetch(p, {
      method, credentials: 'same-origin',
      headers: b === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    }).catch(() => { throw new ApiError(0, 'network'); });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new ApiError(res.status, data?.error || data?.code || data?.message, data);
    return { status: res.status, body: data ?? {} };
  },
};
/** Path helper: p`/api/orgs/${id}/members` encodes each value. */
export const p = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');

// ---- dialogs and toasts -------------------------------------------------------------------------
/** Opens a modal with the given markup; returns the modal element. One modal at a time. */
export function openModal(markup, { wide = false, onClose } = {}) {
  closeModal();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'scrim';
  scrim._onClose = onClose;
  const m = document.createElement('div');
  m.className = `modal${wide ? ' wide' : ''}`;
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  setHtml(m, markup);
  scrim.appendChild(m);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  for (const x of $$('[data-close]', m)) x.addEventListener('click', () => closeModal());
  document.body.appendChild(scrim);
  const first = m.querySelector('input:not([type=hidden]),select,textarea,button.primary');
  if (first) first.focus();
  return m;
}
export function closeModal() {
  const s = $('#scrim');
  if (!s) return;
  s.remove();
  if (s._onClose) s._onClose();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---- feedback (as worca's ui/public/feedback.mjs, #555): report each result once, where the eyes
// are, icon + words. Toasts for what happens elsewhere or later and for dialog decisions; a form's
// save on its button (busy … done); validation under the field; in-place refusals in an alertBox.
const TOAST_MAX = 3;
const TOAST_MS = 5000;
const TOAST_TONE = { ok: 'ok', error: 'err', err: 'err', warn: 'warn', info: 'info' };
const TOAST_ICON = { ok: 'check', err: 'err', warn: 'alert', info: 'info' };
function toastRegion() {
  let r = $('#toasts');
  if (!r) {
    r = document.createElement('div');
    r.id = 'toasts';
    r.className = 'toasts';
    r.setAttribute('aria-live', 'polite');
    document.body.appendChild(r);
  }
  return r;
}
function dropToast(t) { t._stop?.(); t.remove(); }
/** Closes after `ms`, paused while hovered or focused. */
function autoClose(t, ms) {
  let left = ms, started = 0, timer = null, hovered = false;
  const start = () => { if (timer || !t.isConnected) return; started = Date.now(); timer = setTimeout(() => dropToast(t), left); };
  const pause = () => { if (!timer) return; clearTimeout(timer); timer = null; left = Math.max(0, left - (Date.now() - started)); };
  t.addEventListener('mouseenter', () => { hovered = true; pause(); });
  t.addEventListener('mouseleave', () => { hovered = false; if (!t.contains(document.activeElement)) start(); });
  t.addEventListener('focusin', pause);
  t.addEventListener('focusout', (e) => { if (!hovered && !t.contains(e.relatedTarget)) start(); });
  t._stop = () => { clearTimeout(timer); timer = null; };
  start();
}
/**
 * A toast, bottom right. kind: 'ok' (default) | 'info' | 'warn' | 'error'. ok and info close after
 * 5 s (paused on hover or focus); warn and error stay until dismissed. opts: { detail, action:
 * { label, run } (Undo, Open, Retry, Details), key (replaces an older toast with the same key),
 * timeout }. At most 3: the oldest non-error goes first. Never moves focus. Returns { el, close }.
 */
export function toast(text, kind = 'ok', { detail = '', action = null, key = null, timeout } = {}) {
  const tone = TOAST_TONE[kind] || 'info';
  const r = toastRegion();
  const all = () => $$('.toast', r);
  if (key) for (const old of all()) if (old.dataset.key === key) dropToast(old);
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  if (key) t.dataset.key = key;
  t.setAttribute('role', tone === 'err' ? 'alert' : 'status');
  setHtml(t, html`<span class="ti">${icon(TOAST_ICON[tone])}</span><div class="tb"><div class="tt">${text}</div>${detail ? html`<div class="td">${detail}</div>` : ''}${action ? html`<button type="button" class="btn sm toast-act">${action.label}</button>` : ''}</div><button type="button" class="toast-x" aria-label="Dismiss" title="Dismiss">${icon('x')}</button>`);
  $('.toast-x', t).addEventListener('click', () => dropToast(t));
  if (action) $('.toast-act', t).addEventListener('click', () => { dropToast(t); action.run(); });
  r.appendChild(t);
  for (let list = all(); list.length > TOAST_MAX; list = all()) {
    dropToast(list.slice(0, -1).find((n) => !n.classList.contains('err') && !n.classList.contains('warn')) || list[0]);
  }
  const ms = timeout !== undefined ? timeout : tone === 'err' || tone === 'warn' ? 0 : TOAST_MS;
  if (ms > 0) autoClose(t, ms);
  return { el: t, close: () => dropToast(t) };
}
/** A polite screen-reader line (a button's "Saved" state). */
function announce(text) {
  const r = toastRegion();
  let s = $('.toasts-sr', r);
  if (!s) { s = document.createElement('span'); s.className = 'toasts-sr'; r.prepend(s); }
  s.textContent = '';
  setTimeout(() => { s.textContent = text; }, 50);
}
let feSeq = 0;
const tokens = (f) => (f.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
function clearOne(msg) {
  for (const f of msg._fields || []) {
    f.classList.remove('field-invalid');
    f.removeAttribute('aria-invalid');
    const rest = tokens(f).filter((id) => id !== msg.id);
    if (rest.length) f.setAttribute('aria-describedby', rest.join(' ')); else f.removeAttribute('aria-describedby');
    f.removeEventListener('input', f._feOnEdit);
    f.removeEventListener('change', f._feOnEdit);
    delete f._feErr;
  }
  msg.remove();
}
/**
 * Mark a field (or several that share one rule, e.g. a group of checkboxes) invalid, as worca
 * does: red border, aria-invalid, a sentence under the field linked by aria-describedby, focus on
 * the first. Editing any of them clears it. Form-wide problems stay in a banner, not here.
 */
export function fieldError(target, message, { focus = true } = {}) {
  const fields = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (!fields.length) return null;
  for (const f of fields) if (f._feErr) clearOne(f._feErr);
  const msg = document.createElement('span');
  msg.className = 'field-error';
  msg.id = `fe-${++feSeq}`;
  setHtml(msg, html`${icon('err', 'i fe-ic')}<span>${message}</span>`);
  const host = fields[0].closest('.field') || fields[0].parentElement;
  host.append(msg);
  msg._fields = fields;
  const onEdit = () => clearOne(msg);
  for (const f of fields) {
    f.classList.add('field-invalid');
    f.setAttribute('aria-invalid', 'true');
    f.setAttribute('aria-describedby', [...tokens(f), msg.id].join(' '));
    f._feErr = msg;
    f._feOnEdit = onEdit;
    f.addEventListener('input', onEdit);
    f.addEventListener('change', onEdit);
  }
  if (focus) fields[0].focus?.();
  return msg;
}
/** Remove every field error inside `root`. */
export function clearFieldErrors(root) {
  for (const m of root?.querySelectorAll('.field-error') || []) clearOne(m);
}
/** A problem with the form or action as a whole: a red alert box, hidden until showAlert. */
export const alertBox = (id, cls = '') => html`<div class="banner red${cls ? ` ${cls}` : ''}" id="${id}" role="alert" hidden>${icon('err')}<div class="grow"></div></div>`;
/** Shows `text` in an alertBox; empty text hides it. */
export function showAlert(el, text) {
  if (!el) return;
  $('.grow', el).textContent = text || '';
  el.hidden = !text;
}
export function copyText(text) {
  try {
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it', 'info'));
  } catch {
    toast('Select the text and copy it', 'info');
  }
}
/**
 * Runs fn with the button disabled; a throw becomes an error toast and the button goes back at once.
 * With { done: 'Saved' } the button carries the result, as worca's withButton: spinner and `busy`
 * label while running, then a green "✓ Saved" for 2 s, then idle. fn returning false means it
 * reported a problem itself (field error, alert box): no "done". idleDisabled() decides whether
 * the idle button is disabled (e.g. Save while nothing changed).
 */
export async function busy(btn, fn, { done = '', busy: busyLabel = 'Saving…', doneMs = 2000, idleDisabled = () => false } = {}) {
  if (btn?.dataset.fbState === 'busy') return undefined;
  const states = !!(btn && done);
  if (states && !btn._fbIdle) btn._fbIdle = [...btn.childNodes];
  const toIdle = () => {
    clearTimeout(btn._fbTimer);
    if (btn._fbIdle) { btn.replaceChildren(...btn._fbIdle); btn._fbIdle = null; }
    btn.classList.remove('is-busy', 'is-done');
    btn.removeAttribute('aria-busy');
    delete btn.dataset.fbState;
    btn.disabled = !!idleDisabled();
  };
  if (states) clearTimeout(btn._fbTimer);
  if (btn) btn.disabled = true;
  if (states) {
    btn.dataset.fbState = 'busy';
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    setHtml(btn, html`<span class="btn-spin" aria-hidden="true"></span>${busyLabel}`);
  }
  let res, ok = false;
  try {
    res = await fn();
    ok = res !== false;
  } catch (e) {
    toast(errorText(e), 'error');
  }
  if (!btn || !btn.isConnected) return res;
  if (!states || !ok) { if (states) toIdle(); else btn.disabled = false; return res; }
  const hadFocus = document.activeElement === btn || document.activeElement === document.body;
  btn.dataset.fbState = 'done';
  btn.classList.replace('is-busy', 'is-done');
  btn.removeAttribute('aria-busy');
  btn.disabled = false;
  setHtml(btn, html`${icon('check')}${done}`);
  if (hadFocus) btn.focus();
  announce(done);
  btn._fbTimer = setTimeout(toIdle, doneMs);
  return res;
}

// ---- watching what this tab started (#555: what finishes elsewhere or later → a toast) ---------
const WATCH_MS = 10_000;
const WATCH_CAP_MS = 45 * 60_000;
const WATCH_STORE = 'worca.watches';
const watches = new Map();
let watchTimer = null;
let watchBusy = false;
function saveWatches() {
  try { sessionStorage.setItem(WATCH_STORE, JSON.stringify([...watches.values()])); } catch { /* per-tab convenience only */ }
}
/** 'done' | 'failed' | 'gone' (stop watching quietly) | null (still going) */
const WATCH_CHECK = {
  // An instance operation of `kind` started at or after `since` (GET instance: op, error).
  op: (w, inst) => {
    const op = inst.op;
    if (!op || (op.startedAt && op.startedAt < w.since)) return null;
    if (op.kind !== w.kind) return 'gone'; // something newer took over; its page shows it
    if (op.status === 'done') return 'done';
    if (op.status === 'failed' || (w.kind === 'create' && inst.error)) return 'failed';
    return null;
  },
  // An org key rotation's re-encryption (GET …/keys: reencryption.status).
  keys: (w, k) => {
    if (w.version && k.version !== w.version) return null;
    const st = k.reencryption?.status;
    return st === 'done' ? 'done' : st === 'incomplete' ? 'failed' : null;
  },
};
async function watchTick() {
  if (watchBusy || document.hidden) return;
  watchBusy = true;
  try {
    for (const [key, w] of [...watches]) {
      let state;
      try {
        state = Date.now() > w.until ? 'gone' : WATCH_CHECK[w.type](w, await api.get(w.url));
      } catch (e) {
        state = e instanceof ApiError && (e.status === 404 || e.status === 403) ? 'gone' : null;
      }
      if (!state) continue;
      watches.delete(key);
      // On the page that shows it already: no toast.
      if (state === 'gone' || location.pathname === w.href) continue;
      const open = () => navigate(w.href);
      if (state === 'done') toast(w.ok, 'ok', { action: { label: 'Open', run: open }, key });
      else toast(w.fail, 'error', { action: { label: 'Details', run: open }, key });
    }
  } finally {
    watchBusy = false;
    saveWatches();
    if (!watches.size) { clearInterval(watchTimer); watchTimer = null; }
  }
}
/**
 * Watches something this tab started until it finishes, at most 45 minutes: polls `url` every
 * 10 s. type 'op': the instance's operation of `kind` (create, upgrade, lift, reconfigure); type
 * 'keys': an org key rotation to `version`. When it finishes while the person isn't on `href` (the page that
 * shows it), a toast: `ok` with Open, or `fail` with Details (stays). Kept in sessionStorage, so
 * it survives in-app navigation and a reload of this tab.
 */
export function watchOp({ type = 'op', url, href, kind = '', version = null, ok, fail }) {
  watches.set(`${url}|${kind}`, { type, url, href, kind, version, ok, fail, since: Date.now() - 60_000, until: Date.now() + WATCH_CAP_MS });
  saveWatches();
  if (!watchTimer) watchTimer = setInterval(watchTick, WATCH_MS);
}
try {
  for (const w of JSON.parse(sessionStorage.getItem(WATCH_STORE) || '[]')) if (w && w.until > Date.now() && WATCH_CHECK[w.type]) watches.set(`${w.url}|${w.kind}`, w);
} catch { /* nothing kept */ }
if (watches.size) watchTimer = setInterval(watchTick, WATCH_MS);

// ---- passkeys -----------------------------------------------------------------------------------
const b64url = {
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};
/** Signs in with a passkey (step-up, D24): the new session has mfa = true. Reloads `me`. */
export async function passkeySignIn() {
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys.');
  const opts = await api.get('/api/auth/passkey/generate-authenticate-options');
  const publicKey = {
    ...opts,
    challenge: b64url.decode(opts.challenge),
    allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64url.decode(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey });
  if (!cred) throw new Error('No passkey was selected.');
  const r = cred.response;
  await api.post('/api/auth/passkey/verify-authentication', {
    response: {
      id: cred.id, rawId: b64url.encode(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64url.encode(r.clientDataJSON),
        authenticatorData: b64url.encode(r.authenticatorData),
        signature: b64url.encode(r.signature),
        userHandle: r.userHandle ? b64url.encode(r.userHandle) : undefined,
      },
    },
  });
  await loadMe();
}
/** Registers a new passkey on this device under `name`. */
export async function passkeyRegister(name) {
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys.');
  const opts = await api.get(`/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name || '')}`);
  const publicKey = {
    ...opts,
    challenge: b64url.decode(opts.challenge),
    user: { ...opts.user, id: b64url.decode(opts.user.id) },
    excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64url.decode(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw new Error('No passkey was created.');
  const r = cred.response;
  await api.post('/api/auth/passkey/verify-registration', {
    name: name || undefined,
    response: {
      id: cred.id, rawId: b64url.encode(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64url.encode(r.clientDataJSON),
        attestationObject: b64url.encode(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : undefined,
      },
    },
  });
}
/** Modal asking for a passkey sign-in; resolves true once the session is an MFA session. */
export function stepUp(what = 'This') {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(html`
      <div class="center"><span class="g violet lg">${icon('fingerprint')}</span>
        <h2>Confirm with your passkey</h2>
        <p>${what} needs a passkey. Your current session signed in another way.</p>
</div>
      ${alertBox('su-err')}
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="su-go">${icon('fingerprint')}Use passkey</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
    $('#su-go', m).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await passkeySignIn();
        done = true;
        closeModal();
        resolve(true);
      } catch (err) {
        showAlert($('#su-err', m), errorText(err) || 'The passkey sign-in did not complete.');
        $('#su-go', m).disabled = false;
      }
    });
  });
}

/**
 * The protected-action flow shared by every destructive or lock-out-prone action:
 *   1. optional typed name (D30/D31), 2. passkey step-up on 403 mfa_required/passkey_required (D24),
 *   3. on 409 lock_out_confirmation_required: list the affected members, ask for the name,
 *   4. 202: "check your email" (D30) — nothing happens until the emailed link is confirmed.
 * call(typedName | undefined) performs the request via api.raw and returns { status, body }.
 * Resolves { status, body } of the final answer, or null when the user cancelled.
 */
export async function protectedAction({ title, consequence, name, nameLabel, typed = !!name, danger = true, actionLabel, call }) {
  let typedName;
  if (typed) {
    typedName = await askTypedName({ title, consequence, name, nameLabel, danger, actionLabel });
    if (typedName === null) return null;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await call(typedName);
      if (res.status === 202) showCheckEmail(title, res.body);
      return res;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === 'mfa_required' || e.code === 'passkey_required') {
        if (!(await stepUp(title))) return null;
        continue;
      }
      // A name that didn't match is asked again, with the problem under the field.
      if (e.code === 'lock_out_confirmation_required' || (e.code === 'confirm_name_mismatch' && (e.body.affected || typed))) {
        typedName = await askTypedName({ title, consequence, name, nameLabel, danger, actionLabel, affected: e.body.affected, dependence: e.body.policyDependence, mismatch: e.code === 'confirm_name_mismatch' });
        if (typedName === null) return null;
        continue;
      }
      throw e;
    }
  }
  return null;
}
const REASON_TEXT = { domain: 'email domain no longer allowed', method: 'no allowed way to sign in', signed_out: 'current session would end' };
const DEPENDENCE_TEXT = {
  org_policy_sso_only: 'The org sign-in policy allows only single sign-on.',
  instance_policy_requires_sso: 'An instance policy requires single sign-on.',
  required_domain_served_by_sso: 'The required email domain signs in through this connection.',
};
function askTypedName({ title, consequence, name, nameLabel, danger, actionLabel, affected, dependence, mismatch }) {
  return new Promise((resolve) => {
    let answered = false;
    const list = affected && affected.length
      ? html`<div class="label">${plural(affected.length, 'member')} would lose access</div>
        <div class="rows">${affected.map((a) => html`<div class="row"><span class="av">${initials(a.name || a.email)}</span><div class="t"><b>${a.name || a.email}</b><span>${a.email} · ${(a.reasons || []).map((r) => REASON_TEXT[r] || r).join(', ')}</span></div></div>`)}</div>`
      : '';
    const dep = dependence && dependence.length ? html`<div class="banner amber">${icon('alert')}<div class="grow">${dependence.map((d) => html`<div>${DEPENDENCE_TEXT[d] || d}</div>`)}</div></div>` : '';
    const m = openModal(html`
      <h2 class="${danger ? 'danger' : ''}">${title}</h2>
      <p>${consequence}</p>${dep}${list}
      ${name ? html`<div class="field"><label for="pa-name">Type <span class="code">${name}</span> to continue${nameLabel ? html` <span class="muted">(${nameLabel})</span>` : ''}</label>
        <input class="inp" id="pa-name" autocomplete="off" spellcheck="false"></div>` : ''}
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="pa-go" ${name ? 'disabled' : ''}>${actionLabel || title}</button></div>`,
      { wide: !!(affected && affected.length), onClose: () => { if (!answered) resolve(null); } });
    const inp = $('#pa-name', m), go = $('#pa-go', m);
    if (inp && mismatch) fieldError(inp, "That didn't match. Type it exactly.");
    if (inp) inp.addEventListener('input', () => { go.disabled = inp.value.trim() !== name; });
    go.addEventListener('click', () => { answered = true; const v = inp ? inp.value.trim() : undefined; closeModal(); resolve(v); });
  });
}
function showCheckEmail(title, body) {
  const who = state.me?.user?.email;
  openModal(html`
    <div class="center"><span class="g amber lg">${icon('mail')}</span>
      <h2>Check your email</h2>
      <p>We sent a confirmation link${who ? html` to <b>${who}</b>` : ''}. Nothing changes until you open it and confirm: ${title.toLowerCase()}. The link works once, for 30 minutes, and only for you.</p>
      ${body && body.expiresAt ? html`<p class="muted">Expires ${relTime(body.expiresAt)}.</p>` : ''}</div>
    <div class="acts"><button class="btn primary" data-close>Done</button></div>`);
}

// ---- app state and router -------------------------------------------------------------------------
/** state.me is GET /api/me; state.orgId is the org of the current /o/:orgId route. */
export const state = { me: null, orgId: null };

/**
 * This deployment's names, from the shell's <body data-…> (src/control/ui.ts brandShell): the
 * product, the hosted service, the operator, the website host, abuse contacts, the instance domain.
 * Missing ones are null, so text that needs them is left out rather than naming another deployment.
 */
const brandData = typeof document !== 'undefined' && document.body ? document.body.dataset : {};
export const brand = Object.freeze({
  product: brandData.product || 'Worca',
  service: brandData.service || `${brandData.product || 'Worca'} hosted`,
  operator: brandData.operator || null,
  website: brandData.website || null,
  abuseEmail: brandData.abuseEmail || null,
  abuseUrl: brandData.abuseUrl || null,
  instanceDomain: brandData.instanceDomain || null,
});
/**
 * The optional modules this deployment turned on, from the shell's
 * <body data-features>: newsletter, accessRequests, tiers. A module that is off has no nav entry,
 * view or card; its API answers 404.
 */
const featureList = (brandData.features || '').split(/\s+/).filter(Boolean);
export const features = Object.freeze({
  newsletter: featureList.includes('newsletter'),
  accessRequests: featureList.includes('accessRequests'),
  tiers: featureList.includes('tiers'),
});
export async function loadMe() {
  state.me = await api.get('/api/me');
  return state.me;
}
export const isStaff = () => (state.me?.platformRoles || []).length > 0;
export const hasRole = (...roles) => (state.me?.platformRoles || []).some((r) => roles.includes(r));
export const orgOf = (orgId) => (state.me?.orgs || []).find((o) => o.id === orgId) || null;
export const isOrgAdmin = (orgId) => orgOf(orgId)?.role === 'tenant_admin';

const routes = [];
let current = null; // { cleanups: [] }
let renderShell = null;
/** main.mjs registers views and the shell renderer. */
export function registerViews(list) { for (const v of list) routes.push({ ...v, re: v.path === '*' ? { re: /^$/, keys: [] } : compile(v.path) }); }
export function setShell(fn) { renderShell = fn; }
function compile(path) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}
function match(pathname) {
  for (const r of routes) {
    const m = r.re.re.exec(pathname);
    if (m) return { route: r, params: Object.fromEntries(r.re.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !match(url.pathname)) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});

/**
 * Renders the current URL. The view's render(ctx) gets:
 *   ctx.params, ctx.query (URLSearchParams), ctx.me, ctx.orgId, ctx.org (me.orgs entry or null),
 *   ctx.el (the page container), ctx.set(markup) (replaces the page content),
 *   ctx.poll(fn, ms) (repeats fn while this view is shown), ctx.onLeave(fn), ctx.refresh(),
 *   ctx.alive() (false once the user navigated away; check after awaits).
 */
export async function render() {
  if (current) for (const fn of current.cleanups) try { fn(); } catch { /* ignore */ }
  closeModal();
  const m = match(location.pathname);
  const view = m ? m.route : routes.find((r) => r.path === '*');
  const params = m ? m.params : {};
  state.orgId = params.orgId || null;
  const me = state.me;
  const token = { cleanups: [], alive: true };
  current = token;
  token.cleanups.push(() => { token.alive = false; });
  const main = renderShell(view, params);
  document.title = `${view.title || brand.product} · ${brand.product}`;
  const ctx = {
    params, query: new URLSearchParams(location.search), me, orgId: state.orgId, org: orgOf(state.orgId), el: main,
    set: (markup) => { if (token.alive) setHtml(main, markup); },
    poll: (fn, ms) => { const id = setInterval(() => { if (token.alive && !document.hidden) fn(); }, ms); token.cleanups.push(() => clearInterval(id)); },
    onLeave: (fn) => token.cleanups.push(fn),
    refresh: () => render(),
    alive: () => token.alive,
  };
  if (view.guard) {
    const redirect = view.guard(ctx);
    if (redirect) return navigate(redirect, { replace: true });
  }
  setHtml(main, html`<div class="page"><div class="empty"><span class="g slate spin">${icon('loader')}</span></div></div>`);
  try {
    await view.render(ctx);
  } catch (e) {
    if (!token.alive) return;
    setHtml(main, html`<div class="page"><div class="head"><div><h1>Couldn't load this page</h1><p>${errorText(e)}</p></div></div>
      <div><button class="btn" id="retry">${icon('refresh')}Try again</button></div></div>`);
    $('#retry', main)?.addEventListener('click', () => render());
  }
  window.scrollTo(0, 0);
}
