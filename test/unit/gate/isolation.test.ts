// security.md "Isolation between instances, until the Public Suffix List": one test per row.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_PATHS, IDENTITY_HEADER } from '../../../packages/platform/src/shared/contracts';
import { setUpstreamFetch } from '../../../packages/platform/src/gate/forward';
import { control, gate, mintCookie, mockUpstream, newInstance, sameOrigin, signIn, type Instance, type Upstream } from './helpers';

let inst: Instance;
let up: Upstream;
let cookie: string;

beforeEach(async () => {
  inst = await newInstance();
  up = mockUpstream();
  ({ cookie } = await signIn(inst));
});
afterEach(() => setUpstreamFetch(null));

describe('row 1: cross-instance requests that change state', () => {
  it.each([
    ['cross-site', 403],
    ['same-site', 403],
    ['none', 403],
    ['same-origin', 200],
  ])('POST with Sec-Fetch-Site %s -> %i', async (site, status) => {
    const res = await gate(new Request(inst.url('/api/x'), { method: 'POST', body: '{}', headers: { cookie, 'sec-fetch-site': site } }));
    expect(res.status).toBe(status);
  });

  it('without Sec-Fetch-Site, requires Origin to equal the host', async () => {
    const other = await gate(new Request(inst.url('/api/x'), { method: 'POST', headers: { cookie, origin: 'http://evil.run.localhost' } }));
    expect(other.status).toBe(403);
    const missing = await gate(new Request(inst.url('/api/x'), { method: 'DELETE', headers: { cookie } }));
    expect(missing.status).toBe(403);
    const same = await gate(new Request(inst.url('/api/x'), { method: 'POST', body: 'hi', headers: { cookie, origin: inst.origin } }));
    expect(same.status).toBe(200);
    expect(up.bodies.at(-1)).toBe('hi');
  });

  it('refuses a cross-site WebSocket upgrade before asking anyone', async () => {
    const res = await gate(new Request(inst.url('/ws'), { headers: { cookie, upgrade: 'websocket', 'sec-fetch-site': 'same-site' } }));
    expect(res.status).toBe(403);
    expect(up.requests).toHaveLength(0);
  });

  it('refuses a foreign Origin even next to a same-origin Sec-Fetch-Site (forged pair)', async () => {
    const ws = await gate(new Request(inst.url('/ws'), { headers: { cookie, upgrade: 'websocket', origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' } }));
    expect(ws.status).toBe(403);
    const post = await gate(new Request(inst.url('/api/x'), { method: 'POST', headers: { cookie, origin: 'http://evil.run.localhost', 'sec-fetch-site': 'same-origin' } }));
    expect(post.status).toBe(403);
    expect(up.requests).toHaveLength(0);
  });

  it('refuses before the cookie is even read (no sign-in redirect)', async () => {
    const res = await gate(new Request(inst.url('/api/x'), { method: 'PUT', headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(res.status).toBe(403);
  });
});

describe('row 2: cookies', () => {
  it('forwards only __Host- cookies and never the gate own', async () => {
    const planted = `a=1; __Host-app=keep; ${cookie}; __Host-gate-state=zzz; session=evil`;
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: planted } }));
    expect(res.status).toBe(200);
    expect(up.requests[0]!.headers.get('cookie')).toBe('__Host-app=keep');
  });

  it('sends no cookie header at all when none survive', async () => {
    await gate(new Request(inst.url('/'), { headers: { cookie: `${cookie}; x=1` } }));
    expect(up.requests[0]!.headers.has('cookie')).toBe(false);
  });

  it('drops outgoing Set-Cookie that is not __Host- or would overwrite the gate cookie', async () => {
    up.respond = () => {
      const h = new Headers();
      h.append('set-cookie', 'track=1; Domain=.run.localhost; Path=/');
      h.append('set-cookie', '__Host-app=ok; Path=/; Secure; HttpOnly');
      h.append('set-cookie', '__Host-gate=evil; Path=/; Secure');
      h.append('set-cookie', '__Host-gate-state=evil; Path=/; Secure');
      return new Response('x', { headers: h });
    };
    const res = await gate(new Request(inst.url('/'), { headers: { cookie } }));
    expect(res.headers.getSetCookie()).toEqual(['__Host-app=ok; Path=/; Secure; HttpOnly']);
  });

  it('the gate cookie is __Host-, Secure, HttpOnly, SameSite=Lax', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: await mintCookie(inst, (await signIn(inst)).sid, { passExp: 0 }) } }));
    const line = res.headers.getSetCookie().find((l) => l.startsWith('__Host-gate='))!;
    expect(line).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(line).not.toMatch(/Domain/i);
  });

  it('a gate cookie from another instance host is worthless', async () => {
    const other = await newInstance();
    const res = await gate(new Request(other.url('/'), { headers: { cookie, accept: 'application/json' } }));
    expect(res.status).toBe(401);
  });
});

describe('row 3: cookie flood', () => {
  it('answers an oversized Cookie header with a recovery page that clears cookies', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `junk${i}=${'x'.repeat(30)}`).join('; ');
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: `${big}; ${cookie}` } }));
    expect(res.status).toBe(400);
    expect(res.headers.get('clear-site-data')).toBe('"cookies"');
    expect(up.requests).toHaveLength(0);
  });

  it('answers a broken Cookie header the same way', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: 'garbage without equals; a=1' } }));
    expect(res.status).toBe(400);
    expect(res.headers.get('clear-site-data')).toBe('"cookies"');
  });
});

