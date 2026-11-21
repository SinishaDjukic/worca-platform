// security.md "Design preview assets": the one read the gate forwards without its session cookie.
// worca's sandboxed preview frame has an opaque origin, so its subresource requests are cross-site
// and cookieless; worca's own path token is the credential there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_HEADER } from '../../../packages/platform/src/shared/contracts';
import { setUpstreamFetch } from '../../../packages/platform/src/gate/forward';
import { isPreviewAssetRead } from '../../../packages/platform/src/gate/handler';
import { env, gate, mintCookie, mockUpstream, newInstance, stub, type Instance, type Upstream } from './helpers';

const TOKEN = 'A'.repeat(43);
const ASSET = `/design-preview/${TOKEN}/run/img/big.png`;
/** What a sandboxed frame's `<img>` sends: no cookie, cross-site, not a navigation. */
const FRAME = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };
/** worca's headers on a token-verified preview response (preview-doc.mjs `previewHeaders`). */
const WORCA_PREVIEW = {
  'content-type': 'image/png',
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'cache-control': 'no-store',
};

let inst: Instance;
let up: Upstream;

beforeEach(async () => {
  inst = await newInstance();
  up = mockUpstream();
  up.respond = () => new Response('png', { headers: WORCA_PREVIEW });
});
afterEach(() => setUpstreamFetch(null));

describe('a preview asset requested from the sandboxed frame', () => {
  it('is forwarded without a gate session, and keeps worca\'s cross-origin resource policy', async () => {
    const res = await gate(new Request(inst.url(ASSET), { headers: FRAME }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png');
    expect(up.requests).toHaveLength(1);
    expect(new URL(up.requests[0]!.url).pathname).toBe(ASSET);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers HEAD and fetch() (cors mode) the same way', async () => {
    const head = await gate(new Request(inst.url(ASSET), { method: 'HEAD', headers: FRAME }));
    expect(head.status).toBe(200);
    const cors = await gate(new Request(inst.url(`/design-preview/${TOKEN}/run/data.json`), {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'null' },
    }));
    expect(cors.status).toBe(200);
    expect(up.requests).toHaveLength(2);
  });

  it('carries no identity to the instance: no token, no cookies, nothing the client sent', async () => {
    const cookie = await mintCookie(inst, 'sid-1');
    await gate(new Request(inst.url(ASSET), {
      headers: { ...FRAME, cookie: `${cookie}; __Host-worca=1`, [IDENTITY_HEADER]: 'forged', authorization: 'Bearer x' },
    }));
    const sent = up.requests[0]!.headers;
    expect(sent.get(IDENTITY_HEADER)).toBeNull();
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('x-forwarded-host')).toBe(inst.host);
  });

  it('sets no cookie, not the gate\'s and not one from the instance', async () => {
    up.respond = () => {
      const headers = new Headers(WORCA_PREVIEW);
      headers.append('set-cookie', '__Host-worca=1; Path=/; Secure');
      return new Response('png', { headers });
    };
    const res = await gate(new Request(inst.url(ASSET), { headers: FRAME }));
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('does not ask the gate object: no session is made and a suspended instance is not woken', async () => {
    const asleep = await newInstance('suspended');
    const res = await gate(new Request(asleep.url(ASSET), { headers: FRAME }));
    expect(res.status).toBe(200); // the mocked upstream answers; a real suspended instance has no connector (502)
    const state = await stub(asleep).getState();
    expect(state.status).toBe('suspended');
    expect(state.waking).toBe(false);
    expect(state.sessions).toBe(0);
  });

  it('answers 404 for a host with no instance, without forwarding', async () => {
    const res = await gate(new Request(`http://nobody.${env.INSTANCE_DOMAIN}${ASSET}`, { headers: FRAME }));
    expect(res.status).toBe(404);
    expect(up.requests).toHaveLength(0);
  });

  it('resets the resource policy when worca refuses (its refusals are bare)', async () => {
    up.respond = () => new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const res = await gate(new Request(inst.url(ASSET), { headers: FRAME }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

describe('everything else still needs the gate session', () => {
  const refused: [string, string, Record<string, string>, RequestInit?][] = [
    ['the preview document itself', `/design-preview/${TOKEN}/run/`, FRAME],
    ['a path with no mode', `/design-preview/${TOKEN}/img.png`, FRAME],
    ['an unknown mode', `/design-preview/${TOKEN}/live/img.png`, FRAME],
    ['a short token', `/design-preview/${'A'.repeat(42)}/run/img.png`, FRAME],
    ['a token with other characters', `/design-preview/${'A'.repeat(42)}~/run/img.png`, FRAME],
    ['another spelling of the mount', `/Design-Preview/${TOKEN}/run/img.png`, FRAME],
    ['another worca path', '/api/designs', FRAME],
    ['dot segments that leave the mount', `/design-preview/${TOKEN}/run/../../../api/designs`, FRAME],
    ['encoded dot segments that leave the mount', `/design-preview/${TOKEN}/run/%2e%2e/%2e%2e/%2e%2e/api/designs`, FRAME],
    ['a navigation', ASSET, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }],
    ['a request from another instance (same-site)', ASSET, { ...FRAME, 'sec-fetch-site': 'same-site' }],
    ['a same-origin request', ASSET, { ...FRAME, 'sec-fetch-site': 'same-origin' }],
    ['a request without Sec-Fetch-Site', ASSET, { accept: 'image/png' }],
  ];

  it.each(refused)('%s', async (_name, path, headers) => {
    const res = await gate(new Request(inst.url(path), { headers }));
    expect([401, 302]).toContain(res.status);
    expect(up.requests).toHaveLength(0);
  });

  it.each(['POST', 'PUT', 'DELETE'])('%s to a preview asset is refused as cross-origin', async (method) => {
    const res = await gate(new Request(inst.url(ASSET), { method, headers: FRAME }));
    expect(res.status).toBe(403);
    expect(up.requests).toHaveLength(0);
  });

  it('a WebSocket upgrade on a preview asset is refused', async () => {
    const res = await gate(new Request(inst.url(ASSET), { headers: { ...FRAME, upgrade: 'websocket' } }));
    expect(res.status).toBe(403);
    expect(up.requests).toHaveLength(0);
  });

  it('a signed-in read of another path loses an upstream cross-origin resource policy', async () => {
    const cookie = await mintCookie(inst, 'sid-1');
    const res = await gate(new Request(inst.url('/api/designs'), { headers: { cookie, 'sec-fetch-site': 'same-origin' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

describe('isPreviewAssetRead', () => {
  const req = (path: string, init: RequestInit = { headers: FRAME }) => new Request(`http://x.test${path}`, init);
  it('matches only GET and HEAD of a file below /design-preview/<43-char token>/<build|run>/', () => {
    expect(isPreviewAssetRead(req(ASSET))).toBe(true);
    expect(isPreviewAssetRead(req(`/design-preview/${TOKEN}/build/a.css`))).toBe(true);
    expect(isPreviewAssetRead(req(ASSET, { method: 'HEAD', headers: FRAME }))).toBe(true);
    expect(isPreviewAssetRead(req(ASSET, { method: 'OPTIONS', headers: FRAME }))).toBe(false);
    expect(isPreviewAssetRead(req(`/design-preview/${TOKEN}/run/`))).toBe(false);
    expect(isPreviewAssetRead(req(`/x/design-preview/${TOKEN}/run/a.png`))).toBe(false);
  });
});
