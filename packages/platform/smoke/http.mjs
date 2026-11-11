// Copied from the platform repo's e2e helpers (test/e2e/lib/http.mjs).
// HTTP over node:http(s) that always connects to 127.0.0.1 for *.localhost names and sends the URL's
// host (with port) as the Host header, so `x.run.localhost:8798` and `app.localhost:8787` work
// without DNS. https: is for the deployed stack (test/smoke). Never follows redirects.
import http from 'node:http';
import https from 'node:https';

export function connectTarget(url) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
  return { hostname: local ? '127.0.0.1' : u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string|string[]>, body?: string|Buffer|object, timeoutMs?: number }} [opts]
 * Objects as `body` are sent as JSON.
 */
export function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.reject(new Error(`only http(s): is supported (${url})`));
  const h = { host: u.host };
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) h[k.toLowerCase()] = v;
  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
    else {
      payload = JSON.stringify(body);
      h['content-type'] ??= 'application/json';
    }
    h['content-length'] = Buffer.byteLength(payload);
  }
  const { hostname, port } = connectTarget(u);
  return new Promise((resolve, reject) => {
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({ hostname, port, servername: u.hostname, method, path: u.pathname + u.search, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(new HttpResponse(url, method, res, Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs} ms: ${method} ${url}`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export class HttpResponse {
  constructor(url, method, res, buffer) {
    this.url = url;
    this.method = method;
    this.status = res.statusCode;
    this.headers = res.headers; // lowercase; set-cookie is an array
    this.buffer = buffer;
    this.text = buffer.toString('utf8');
  }
  header(name) {
    const v = this.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v ?? null;
  }
  get setCookies() {
    return this.headers['set-cookie'] ?? [];
  }
  get location() {
    const loc = this.headers.location;
    return loc ? new URL(loc, this.url).toString() : null;
  }
  get isRedirect() {
    return this.status >= 300 && this.status < 400 && !!this.headers.location;
  }
  json() {
    try {
      return JSON.parse(this.text);
    } catch {
      throw new Error(`expected JSON from ${this.method} ${this.url} (HTTP ${this.status}): ${this.text.slice(0, 300)}`);
    }
  }
  /** Short description for assertion messages. */
  describe() {
    return `${this.method} ${this.url} -> ${this.status}${this.location ? ` (Location: ${this.location})` : ''} ${this.text.slice(0, 300)}`;
  }
}
