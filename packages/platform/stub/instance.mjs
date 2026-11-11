// Local stand-in for worca instances (docs/internal-apis.md "Stub instance server").
// One process serves any number of instances. The fake compute/edge providers drive it through
// /__admin/*; the gate forwards instance traffic here with x-forwarded-host set to the instance host.
//
// Env: STUB_PORT (9100), APP_ORIGIN (http://app.localhost:8787), STUB_HEARTBEAT_SECONDS (5).
// Persists nothing: instances are recreated by the provisioner.
import http from 'node:http';
import { createLocalJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { OP, acceptKey, closePayload, createFrameReader, encodeFrame, parseClose } from './ws-frames.mjs';

const PORT = Number(process.env.STUB_PORT || 9100);
const APP_ORIGIN = (process.env.APP_ORIGIN || 'http://app.localhost:8787').replace(/\/$/, '');
const HEARTBEAT_MS = Math.max(0.2, Number(process.env.STUB_HEARTBEAT_SECONDS || 5)) * 1000;
const IDENTITY_HEADER = 'x-worca-identity';
const JWKS_PATH = '/.well-known/jwks.json';

function log(event, fields = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

// ---------------------------------------------------------------------------------------------
// Outbound HTTP to *.localhost: connect to 127.0.0.1 and send the Host header from the URL.

function loopbackRequest(urlString, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(urlString);
  const isLocal = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  const hostname = isLocal ? '127.0.0.1' : url.hostname;
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  if (url.protocol !== 'http:') return Promise.reject(new Error(`stub only speaks http: ${urlString}`));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: url.pathname + url.search, method, headers: { host: url.host, ...headers }, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// JWKS: fetched from APP_ORIGIN, cached; refetched (at most every 10 s) when a kid is unknown.

let jwks = null; // { keySet, kids:Set, fetchedAt }
let jwksInflight = null;

async function loadJwks(force = false) {
  if (jwks && !force) return jwks;
  if (jwks && force && Date.now() - jwks.fetchedAt < 10_000) return jwks;
  if (!jwksInflight) {
    jwksInflight = (async () => {
      try {
        const res = await loopbackRequest(APP_ORIGIN + JWKS_PATH, { headers: { accept: 'application/json' } });
        if (res.status !== 200) throw new Error(`jwks: HTTP ${res.status}`);
        const doc = JSON.parse(res.body);
        jwks = { keySet: createLocalJWKSet(doc), kids: new Set((doc.keys || []).map((k) => k.kid)), fetchedAt: Date.now() };
        log('jwks.fetched', { kids: [...jwks.kids] });
        return jwks;
      } finally {
        jwksInflight = null;
      }
    })();
  }
  return jwksInflight;
}

/** Verifies an identity token for `host` at the instance's (possibly shifted) clock. */
async function verifyIdentity(token, host, nowMs) {
  if (!token) return { ok: false, reason: 'missing' };
  const opts = { issuer: APP_ORIGIN, audience: host, algorithms: ['ES256'], currentDate: new Date(nowMs) };
  try {
    let set = await loadJwks();
    try {
      const { payload } = await jwtVerify(token, set.keySet, opts);
      return { ok: true, claims: payload };
    } catch (e) {
      if (!(e instanceof joseErrors.JWKSNoMatchingKey)) throw e;
      set = await loadJwks(true);
      const { payload } = await jwtVerify(token, set.keySet, opts);
      return { ok: true, claims: payload };
    }
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Instances

/** id -> instance */
const instances = new Map();
/** host (no port) -> { id, kind } */
const hosts = new Map();

function newInstance({ instanceId, host, keyHost }) {
  return {
    id: instanceId,
    host,
    keyHost: keyHost || null,
    state: 'created',
    variables: null,
    image: null,
    beats: 0,
    lastBeat: null, // { at, status, body }
    report: { health: 'ok', version: null, pipelines: {}, nextScheduledAt: null, suspendable: true },
    clockOffsetMs: 0,
    requests: [], // last 50 instance requests: { at, method, path, host, status }
    timer: null,
    sockets: new Set(),
  };
}

const nowFor = (inst) => Date.now() + (inst?.clockOffsetMs || 0);

function versionFromImage(image) {
  const ref = typeof image === 'string' ? image : image?.worca;
  if (!ref) return '0.0.0-stub';
  const at = ref.lastIndexOf(':');
  return at > ref.lastIndexOf('/') ? ref.slice(at + 1) : ref;
}

function heartbeatBody(inst) {
  const r = inst.report;
  return {
    health: r.health ?? 'ok',
    version: r.version ?? versionFromImage(inst.image),
    pipelines: r.pipelines ?? {},
    nextScheduledAt: r.nextScheduledAt ?? null,
    suspendable: r.suspendable ?? true,
  };
}

async function sendHeartbeat(inst) {
  if (inst.state !== 'running') return;
  const url = inst.variables?.heartbeatUrl;
  const cred = inst.variables?.heartbeatCredential;
  if (!url || !cred) {
    log('heartbeat.skipped', { id: inst.id, reason: 'no heartbeatUrl/heartbeatCredential' });
    return;
  }
  const body = heartbeatBody(inst);
  try {
    const res = await loopbackRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` },
      body: JSON.stringify(body),
    });
    inst.lastBeat = { at: Date.now(), status: res.status, body };
    if (res.status >= 200 && res.status < 300) inst.beats++;
    log('heartbeat', { id: inst.id, status: res.status, beats: inst.beats, version: body.version, suspendable: body.suspendable });
  } catch (e) {
    inst.lastBeat = { at: Date.now(), status: 0, body, error: e.message };
    log('heartbeat.error', { id: inst.id, error: e.message });
  }
}

function startServing(inst) {
  inst.state = 'running';
  stopTimer(inst);
  // First beat soon after the deploy, then every STUB_HEARTBEAT_SECONDS.
  const first = setTimeout(() => sendHeartbeat(inst), Math.min(500, HEARTBEAT_MS));
  const every = setInterval(() => sendHeartbeat(inst), HEARTBEAT_MS);
  inst.timer = { first, every };
}

function stopTimer(inst) {
  if (!inst.timer) return;
  clearTimeout(inst.timer.first);
  clearInterval(inst.timer.every);
  inst.timer = null;
}

function stopServing(inst, state) {
  inst.state = state;
  stopTimer(inst);
  for (const ws of inst.sockets) ws.close(1001, `instance ${state}`);
}

function publicView(inst) {
  return {
    id: inst.id,
    host: inst.host,
    keyHost: inst.keyHost,
    state: inst.state,
    image: inst.image,
    variables: inst.variables,
    beats: inst.beats,
    lastBeat: inst.lastBeat,
    report: heartbeatBody(inst),
    clockOffsetSeconds: inst.clockOffsetMs / 1000,
    sockets: inst.sockets.size,
    requests: inst.requests.length,
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const stripPort = (h) => (h || '').replace(/:\d+$/, '').toLowerCase();

// ---------------------------------------------------------------------------------------------
// Admin API (only for requests without x-forwarded-host, i.e. not coming through the gate)

async function handleAdmin(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['__admin', 'instances', id, action]
  const method = req.method;

  if (parts.length === 2 && parts[1] === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, instances: instances.size, appOrigin: APP_ORIGIN, heartbeatSeconds: HEARTBEAT_MS / 1000 });
  }
  if (parts[1] !== 'instances') return sendJson(res, 404, { error: 'not_found' });

  if (parts.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { instances: [...instances.values()].map(publicView) });
    if (method === 'POST') {
      const body = await jsonBody(req);
      if (!body.instanceId || !body.host) return sendJson(res, 400, { error: 'instanceId and host required' });
      const existing = instances.get(body.instanceId);
      if (existing) {
        // Idempotent for Workflow retries.
        log('admin.create', { id: body.instanceId, host: body.host, existing: true });
        return sendJson(res, 200, publicView(existing));
      }
      const inst = newInstance(body);
      instances.set(inst.id, inst);
      hosts.set(stripPort(inst.host), { id: inst.id, kind: 'worca' });
      if (inst.keyHost) hosts.set(stripPort(inst.keyHost), { id: inst.id, kind: 'keypage' });
      log('admin.create', { id: inst.id, host: inst.host, keyHost: inst.keyHost });
      return sendJson(res, 201, publicView(inst));
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  const inst = instances.get(decodeURIComponent(parts[2]));
  if (!inst) return sendJson(res, 404, { error: 'unknown_instance' });
  const action = parts[3];

  if (!action) {
    if (method === 'GET') return sendJson(res, 200, publicView(inst));
    if (method === 'DELETE') {
      stopServing(inst, 'deleted');
      instances.delete(inst.id);
      for (const [h, v] of hosts) if (v.id === inst.id) hosts.delete(h);
      log('admin.delete', { id: inst.id });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  if (method === 'GET' && action === 'requests') return sendJson(res, 200, { requests: inst.requests });
  if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  const body = await jsonBody(req);

  switch (action) {
    case 'variables':
      inst.variables = { ...(inst.variables || {}), ...(body.variables || {}) };
      log('admin.variables', { id: inst.id, keys: Object.keys(body.variables || {}) });
      return sendJson(res, 200, publicView(inst));
    case 'deploy':
      inst.image = body.image ?? inst.image;
      startServing(inst);
      log('admin.deploy', { id: inst.id, image: inst.image, version: versionFromImage(inst.image) });
      return sendJson(res, 200, publicView(inst));
    case 'stop':
      stopServing(inst, 'stopped');
      log('admin.stop', { id: inst.id });
      return sendJson(res, 200, publicView(inst));
    case 'start':
      startServing(inst);
      log('admin.start', { id: inst.id });
      return sendJson(res, 200, publicView(inst));
    case 'state': {
      for (const k of ['pipelines', 'nextScheduledAt', 'suspendable', 'health', 'version']) {
        if (k in body) inst.report[k] = body[k];
      }
      log('admin.state', { id: inst.id, report: heartbeatBody(inst) });
      return sendJson(res, 200, publicView(inst));
    }
    case 'heartbeat': // test helper: send one heartbeat now
      await sendHeartbeat(inst);
      return sendJson(res, 200, publicView(inst));
    case 'clock': {
      // Test helper: shift this instance's clock (token checks, WebSocket expiry, W7).
      inst.clockOffsetMs = Number(body.offsetSeconds || 0) * 1000;
      for (const ws of inst.sockets) ws.reschedule();
      log('admin.clock', { id: inst.id, offsetSeconds: inst.clockOffsetMs / 1000 });
      return sendJson(res, 200, publicView(inst));
    }
    default:
      return sendJson(res, 404, { error: 'not_found' });
  }
}

// ---------------------------------------------------------------------------------------------
// Instance traffic

function resolveInstance(req) {
  const host = stripPort(req.headers['x-forwarded-host'] || req.headers.host);
  const entry = hosts.get(host);
  return { host, entry, inst: entry ? instances.get(entry.id) : null };
}

function remember(inst, rec) {
  inst.requests.push(rec);
  if (inst.requests.length > 50) inst.requests.shift();
}

async function handleInstance(req, res, url) {
  const { host, inst } = resolveInstance(req);
  if (!inst) {
    log('instance.unknown_host', { host, path: url.pathname });
    return sendJson(res, 404, { error: 'unknown_host', host });
  }
  if (inst.state !== 'running') {
    log('instance.not_running', { id: inst.id, host, state: inst.state, path: url.pathname });
    remember(inst, { at: Date.now(), method: req.method, path: url.pathname, host, status: 502 });
    return sendJson(res, 502, { error: 'instance_not_running', state: inst.state });
  }
  const v = await verifyIdentity(req.headers[IDENTITY_HEADER], host, nowFor(inst));
  if (!v.ok) {
    log('instance.unauthorized', { id: inst.id, host, path: url.pathname, reason: v.reason });
    remember(inst, { at: Date.now(), method: req.method, path: url.pathname, host, status: 401, reason: v.reason });
    return sendJson(res, 401, { error: 'invalid_identity', reason: v.reason });
  }
  const body = await readBody(req).catch(() => Buffer.alloc(0));
  // `?setCookie=<cookie string>` (repeatable) answers with those Set-Cookie headers, so tests can
  // check the gate's Set-Cookie filtering.
  const setCookies = url.searchParams.getAll('setCookie');
  const headers = {};
  for (const [k, val] of Object.entries(req.headers)) headers[k] = val;
  const echo = {
    host,
    instanceId: inst.id,
    method: req.method,
    path: url.pathname,
    query: url.search,
    identity: v.claims,
    cookies: parseCookies(req.headers.cookie),
    headers,
    body: body.length ? body.toString('utf8') : null,
  };
  remember(inst, { at: Date.now(), method: req.method, path: url.pathname, host, status: 200, sub: v.claims.sub });
  log('instance.request', { id: inst.id, host, method: req.method, path: url.pathname, sub: v.claims.sub });
  const extra = setCookies.length ? { 'set-cookie': setCookies } : {};
  return sendJson(res, 200, echo, extra);
}

// WebSocket echo at /ws. Closes with 4001 when the token used at the upgrade expires (W7).
async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://stub');
  const refuse = (status, msg) => {
    socket.end(`HTTP/1.1 ${status} ${msg}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  };
  const { host, inst } = resolveInstance(req);
  if (!inst) return refuse(404, 'Not Found');
  if (inst.state !== 'running') return refuse(502, 'Bad Gateway');
  if (url.pathname !== '/ws') return refuse(404, 'Not Found');
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request');
  const v = await verifyIdentity(req.headers[IDENTITY_HEADER], host, nowFor(inst));
  if (!v.ok) {
    log('ws.unauthorized', { id: inst.id, host, reason: v.reason });
    return refuse(401, 'Unauthorized');
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
      `sec-websocket-accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const exp = Number(v.claims.exp);
  let closed = false;
  let expiryTimer = null;
  const ws = {
    send(text) {
      if (!closed) socket.write(encodeFrame(OP.text, Buffer.from(text)));
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      clearTimeout(expiryTimer);
      inst.sockets.delete(ws);
      log('ws.close', { id: inst.id, code, reason, by: 'server' });
      socket.write(encodeFrame(OP.close, closePayload(code, reason)));
      setTimeout(() => socket.destroy(), 1000).unref();
    },
    reschedule() {
      clearTimeout(expiryTimer);
      const delay = exp * 1000 - nowFor(inst);
      if (delay <= 0) return ws.close(4001, 'identity token expired');
      expiryTimer = setTimeout(() => ws.close(4001, 'identity token expired'), Math.min(delay, 2 ** 31 - 1));
    },
  };
  inst.sockets.add(ws);
  log('ws.open', { id: inst.id, host, sub: v.claims.sub, exp });
  ws.reschedule();
  ws.send(JSON.stringify({ type: 'hello', host, sub: v.claims.sub, exp, closeAt: exp * 1000 - inst.clockOffsetMs }));

  const read = createFrameReader(({ opcode, payload, masked }) => {
    if (!masked) return ws.close(1002, 'client frames must be masked');
    if (opcode === OP.text) ws.send(payload.toString('utf8'));
    else if (opcode === OP.binary) socket.write(encodeFrame(OP.binary, payload));
    else if (opcode === OP.ping) socket.write(encodeFrame(OP.pong, payload));
    else if (opcode === OP.close) {
      const { code, reason } = parseClose(payload);
      if (!closed) {
        closed = true;
        clearTimeout(expiryTimer);
        inst.sockets.delete(ws);
        log('ws.close', { id: inst.id, code, reason, by: 'client' });
        socket.end(encodeFrame(OP.close, payload.length >= 2 ? closePayload(code) : Buffer.alloc(0)));
      } else socket.destroy();
    }
  });
  if (head?.length) read(head);
  socket.on('data', read);
  const gone = () => {
    if (!closed) log('ws.close', { id: inst.id, by: 'disconnect' });
    closed = true;
    clearTimeout(expiryTimer);
    inst.sockets.delete(ws);
  };
  socket.on('close', gone);
  socket.on('error', gone);
}

// ---------------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  try {
    if (!req.headers['x-forwarded-host'] && url.pathname.startsWith('/__admin/')) return await handleAdmin(req, res, url);
    return await handleInstance(req, res, url);
  } catch (e) {
    log('error', { path: url.pathname, message: e.message });
    if (!res.headersSent) sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: e.message });
    else res.destroy();
  }
});
server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((e) => {
    log('ws.error', { message: e.message });
    socket.destroy();
  });
});
server.listen(PORT, '127.0.0.1', () => {
  log('listening', { port: PORT, appOrigin: APP_ORIGIN, heartbeatSeconds: HEARTBEAT_MS / 1000 });
});

function shutdown(sig) {
  log('shutdown', { signal: sig });
  for (const inst of instances.values()) stopServing(inst, 'deleted');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
