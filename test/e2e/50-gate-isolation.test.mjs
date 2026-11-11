// (e) Isolation between instances until the PSL listing (security.md "Isolation between
// instances"; D12). Two instances in two orgs; the member of A also browses B's origin.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, GATE_PORT, INSTANCE_DOMAIN, instanceOrigin } from './lib/config.mjs';
import { request } from './lib/http.mjs';
import { openWebSocket } from './lib/ws.mjs';
import { instanceFetch, instanceFixture, jwtPayload, signInToInstance } from './lib/flows.mjs';

const skip = await skipUnlessUp();

const SECURITY_HEADERS = {
  'x-frame-options': /^DENY$/i,
  'content-security-policy': /frame-ancestors 'none'/,
  'origin-agent-cluster': /^\?1$/,
  'cross-origin-opener-policy': /^same-origin$/,
  'cross-origin-resource-policy': /^same-origin$/,
};

function assertSecurityHeaders(res, what) {
  for (const [name, re] of Object.entries(SECURITY_HEADERS)) {
    assert.match(res.header(name) ?? '', re, `${what}: ${name} (${res.status})`);
  }
}

describe('gate isolation', { skip }, () => {
  let a, b, user, originA, originB;

  before(async () => {
    a = await instanceFixture('isoA');
    b = await instanceFixture('isoB');
    user = a.member;
    originA = instanceOrigin(a.inst.host);
    originB = instanceOrigin(b.inst.host);
    await signInToInstance(user, a.inst.host);
  });

  it('state-changing requests from another instance are refused', async () => {
    // Fetch metadata says same-site (another *.run.localhost page).
    const sameSite = await instanceFetch(user, a.inst.host, '/api/pipelines', { method: 'POST', body: { go: 1 }, from: originB });
    assert.equal(sameSite.status, 403, sameSite.describe());
    assert.equal(sameSite.json().error, 'cross_origin');
    // No fetch metadata: Origin must equal the host.
    const oldBrowser = await instanceFetch(user, a.inst.host, '/api/pipelines', { method: 'POST', body: {}, from: originB, fetchMetadata: false });
    assert.equal(oldBrowser.status, 403, oldBrowser.describe());
    const noOrigin = await instanceFetch(user, a.inst.host, '/api/pipelines', { method: 'POST', body: {}, fetchMetadata: false, origin: false });
    assert.equal(noOrigin.status, 403, `neither header: ${noOrigin.describe()}`);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await instanceFetch(user, a.inst.host, '/x', { method, body: {}, from: originB });
      assert.equal(res.status, 403, `${method}: ${res.describe()}`);
    }
    // The same request from the instance's own page goes through.
    const ok = await instanceFetch(user, a.inst.host, '/api/pipelines', { method: 'POST', body: { go: 1 } });
    assert.equal(ok.status, 200, ok.describe());
    assert.equal(ok.json().method, 'POST');
    assert.equal(ok.json().body, JSON.stringify({ go: 1 }));
    const okLegacy = await instanceFetch(user, a.inst.host, '/api/pipelines', { method: 'POST', body: {}, fetchMetadata: false, origin: originA });
    assert.equal(okLegacy.status, 200, `Origin = host without fetch metadata: ${okLegacy.describe()}`);
  });

  it('cross-origin WebSocket upgrades are refused', async () => {
    const ws = await openWebSocket(`ws://${a.inst.host}:${GATE_PORT}/ws`, { browser: user.browser, origin: originB });
    assert.equal(ws.ok, false);
    assert.equal(ws.status, 403);
  });

  it('only __Host- cookies reach the instance, never the gate\'s own', async () => {
    // B's page (or JS on any *.run.localhost page) plants a parent-domain cookie.
    user.browser.jar.plant('planted', 'from-B', { domain: INSTANCE_DOMAIN });
    user.browser.jar.plant('__Secure-x', 'y', { domain: INSTANCE_DOMAIN });
    // A sets its own __Host- cookie.
    const set = await instanceFetch(user, a.inst.host, `/?setCookie=${encodeURIComponent('__Host-worca=ok; Path=/; Secure; HttpOnly')}`);
    assert.equal(set.status, 200, set.describe());
    const res = await instanceFetch(user, a.inst.host, '/echo');
    const echo = res.json();
    assert.equal(echo.cookies['__Host-worca'], 'ok');
    assert.equal(echo.cookies.planted, undefined, 'parent-domain cookie stripped');
    assert.equal(echo.cookies['__Secure-x'], undefined);
    assert.equal(echo.cookies['__Host-gate'], undefined, 'gate session cookie never forwarded');
    assert.equal(echo.cookies['__Host-gate-state'], undefined);
    user.browser.jar.delete('planted');
    user.browser.jar.delete('__Secure-x');
  });

  it('a client-supplied identity header is replaced by the gate', async () => {
    const forged = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.c2ln';
    const res = await instanceFetch(user, a.inst.host, '/who', { headers: { 'x-worca-identity': forged } });
    assert.equal(res.status, 200, res.describe());
    const echo = res.json();
    assert.equal(echo.identity.sub, user.id);
    assert.notEqual(echo.headers['x-worca-identity'], forged);
    assert.equal(jwtPayload(echo.headers['x-worca-identity']).sub, user.id);
  });

  it('only __Host- Set-Cookies from the instance reach the browser, never one named like the gate\'s', async () => {
    const asks = ['plain=1; Path=/', 'wide=1; Domain=run.localhost; Path=/', '__Host-ok=1; Path=/; Secure', '__Host-gate=evil; Path=/; Secure', '__Host-gate-state=evil; Path=/; Secure'];
    const qs = asks.map((c) => `setCookie=${encodeURIComponent(c)}`).join('&');
    const res = await instanceFetch(user, a.inst.host, `/?${qs}`);
    assert.equal(res.status, 200, res.describe());
    const names = res.setCookies.map((c) => c.slice(0, c.indexOf('=')));
    assert.ok(names.includes('__Host-ok'), `kept __Host-ok: ${res.setCookies.join(' | ')}`);
    for (const bad of ['plain', 'wide', '__Host-gate-state']) assert.ok(!names.includes(bad), `dropped ${bad}`);
    assert.ok(!res.setCookies.some((c) => c.startsWith('__Host-gate=evil')), 'instance cannot overwrite the gate cookie');
    // And the gate session still works.
    assert.equal((await instanceFetch(user, a.inst.host, '/still')).status, 200);
  });

  it('security headers on proxied responses and on the gate\'s own pages', async () => {
    assertSecurityHeaders(await instanceFetch(user, a.inst.host, '/page'), 'proxied');
    assertSecurityHeaders(await instanceFetch(user, a.inst.host, '/x', { method: 'POST', body: {}, from: originB }), 'cross-origin refusal');
    const redirect = await user.browser.fetch(`${originB}/`, { navigate: true });
    assert.equal(redirect.status, 302);
    assertSecurityHeaders(redirect, 'sign-in redirect');
  });

  it("a session for A is no session for B (cookies are per host)", async () => {
    const res = await instanceFetch(user, b.inst.host, '/x');
    assert.equal(res.status, 401, res.describe());
    // Even replaying A's sealed cookie on B's host gets nowhere (bound to the host).
    const sealed = user.browser.jar.get('__Host-gate', originA);
    assert.ok(sealed, 'have a gate cookie for A');
    const replay = await request(`${originB}/x`, { headers: { cookie: `__Host-gate=${sealed}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
    assert.equal(replay.status, 401, replay.describe());
  });
});

describe('gate request sanity (no sign-in needed)', { skip }, () => {
  it('an oversized Cookie header gets the recovery page that clears cookies', async () => {
    const res = await request(`http://anyhost0000.${INSTANCE_DOMAIN}:${GATE_PORT}/`, { headers: { cookie: `junk=${'x'.repeat(9000)}`, 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
    assert.equal(res.status, 400, res.describe());
    assert.match(res.header('clear-site-data') ?? '', /cookies/);
  });

  it('hosts deeper than one label, or outside the instance domain, are not served', async () => {
    const deep = await request(`http://x.anyhost0000.${INSTANCE_DOMAIN}:${GATE_PORT}/`);
    assert.equal(deep.status, 404, deep.describe());
  });

  it('unknown hosts get the gate\'s 404 page with the security headers', async () => {
    const res = await request(`http://unknown0000.${INSTANCE_DOMAIN}:${GATE_PORT}/`);
    assert.equal(res.status, 404);
    assertSecurityHeaders(res, 'unknown host');
  });
});
