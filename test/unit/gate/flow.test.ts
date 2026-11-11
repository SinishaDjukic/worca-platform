// architecture.md "Signing in" and "Each request after that"; D44 pass, D45 renewal, D46 revocation, D47 statuses.
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_PATHS, IDENTITY_HEADER } from '../../../packages/platform/src/shared/contracts';
import { setUpstreamFetch } from '../../../packages/platform/src/gate/forward';
import {
  control, env, gate, mintCookie, mockUpstream, newInstance, now, readSetCookie, sameOrigin, signIn, stub,
  type Instance, type Upstream,
} from './helpers';

let inst: Instance;
let up: Upstream;

beforeEach(async () => {
  inst = await newInstance();
  up = mockUpstream();
});
afterEach(() => setUpstreamFetch(null));

const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
const api = { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };

/** Puts a marker in lastVisit; a gate object check overwrites it. */
async function markVisit(i: Instance): Promise<void> {
  await runInDurableObject(stub(i), (o) => {
    (o as unknown as { meta: { lastVisit: number } }).meta.lastVisit = 1;
  });
}
const lastVisit = async (i: Instance) => (await stub(i).getState()).lastVisit;

describe('sign-in', () => {
  it('redirects a navigation to the control plane with host, state and return path', async () => {
    const res = await gate(new Request(inst.url('/p/q?x=1'), { headers: nav }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`${env.APP_ORIGIN}/authorize`);
    expect(loc.searchParams.get('host')).toBe(inst.host);
    expect(loc.searchParams.get('return')).toBe('/p/q?x=1');
    expect(loc.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-gate-state=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  });

  it('treats a GET accepting HTML without fetch metadata as a navigation', async () => {
    const res = await gate(new Request(inst.url('/'), { headers: { accept: 'text/html,*/*' } }));
    expect(res.status).toBe(302);
  });

  it('answers 401 JSON to anything else (W6)', async () => {
    const res = await gate(new Request(inst.url('/api'), { headers: api }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signin_required' });
  });

  it('callback exchanges the code, creates a session and returns to the path', async () => {
    const { callback, parsed } = await signIn(inst, { returnPath: '/deep/link?a=b' });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/deep/link?a=b');
    expect(callback.headers.getSetCookie().some((l) => /^__Host-gate-state=; .*Max-Age=0/.test(l))).toBe(true);
    expect(parsed).toMatchObject({ inst: inst.instanceId, uid: 'user-1', token: 'tok-1' });
    expect(parsed.passExp).toBeGreaterThan(now());
    expect((await stub(inst).getState()).sessions).toBe(1);
    expect(await control.calls()).toContainEqual(['exchangeCode', expect.any(String), inst.host]);
  });

  it('a code is single-use', async () => {
    const first = await gate(new Request(inst.url('/'), { headers: nav }));
    const state = new URL(first.headers.get('location')!).searchParams.get('state');
    const sc = first.headers.getSetCookie()[0]!.split(';')[0]!;
    await control.script({ codes: { once: { host: inst.host, token: 't', tokenExp: now() + 600, userId: 'u', cpSessionId: 'c', instanceId: inst.instanceId } } });
    const req = () => gate(new Request(inst.url(`${GATE_PATHS.callback}?code=once&state=${state}`), { headers: { cookie: sc } }));
    expect((await req()).status).toBe(302);
    expect((await req()).status).toBe(400);
  });

  it('rejects a code issued for another instance id', async () => {
    const first = await gate(new Request(inst.url('/'), { headers: nav }));
    const state = new URL(first.headers.get('location')!).searchParams.get('state');
    const sc = first.headers.getSetCookie()[0]!.split(';')[0]!;
    await control.script({ codes: { c: { host: inst.host, token: 't', tokenExp: now() + 600, userId: 'u', cpSessionId: 'c', instanceId: 'other' } } });
    const res = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=c&state=${state}`), { headers: { cookie: sc } }));
    expect(res.status).toBe(400);
  });

  it('never redirects off-host after the callback', async () => {
    const res = await gate(new Request(inst.url('//evil.com/x'), { headers: nav }));
    expect(new URL(res.headers.get('location')!).searchParams.get('return')).toBe('/');
  });
});

describe('pass (D44)', () => {
  it('GET with a valid pass is forwarded without asking the gate object', async () => {
    const { cookie } = await signIn(inst);
    await markVisit(inst);
    const res = await gate(new Request(inst.url('/'), { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(up.requests[0]!.headers.get(IDENTITY_HEADER)).toBe('tok-1');
    expect(await lastVisit(inst)).toBe(1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('an expired pass asks the gate object once and re-issues the pass', async () => {
    const { sid } = await signIn(inst);
    await markVisit(inst);
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: await mintCookie(inst, sid, { passExp: now() - 1 }) } }));
    expect(res.status).toBe(200);
    expect(await lastVisit(inst)).toBeGreaterThan(1);
    const next = await readSetCookie(inst, res);
    expect(next!.passExp).toBeGreaterThanOrEqual(now() + 59);
    expect(next!.sid).toBe(sid);
  });

  it('unsafe methods ask the gate object every time, even with a pass', async () => {
    const { cookie } = await signIn(inst);
    await markVisit(inst);
    const res = await gate(new Request(inst.url('/api'), sameOrigin(inst, { method: 'POST', headers: { cookie } })));
    expect(res.status).toBe(200);
    expect(await lastVisit(inst)).toBeGreaterThan(1);
  });

  it('reads that return secrets ask the gate object every time, even with a pass', async () => {
    const { cookie } = await signIn(inst);
    for (const path of ['/api/models/claude/env-value?key=ANTHROPIC_API_KEY', '/API/Models/claude/Env-Value/', '/api/models/claude/env%2Dvalue']) {
      await markVisit(inst);
      const res = await gate(new Request(inst.url(path), { headers: { cookie } }));
      expect(res.status).toBe(200);
      expect(await lastVisit(inst)).toBeGreaterThan(1);
    }
  });

  it('a secret read is refused at once when access has ended, pass or not', async () => {
    const { sid, cookie } = await signIn(inst);
    await stub(inst).dropSession(sid);
    const res = await gate(new Request(inst.url('/api/models/claude/env-value'), { headers: { cookie, ...api } }));
    expect(res.status).not.toBe(200);
    expect(up.requests).toHaveLength(0);
  });

  it('honours PASS_SECONDS', async () => {
    const { sid } = await signIn(inst);
    const res = await gate(new Request(inst.url('/'), { headers: { cookie: await mintCookie(inst, sid, { passExp: 0 }) } }), { PASS_SECONDS: '5' });
    const next = await readSetCookie(inst, res);
    expect(next!.passExp - now()).toBeLessThanOrEqual(5);
  });
});

describe('token renewal (D45)', () => {
  it('renews a token with under two minutes left and re-issues the cookie', async () => {
    const { sid } = await signIn(inst, { userId: 'user-9', cpSessionId: 'cps-9' });
    await control.script({ renew: { token: 'tok-2', tokenExp: now() + 900 } });
    const cookie = await mintCookie(inst, sid, { passExp: 0, tokenExp: now() + 60 });
    const res = await gate(new Request(inst.url('/'), { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(up.requests[0]!.headers.get(IDENTITY_HEADER)).toBe('tok-2');
    expect(await control.calls()).toContainEqual(['renewToken', { cpSessionId: 'cps-9', userId: 'user-9', host: inst.host }]);
    expect((await readSetCookie(inst, res))!.token).toBe('tok-2');
  });

  it('does not renew a token with time left', async () => {
    const { sid } = await signIn(inst);
    await control.script({});
    await gate(new Request(inst.url('/'), { headers: { cookie: await mintCookie(inst, sid, { passExp: 0, tokenExp: now() + 600 }) } }));
    expect((await control.calls()).filter((c) => c[0] === 'renewToken')).toHaveLength(0);
  });

  it('access ended: drops the session; navigation re-authenticates, API gets 401', async () => {
    const { sid } = await signIn(inst);
    await control.script({ renew: null });
    const cookie = await mintCookie(inst, sid, { passExp: 0, tokenExp: now() + 30 });
    const res = await gate(new Request(inst.url('/api'), { headers: { ...api, cookie } }));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((l) => /^__Host-gate=; /.test(l))).toBe(true);
    expect((await stub(inst).getState()).sessions).toBe(0);
    const again = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }));
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toContain('/authorize?');
    expect(up.requests).toHaveLength(0);
  });
});

describe('revocation (D46)', () => {
  it('unsafe requests are refused at once; reads keep their pass until it runs out', async () => {
    const { cookie, sid } = await signIn(inst, { userId: 'gone' });
    expect(await stub(inst).dropSessions({ userId: 'gone' })).toBe(1);

    const post = await gate(new Request(inst.url('/api'), sameOrigin(inst, { method: 'POST', headers: { cookie } })));
    expect(post.status).toBe(401);
    const ws = await gate(new Request(inst.url('/ws'), sameOrigin(inst, { headers: { cookie, upgrade: 'websocket' } })));
    expect(ws.status).toBe(401);

    const read = await gate(new Request(inst.url('/'), { headers: { cookie } }));
    expect(read.status).toBe(200);

    const expired = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie: await mintCookie(inst, sid, { passExp: now() - 1 }) } }));
    expect(expired.status).toBe(302);
    expect(up.requests).toHaveLength(1);
  });

  it('drops by control-plane session and all', async () => {
    await signIn(inst, { cpSessionId: 'a' });
    await signIn(inst, { cpSessionId: 'b' });
    await signIn(inst, { cpSessionId: 'b' });
    expect(await stub(inst).dropSessions({ cpSessionId: 'b' })).toBe(2);
    expect(await stub(inst).dropSessions({ all: true })).toBe(1);
  });
});

describe('instance status (D47)', () => {
  it('suspended: starting page and one wake however many visit', async () => {
    const { sid } = await signIn(inst);
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    const cookie = await mintCookie(inst, sid, { passExp: 0 });
    const page = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain(GATE_PATHS.status);
    const json = await gate(new Request(inst.url('/api'), { headers: { ...api, cookie } }));
    expect(json.status).toBe(503);
    expect(await json.json()).toMatchObject({ error: 'instance_starting' });
    const wakes = (await control.calls()).filter((c) => c[0] === 'requestWake');
    expect(wakes).toEqual([['requestWake', inst.instanceId, 'visit']]);
    expect((await stub(inst).getState()).waking).toBe(true);
    expect(up.requests).toHaveLength(0);

    // The first heartbeat after the wake: control plane sets running; the page reloads.
    await stub(inst).setStatus(inst.instanceId, 'running');
    await stub(inst).heartbeat(inst.instanceId, { suspendable: false, nextScheduledAt: null });
    expect((await stub(inst).getState()).waking).toBe(false);
    const status = await gate(new Request(inst.url(GATE_PATHS.status), { headers: { ...api, cookie } }));
    expect(await status.json()).toEqual({ status: 'running' });
  });

  it('sign-in to a suspended instance gives no pass, so the next request sees the status', async () => {
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    const { parsed, cookie } = await signIn(inst);
    expect(parsed.passExp).toBe(0);
    const res = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }));
    expect(res.status).toBe(503);
  });

  it('stopped: "stopped by the platform", 403, never wakes', async () => {
    const { sid } = await signIn(inst);
    await stub(inst).setStatus(inst.instanceId, 'stopped');
    const cookie = await mintCookie(inst, sid, { passExp: 0 });
    const res = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Stopped by the platform');
    expect((await control.calls()).filter((c) => c[0] === 'requestWake')).toHaveLength(0);
  });

  it.each([
    ['deleting', 404],
    ['creating', 503],
    ['upgrading', 503],
  ] as const)('%s -> %i', async (status, code) => {
    const { sid } = await signIn(inst);
    await stub(inst).setStatus(inst.instanceId, status);
    const res = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie: await mintCookie(inst, sid, { passExp: 0 }) } }));
    expect(res.status).toBe(code);
  });

  it('unknown status (no gate object state) -> 404', async () => {
    const fresh = await newInstance(null);
    const { sid } = await signIn(fresh);
    const res = await gate(new Request(fresh.url('/'), { headers: { ...api, cookie: await mintCookie(fresh, sid, { passExp: 0 }) } }));
    expect(res.status).toBe(404);
  });

  it('status path needs a valid session', async () => {
    const res = await gate(new Request(inst.url(GATE_PATHS.status), { headers: api }));
    expect(res.status).toBe(401);
  });
});

describe('sign-out', () => {
  it('drops the session and clears the cookie', async () => {
    const { cookie } = await signIn(inst);
    const res = await gate(new Request(inst.url(GATE_PATHS.signout), sameOrigin(inst, { method: 'POST', headers: { cookie } })));
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-gate=; .*Max-Age=0/);
    expect((await stub(inst).getState()).sessions).toBe(0);
  });

  it('a cross-site sign-out is refused', async () => {
    const { cookie } = await signIn(inst);
    const res = await gate(new Request(inst.url(GATE_PATHS.signout), { headers: { cookie, 'sec-fetch-site': 'same-site' } }));
    expect(res.status).toBe(403);
    expect((await stub(inst).getState()).sessions).toBe(1);
  });
});

describe('WebSocket', () => {
  it('checks the gate object and passes the upgrade response through', async () => {
    const { cookie } = await signIn(inst);
    await markVisit(inst);
    up.respond = () => {
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    };
    const res = await gate(new Request(inst.url('/ws'), sameOrigin(inst, { headers: { cookie, upgrade: 'websocket' } })));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    expect(up.requests[0]!.headers.get('upgrade')).toBe('websocket');
    expect(up.requests[0]!.headers.get(IDENTITY_HEADER)).toBe('tok-1');
    expect(await lastVisit(inst)).toBeGreaterThan(1);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

describe('an instance that does not answer', () => {
  // Short limits so the tests run fast: page loads 50 ms, everything else 300 ms.
  const quick = { UPSTREAM_PAGE_TIMEOUT_SECONDS: '0.05', UPSTREAM_TIMEOUT_SECONDS: '0.3' } as unknown as Partial<typeof env>;
  const hang = (signals: AbortSignal[]) => (req: Request) => {
    signals.push(req.signal);
    return new Promise<Response>(() => {});
  };
  const later = (ms: number, res: () => Response) => () => new Promise<Response>((r) => setTimeout(() => r(res()), ms));

  it('a page load gets the branded page instead of hanging, and the subrequest is cancelled', async () => {
    const { sid } = await signIn(inst);
    const cookie = await mintCookie(inst, sid, { passExp: 0 }); // through the gate object check
    const signals: AbortSignal[] = [];
    up.respond = hang(signals);
    const started = Date.now();
    const res = await gate(new Request(inst.url('/pipelines?x=1'), { headers: { ...nav, cookie } }), quick);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.status).toBe(504);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
    const html = await res.text();
    expect(html).toContain(`${inst.host} isn&#39;t answering right now`);
    expect(html).toContain('href="/pipelines?x=1"'); // try again where the visitor was
    expect(html).toContain('location.reload()');
    expect(signals[0]!.aborted).toBe(true);
    // The gate cookie (pass) is still re-issued: the session is fine, the instance isn't.
    expect(await readSetCookie(inst, res)).not.toBeNull();
  });

  it('the pass path (no gate object check) gets the same page', async () => {
    const { cookie } = await signIn(inst);
    up.respond = hang([]);
    const res = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }), quick);
    expect(res.status).toBe(504);
    expect(await res.text()).toContain("answering right now");
  });

  it('API calls get JSON, and only after the longer limit: a slow answer (long poll) still comes through', async () => {
    const { cookie } = await signIn(inst);
    up.respond = later(150, () => Response.json({ polled: true }));
    const slow = await gate(new Request(inst.url('/api/events?wait=1'), { headers: { ...api, cookie } }), quick);
    expect(slow.status).toBe(200);
    expect(await slow.json()).toEqual({ polled: true });

    up.respond = hang([]);
    const res = await gate(new Request(inst.url('/api/health'), { headers: { ...api, cookie } }), quick);
    expect(res.status).toBe(504);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(await res.json()).toEqual({ error: 'instance_unresponsive', reason: 'timeout' });
  });

  it('only the time to the headers is bounded: a body streamed for longer arrives whole', async () => {
    const { cookie } = await signIn(inst);
    up.respond = () => {
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      void (async () => {
        await w.write(enc.encode('first '));
        await new Promise((r) => setTimeout(r, 200)); // well past the 50 ms page limit
        await w.write(enc.encode('second'));
        await w.close();
      })();
      return new Response(readable, { headers: { 'content-type': 'text/html' } });
    };
    const res = await gate(new Request(inst.url('/download'), { headers: { ...nav, cookie } }), quick);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('first second');
  });

  it('an unreachable instance (network error, or Cloudflare 530 with no tunnel connector) gets 502', async () => {
    const { cookie } = await signIn(inst);
    up.respond = () => {
      throw new TypeError('Network connection lost.');
    };
    const page = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }), quick);
    expect(page.status).toBe(502);
    expect(await page.text()).toContain('answering right now');

    up.respond = () => new Response('error code: 1033', { status: 530 });
    const tunnel = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }), quick);
    expect(tunnel.status).toBe(502);
    expect(await tunnel.text()).not.toContain('1033');
    const json = await gate(new Request(inst.url('/api/x'), { headers: { ...api, cookie } }), quick);
    expect(json.status).toBe(502);
    expect(await json.json()).toEqual({ error: 'instance_unresponsive', reason: 'unreachable' });
  });

  it('a WebSocket handshake that never completes is answered with JSON after the page limit', async () => {
    const { cookie } = await signIn(inst);
    up.respond = hang([]);
    const res = await gate(new Request(inst.url('/ws'), sameOrigin(inst, { headers: { cookie, upgrade: 'websocket' } })), quick);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: 'instance_unresponsive' });
  });

  it('a suspended instance still wakes on a visit and is never forwarded to', async () => {
    const { sid } = await signIn(inst);
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    up.respond = hang([]);
    const res = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie: await mintCookie(inst, sid, { passExp: 0 }) } }), quick);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Waking up');
    expect(up.requests).toHaveLength(0);
  });
});
