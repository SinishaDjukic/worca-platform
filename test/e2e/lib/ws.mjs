// WebSocket client over node:http (connects to 127.0.0.1 with the Host header), using the stub's
// framing. `browser` supplies cookies and Origin like a page on the same host would.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { OP, acceptKey, closePayload, createFrameReader, encodeFrame, parseClose } from '../../../packages/platform/stub/ws-frames.mjs';
import { connectTarget } from './http.mjs';

/**
 * Opens a WebSocket. Resolves to { ok: true, ws } after 101, or { ok: false, status, body } when
 * the server answers with anything else.
 */
export function openWebSocket(url, { browser, origin, headers = {}, timeoutMs = 10_000 } = {}) {
  const u = new URL(url.replace(/^ws/, 'http'));
  const key = randomBytes(16).toString('base64');
  const h = {
    host: u.host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': key,
    origin: origin ?? u.origin,
    'sec-fetch-site': origin && origin !== u.origin ? 'same-site' : 'same-origin',
    'sec-fetch-mode': 'websocket',
    'sec-fetch-dest': 'empty',
  };
  const cookie = browser?.jar.header(u);
  if (cookie) h.cookie = cookie;
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k.toLowerCase()];
    else h[k.toLowerCase()] = v;
  }
  const { hostname, port } = connectTarget(u);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: u.pathname + u.search, headers: h, agent: false });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('websocket handshake timeout')));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: false, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        return reject(new Error('bad sec-websocket-accept'));
      }
      resolve({ ok: true, status: 101, ws: new ClientSocket(socket, head) });
    });
    req.on('error', reject);
    req.end();
  });
}

class ClientSocket {
  constructor(socket, head) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = null; // { code, reason, at }
    this.closeWaiters = [];
    const read = createFrameReader(({ opcode, payload }) => {
      if (opcode === OP.text) this.#push(payload.toString('utf8'));
      else if (opcode === OP.binary) this.#push(payload);
      else if (opcode === OP.ping) socket.write(encodeFrame(OP.pong, payload, { mask: true }));
      else if (opcode === OP.close) {
        const info = parseClose(payload);
        if (!this.closed) socket.write(encodeFrame(OP.close, payload.length >= 2 ? closePayload(info.code) : Buffer.alloc(0), { mask: true }));
        this.#closed(info.code, info.reason);
        socket.end();
      }
    });
    if (head?.length) read(head);
    socket.on('data', read);
    socket.on('close', () => this.#closed(1006, 'connection closed'));
    socket.on('error', () => this.#closed(1006, 'socket error'));
  }

  #push(msg) {
    const w = this.waiters.shift();
    if (w) w.resolve(msg);
    else this.messages.push(msg);
  }

  #closed(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason, at: Date.now() };
    for (const w of this.closeWaiters) w(this.closed);
    for (const w of this.waiters) w.reject(new Error(`websocket closed ${code} ${reason}`));
    this.waiters = [];
  }

  send(text) {
    this.socket.write(encodeFrame(OP.text, Buffer.from(text), { mask: true }));
  }

  /** Next message (text as string). */
  next(timeoutMs = 5000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.closed) return Promise.reject(new Error(`websocket closed ${this.closed.code}`));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`no websocket message within ${timeoutMs} ms`));
      }, timeoutMs);
      w.resolve = (m) => (clearTimeout(t), resolve(m));
      w.reject = (e) => (clearTimeout(t), reject(e));
      this.waiters.push(w);
    });
  }

  /** Resolves with { code, reason, at } when the socket closes, or null after timeoutMs. */
  waitClose(timeoutMs = 10_000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      this.closeWaiters.push((c) => (clearTimeout(t), resolve(c)));
    });
  }

  close(code = 1000) {
    if (this.closed) return;
    this.socket.write(encodeFrame(OP.close, closePayload(code), { mask: true }));
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}
