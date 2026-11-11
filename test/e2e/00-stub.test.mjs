// Self-test of stub/instance.mjs. Needs no running stack: starts its own stub and a fake control
// plane (JWKS + heartbeat endpoint) on free ports.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { request } from './lib/http.mjs';
import { openWebSocket } from './lib/ws.mjs';

const freePort = async () => {
  const s = http.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};

describe('stub instance server', () => {
  let cpPort, stubPort, cp, stub, key, appOrigin, stubOrigin;
  const beats = [];
  const stubLog = [];
  const HOST = 'k7m2qz9xwp.run.localhost';
  const KEY_HOST = 'a2b3c4d5e6.run.localhost';
  const ID = 'inst-1';

  const token = (claims = {}, { exp = Math.floor(Date.now() / 1000) + 300, aud = HOST, iss = appOrigin } = {}) =>
    new SignJWT({ sub: 'user-1', email: 'u@example.com', name: 'U', org: 'org-1', inst: ID, teams: ['t1'], ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key.privateKey);

  const admin = (method, path, body) => request(`${stubOrigin}/__admin/instances${path}`, { method, body });
  const viaGate = async (path, { host = HOST, tok, method = 'GET', headers = {} } = {}) =>
    request(`${stubOrigin}${path}`, {
      method,
      headers: { 'x-forwarded-host': host, ...(tok ? { 'x-worca-identity': tok } : {}), ...headers },
    });

  before(async () => {
    key = await generateKeyPair('ES256');
    const pub = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    cpPort = await freePort();
    stubPort = await freePort();
    appOrigin = `http://app.localhost:${cpPort}`;
    stubOrigin = `http://127.0.0.1:${stubPort}`;
    cp = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/.well-known/jwks.json') {
          assert.equal(req.headers.host, `app.localhost:${cpPort}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ keys: [pub] }));
        }
        if (req.url === '/api/heartbeat' && req.method === 'POST') {
          beats.push({ auth: req.headers.authorization, host: req.headers.host, body: JSON.parse(Buffer.concat(chunks).toString()) });
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });
    });
    cp.listen(cpPort, '127.0.0.1');
    await once(cp, 'listening');
    stub = spawn(process.execPath, [new URL('../../packages/platform/stub/instance.mjs', import.meta.url).pathname], {
      env: { ...process.env, STUB_PORT: String(stubPort), APP_ORIGIN: appOrigin, STUB_HEARTBEAT_SECONDS: '0.5' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stub.stdout.on('data', (d) => stubLog.push(d.toString()));
    stub.stderr.on('data', (d) => stubLog.push(d.toString()));
    for (let i = 0; i < 50; i++) {
      try {
        if ((await request(`${stubOrigin}/__admin/health`)).status === 200) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`stub did not start: ${stubLog.join('')}`);
  });

  after(async () => {
    stub?.kill('SIGTERM');
    if (stub) await once(stub, 'exit');
    cp?.close();
  });

  it('creates an instance and reports it', async () => {
    const res = await admin('POST', '', { instanceId: ID, host: HOST, keyHost: KEY_HOST });
    assert.equal(res.status, 201, res.describe());
    const again = await admin('POST', '', { instanceId: ID, host: HOST, keyHost: KEY_HOST });
    assert.equal(again.status, 200, 'create is idempotent for Workflow retries');
    const get = (await admin('GET', `/${ID}`)).json();
    assert.equal(get.state, 'created');
    assert.equal(get.beats, 0);
  });

  it('answers 502 before the deploy', async () => {
    const res = await viaGate('/', { tok: await token() });
    assert.equal(res.status, 502);
  });

  it('stores variables, deploys, and heartbeats with the credential', async () => {
    await admin('POST', `/${ID}/variables`, {
      variables: { heartbeatUrl: `${appOrigin}/api/heartbeat`, heartbeatCredential: 'hb-secret', identityAudience: HOST },
    });
    const dep = await admin('POST', `/${ID}/deploy`, { image: 'ghcr.io/worca/worca:1.8.0' });
    assert.equal(dep.json().state, 'running');
    await admin('POST', `/${ID}/state`, { pipelines: { running: 1 }, suspendable: false, nextScheduledAt: 1234 });
    for (let i = 0; i < 40 && beats.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(beats.length >= 2, 'heartbeats arrive');
    const last = beats.at(-1);
    assert.equal(last.auth, 'Bearer hb-secret');
    assert.equal(last.host, `app.localhost:${cpPort}`);
    assert.deepEqual(last.body, { health: 'ok', version: '1.8.0', pipelines: { running: 1 }, nextScheduledAt: 1234, suspendable: false });
    const get = (await admin('GET', `/${ID}`)).json();
    assert.ok(get.beats >= 2);
  });

  it('refuses instance traffic without a valid identity token', async () => {
    assert.equal((await viaGate('/')).status, 401);
    assert.equal((await viaGate('/', { tok: 'not-a-jwt' })).status, 401);
    assert.equal((await viaGate('/', { tok: await token({}, { aud: KEY_HOST }) })).status, 401, 'audience must be the host');
    assert.equal((await viaGate('/', { tok: await token({}, { iss: 'http://evil.localhost' }) })).status, 401, 'issuer');
    assert.equal((await viaGate('/', { tok: await token({}, { exp: Math.floor(Date.now() / 1000) - 120 }) })).status, 401, 'expired');
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sub: 'x' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(appOrigin).setAudience(HOST).setExpirationTime('5m').sign(other.privateKey);
    assert.equal((await viaGate('/', { tok: forged })).status, 401, 'signature');
  });

  it('echoes identity, cookies and headers; routes by x-forwarded-host', async () => {
    const res = await viaGate('/some/path?x=1', { tok: await token(), headers: { cookie: '__Host-app=1; other=2' } });
    assert.equal(res.status, 200, res.describe());
    const echo = res.json();
    assert.equal(echo.host, HOST);
    assert.equal(echo.path, '/some/path');
    assert.equal(echo.identity.sub, 'user-1');
    assert.deepEqual(echo.identity.teams, ['t1']);
    assert.deepEqual(echo.cookies, { '__Host-app': '1', other: '2' });
    const kp = await viaGate('/', { host: KEY_HOST, tok: await token({}, { aud: KEY_HOST }) });
    assert.equal(kp.status, 200);
    assert.equal(kp.json().host, KEY_HOST);
    const unknown = await viaGate('/', { host: 'nope.run.localhost', tok: await token() });
    assert.equal(unknown.status, 404);
  });

  it('sets the cookies asked for with ?setCookie', async () => {
    const res = await viaGate(`/?setCookie=${encodeURIComponent('a=1; Path=/')}&setCookie=${encodeURIComponent('__Host-b=2; Path=/; Secure')}`, { tok: await token() });
    assert.deepEqual(res.setCookies, ['a=1; Path=/', '__Host-b=2; Path=/; Secure']);
  });

  it('never serves the admin API to gate traffic', async () => {
    const res = await viaGate(`/__admin/instances/${ID}`, { tok: await token() });
    assert.equal(res.status, 200);
    assert.equal(res.json().path, `/__admin/instances/${ID}`, 'treated as instance traffic (echo)');
  });

  it('echoes WebSocket messages and closes at the token expiry (W7)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const tok = await token({}, { exp });
    const refused = await openWebSocket(`ws://127.0.0.1:${stubPort}/ws`, { headers: { 'x-forwarded-host': HOST } });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401);
    const opened = await openWebSocket(`ws://127.0.0.1:${stubPort}/ws`, { headers: { 'x-forwarded-host': HOST, 'x-worca-identity': tok } });
    assert.ok(opened.ok, `upgrade: ${opened.status} ${opened.body}`);
    const { ws } = opened;
    const hello = JSON.parse(await ws.next());
    assert.equal(hello.type, 'hello');
    assert.equal(hello.exp, exp);
    ws.send('ping-1');
    assert.equal(await ws.next(), 'ping-1');
    // Move this instance's clock to 1 s before the expiry: the socket closes about a second later.
    await admin('POST', `/${ID}/clock`, { offsetSeconds: exp - Math.floor(Date.now() / 1000) - 1 });
    const closed = await ws.waitClose(5000);
    await admin('POST', `/${ID}/clock`, { offsetSeconds: 0 });
    assert.ok(closed, 'closed');
    assert.equal(closed.code, 4001);
  });

  it('answers 502 when stopped and serves again when started', async () => {
    await admin('POST', `/${ID}/stop`);
    const n = beats.length;
    assert.equal((await viaGate('/', { tok: await token() })).status, 502);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(beats.length, n, 'no heartbeats while stopped');
    await admin('POST', `/${ID}/start`);
    assert.equal((await viaGate('/', { tok: await token() })).status, 200);
  });

  it('deletes', async () => {
    assert.equal((await admin('DELETE', `/${ID}`)).status, 200);
    assert.equal((await admin('GET', `/${ID}`)).status, 404);
    assert.equal((await viaGate('/', { tok: await token() })).status, 404);
  });
});