describe('rows 4 and 5: framing and process isolation headers', () => {
  const expected = {
    'x-frame-options': 'DENY',
    'origin-agent-cluster': '?1',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  };

  it('on proxied responses, keeping the instance CSP', async () => {
    up.respond = () => new Response('x', { headers: { 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN' } });
    const res = await gate(new Request(inst.url('/'), { headers: { cookie } }));
    for (const [k, v] of Object.entries(expected)) expect(res.headers.get(k), k).toBe(v);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.has('strict-transport-security')).toBe(false); // LOCAL_DEV
  });

  it('on the gate own pages and redirects', async () => {
    const page = await gate(new Request('http://nobody.run.localhost/'));
    const redirect = await gate(new Request(inst.url('/'), { headers: { 'sec-fetch-mode': 'navigate' } }));
    for (const res of [page, redirect]) {
      for (const [k, v] of Object.entries(expected)) expect(res.headers.get(k), k).toBe(v);
    }
    expect(redirect.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    // Own pages add their strict page CSP (pages.ts); frame-ancestors stays.
    expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'nonce-[^']+';.*frame-ancestors 'none'.*, frame-ancestors 'none'$/);
  });

  it('adds HSTS with includeSubDomains outside local dev', async () => {
    const res = await gate(new Request('http://nobody.run.localhost/'), { LOCAL_DEV: undefined });
    expect(res.headers.get('strict-transport-security')).toMatch(/includeSubDomains/);
  });
});

describe('row 6: planted sign-in callback', () => {
  it('refuses a code without the matching state cookie, without exchanging it', async () => {
    await control.script({ codes: { planted: { host: inst.host, token: 't', tokenExp: 9e9, userId: 'attacker', cpSessionId: 'x', instanceId: inst.instanceId } } });
    const res = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=planted&state=whatever`)));
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((l) => l.startsWith('__Host-gate='))).toBe(false);
    expect((await control.calls()).filter((c) => c[0] === 'exchangeCode')).toHaveLength(0);
  });

  it('refuses a state that differs from the cookie', async () => {
    const first = await gate(new Request(inst.url('/'), { headers: { 'sec-fetch-mode': 'navigate' } }));
    const stateCookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
    const res = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=c&state=other`), { headers: { cookie: stateCookie } }));
    expect(res.status).toBe(400);
  });

  it('refuses a state cookie made for another host', async () => {
    const other = await newInstance();
    const first = await gate(new Request(other.url('/'), { headers: { 'sec-fetch-mode': 'navigate' } }));
    const state = new URL(first.headers.get('location')!).searchParams.get('state');
    const stateCookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
    const res = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=c&state=${state}`), { headers: { cookie: stateCookie } }));
    expect(res.status).toBe(400);
  });

  it('refuses a code bound to another host', async () => {
    const first = await gate(new Request(inst.url('/'), { headers: { 'sec-fetch-mode': 'navigate' } }));
    const state = new URL(first.headers.get('location')!).searchParams.get('state');
    const stateCookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
    await control.script({ codes: { c: { host: 'other.run.localhost', token: 't', tokenExp: 9e9, userId: 'u', cpSessionId: 'x', instanceId: inst.instanceId } } });
    const res = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=c&state=${state}`), { headers: { cookie: stateCookie } }));
    expect(res.status).toBe(400);
  });
});

describe('identity header', () => {
  it('replaces a client-supplied identity header with the gate token', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { cookie, [IDENTITY_HEADER]: 'forged' } }));
    expect(res.status).toBe(200);
    expect(up.requests[0]!.headers.get(IDENTITY_HEADER)).toBe('tok-1');
    expect(up.requests[0]!.headers.get('x-forwarded-host')).toBe(inst.host);
  });

  it('never forwards a request without a valid cookie', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { [IDENTITY_HEADER]: 'forged', accept: 'application/json' } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signin_required' });
    expect(up.requests).toHaveLength(0);
  });

  it('a tampered cookie counts as none', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: `${cookie.slice(0, -4)}AAAA` } }));
    expect(res.status).toBe(401);
  });
});

describe('hosts', () => {
  it('404 for unknown hosts, other domains and nested labels', async () => {
    for (const url of ['http://nobody.run.localhost/', 'http://x.example.com/', `http://a.${inst.host}/`]) {
      expect((await gate(new Request(url))).status).toBe(404);
    }
  });

  it('strips the port from the Host header', async () => {
    const res = await gate(new Request(`http://${inst.host}:8788/`, { headers: { cookie } }));
    expect(res.status).toBe(200);
  });

  it('forwards to the entry upstream with the original path and query', async () => {
    await gate(new Request(inst.url('/a/b?c=1'), { headers: { cookie } }));
    expect(up.requests[0]!.url).toBe('http://127.0.0.1:9100/a/b?c=1');
  });

  it('does not follow upstream redirects', async () => {
    up.respond = () => new Response(null, { status: 302, headers: { location: '/elsewhere' } });
    const res = await gate(new Request(inst.url('/'), sameOrigin(inst, { headers: { cookie } })));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/elsewhere');
  });
});
