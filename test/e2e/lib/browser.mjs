// A minimal "browser": a cookie jar plus the request headers a browser sends (Origin,
// Sec-Fetch-*), with redirects followed hop by hop so tests can look at each one.
import { APP_ORIGIN, readDevVars } from './config.mjs';
import { request } from './http.mjs';

// Lets the smoke tests past Turnstile on production (the deployed secret, from E2E_VARS_FILE).
const TURNSTILE_BYPASS = process.env.TURNSTILE_BYPASS_TOKEN || readDevVars().TURNSTILE_BYPASS_TOKEN;

/** One stored cookie. Host-only unless Domain was given. */
class Cookie {
  constructor(fields) {
    Object.assign(this, fields);
  }
  matches(url) {
    const host = url.hostname.toLowerCase();
    const okHost = this.hostOnly ? host === this.domain : host === this.domain || host.endsWith(`.${this.domain}`);
    if (!okHost) return false;
    const p = url.pathname || '/';
    if (!(p === this.path || p.startsWith(this.path.endsWith('/') ? this.path : `${this.path}/`))) return false;
    if (this.expires !== null && this.expires <= Date.now()) return false;
    return true;
  }
}

export class CookieJar {
  constructor() {
    /** @type {Cookie[]} */
    this.cookies = [];
  }

  /** Applies one Set-Cookie line received from `url`. Returns false when rejected. */
  set(line, url) {
    const u = new URL(url);
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return false;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const c = { name, value, domain: u.hostname.toLowerCase(), hostOnly: true, path: '/', secure: false, httpOnly: false, sameSite: null, expires: null };
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : attr.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        const host = u.hostname.toLowerCase();
        if (host !== d && !host.endsWith(`.${d}`)) return false; // a host may only set its own or a parent domain
        c.domain = d;
        c.hostOnly = false;
      } else if (k === 'path' && v.startsWith('/')) c.path = v;
      else if (k === 'secure') c.secure = true;
      else if (k === 'httponly') c.httpOnly = true;
      else if (k === 'samesite') c.sameSite = v.toLowerCase();
      else if (k === 'max-age') c.expires = Date.now() + Number(v) * 1000;
      else if (k === 'expires' && c.expires === null) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) c.expires = t;
      }
    }
    // __Host- (loosely): no Domain, Path=/. Secure is not enforced: *.localhost over http is a
    // secure context in browsers.
    if (name.startsWith('__Host-') && (!c.hostOnly || c.path !== '/')) return false;
    this.cookies = this.cookies.filter((x) => !(x.name === name && x.domain === c.domain && x.path === c.path && x.hostOnly === c.hostOnly));
    if (c.expires === null || c.expires > Date.now()) this.cookies.push(new Cookie(c));
    return true;
  }

  /** Cookie header value for `url`, or null. Longer paths first, like browsers. */
  header(url) {
    const u = new URL(url);
    const list = this.cookies.filter((c) => c.matches(u)).sort((a, b) => b.path.length - a.path.length);
    return list.length ? list.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  }

  get(name, url) {
    const u = url ? new URL(url) : null;
    return this.cookies.find((c) => c.name === name && (!u || c.matches(u)))?.value ?? null;
  }

  /** Adds a cookie directly, like JavaScript on a page would (`document.cookie`). */
  plant(name, value, { domain, path = '/' } = {}) {
    this.cookies = this.cookies.filter((x) => !(x.name === name && x.domain === domain && x.path === path));
    this.cookies.push(new Cookie({ name, value, domain, hostOnly: false, path, secure: false, httpOnly: false, sameSite: null, expires: null }));
  }

  delete(name) {
    this.cookies = this.cookies.filter((c) => c.name !== name);
  }
}

const originOf = (url) => new URL(url).origin;

export class Browser {
  constructor(label = 'browser') {
    this.label = label;
    this.jar = new CookieJar();
  }

  /**
   * One request, no redirects followed. Options:
   *  - method, headers, body (objects become JSON)
   *  - navigate: true for a top-level page load (Sec-Fetch-Mode: navigate, Accept: text/html)
   *  - from: the page origin the request is made from (default: same origin as the target).
   *    Sets Origin on non-GET requests and computes Sec-Fetch-Site.
   *  - fetchMetadata: false to omit Sec-Fetch-* (old browsers, other clients)
   *  - origin: false to omit Origin; or a string to force it
   */
  async fetch(url, opts = {}) {
    const { method = 'GET', headers = {}, body, navigate = false, from, fetchMetadata = true, origin, timeoutMs } = opts;
    const target = new URL(url);
    const h = { 'user-agent': `worca-e2e/${this.label}` };
    const cookie = this.jar.header(target);
    if (cookie) h.cookie = cookie;
    const fromOrigin = from === undefined ? target.origin : from; // null = typed in the address bar
    if (fetchMetadata) {
      let site = 'none';
      if (fromOrigin) {
        if (fromOrigin === target.origin) site = 'same-origin';
        else site = sameSite(fromOrigin, target.origin) ? 'same-site' : 'cross-site';
      }
      h['sec-fetch-site'] = site;
      h['sec-fetch-mode'] = navigate ? 'navigate' : 'cors';
      h['sec-fetch-dest'] = navigate ? 'document' : 'empty';
    }
    if (TURNSTILE_BYPASS && method === 'POST' && target.origin === APP_ORIGIN) h['x-turnstile-bypass'] = TURNSTILE_BYPASS;
    if (navigate) h.accept = 'text/html,application/xhtml+xml';
    else h.accept = 'application/json, */*';
    if (origin !== false) {
      if (typeof origin === 'string') h.origin = origin;
      else if (method !== 'GET' && method !== 'HEAD' && fromOrigin) h.origin = fromOrigin;
    }
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k.toLowerCase()];
      else h[k.toLowerCase()] = v;
    }
    const res = await request(url, { method, headers: h, body, timeoutMs });
    for (const line of res.setCookies) this.jar.set(line, url);
    return res;
  }

  /**
   * Follows redirects one hop at a time, like a top-level navigation. Returns
   * { hops: HttpResponse[], final: HttpResponse }. 303 (and 301/302 after POST) become GET.
   */
  async navigate(url, opts = {}) {
    const hops = [];
    let current = url;
    let method = opts.method ?? 'GET';
    let body = opts.body;
    let from = opts.from === undefined ? null : opts.from;
    const max = opts.maxHops ?? 15;
    for (let i = 0; i <= max; i++) {
      const res = await this.fetch(current, { ...opts, method, body, navigate: true, from });
      hops.push(res);
      if (!res.isRedirect) return { hops, final: res };
      if (opts.stopAt && opts.stopAt(res)) return { hops, final: res };
      const next = res.location;
      // A redirect chain keeps the original initiator for Sec-Fetch-Site purposes; we simplify to
      // "cross-site unless same origin as the previous hop".
      from = from === null ? null : originOf(current);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
    }
    throw new Error(`too many redirects starting at ${url}: ${hops.map((h) => h.location).join(' -> ')}`);
  }

  /** JSON helper: same-origin API call. */
  async api(url, { method = 'GET', body, headers, from } = {}) {
    return this.fetch(url, { method, body, headers, from });
  }
}

/** Same registrable domain, loosely: last two labels (good enough for *.localhost). */
function sameSite(a, b) {
  const site = (o) => new URL(o).hostname.split('.').slice(-2).join('.');
  return site(a) === site(b);
}
