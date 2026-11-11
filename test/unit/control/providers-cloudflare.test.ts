import { describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { CF_API, createCloudflareEdge } from '../../../packages/platform/src/control/providers/cloudflare';
import type { InstanceSpec } from '../../../packages/platform/src/control/providers/types';
import cf from './fixtures/providers/cloudflare-responses.json';

const env = { CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct-1', CF_ZONE_ID: 'zone-1', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;
// Where the compute provider (Railway) says the services answer.
const origins = { worca: 'http://worca-run-worca.railway.internal:4317', keyPage: 'http://worca-run-broker.railway.internal:8081' };
const TUNNEL = cf.tunnelCreate.result.id;
const T = `${CF_API}/accounts/acct-1/cfd_tunnel`;
const Z = `${CF_API}/zones/zone-1/dns_records`;

const spec: InstanceSpec = {
  instanceId: 'inst-1',
  orgId: 'org-1',
  host: 'k7m2qz9xwp.worca.run',
  keyHost: 'p3n8vt6rcd.worca.run',
  region: 'europe-west4',
  cpu: 2,
  memoryMb: 4096,
  volumeGb: 10,
  image: { worca: 'w', broker: 'b', cloudflared: 'c' },
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call, answer: () => Response) => Response | undefined;

/**
 * Fake Cloudflare API: the first handler that answers wins, else the default routes. It keeps the
 * tunnels and DNS records created, so the lookups before each create see them; a handler gets
 * `answer()`, the default answer, to fake "done at Cloudflare, then failed".
 */
function fakeCf(...handlers: Handler[]) {
  const calls: Call[] = [];
  const world = {
    tunnels: [] as { id: string; name: string }[],
    records: [] as { id: string; type: string; name: string; content: string; proxied: boolean; comment: string | null }[],
  };
  let dns = 0;
  const answer = (call: Call): Response => {
    const { url } = call;
    const q = new URL(url).searchParams;
    if (call.method === 'GET' && url.startsWith(`${T}?`)) return Response.json({ success: true, result: world.tunnels.filter((t) => t.name === q.get('name')) });
    if (call.method === 'POST' && url === T) {
      world.tunnels.push({ id: TUNNEL, name: call.body.name });
      return Response.json(cf.tunnelCreate);
    }
    if (call.method === 'PUT' && url.endsWith('/configurations')) return Response.json(cf.configurations);
    if (call.method === 'GET' && url.endsWith('/token')) return Response.json(cf.token);
    if (call.method === 'GET' && url.startsWith(`${Z}?`)) return Response.json({ success: true, result: world.records.filter((r) => r.name === q.get('name')) });
    if (call.method === 'POST' && url === Z) {
      const rec = { id: `rec-${++dns}`, ...call.body };
      world.records.push(rec);
      return Response.json({ ...cf.dnsCreate, result: rec });
    }
    if (call.method === 'PUT' && url.startsWith(`${Z}/`)) {
      const rec = world.records.find((r) => url.endsWith(`/${r.id}`))!;
      Object.assign(rec, call.body);
      return Response.json({ ...cf.dnsCreate, result: rec });
    }
    if (call.method === 'DELETE') return Response.json(cf.deleted);
    throw new Error(`unexpected ${call.method} ${url}`);
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const res = h(call, () => answer(call));
      if (res) return res;
    }
    return answer(call);
  };
  const strip = (u: string) => u.replace(CF_API, '').replace(/\?.*$/, '?…');
  return {
    calls,
    world,
    fetchImpl,
    routes: () => calls.map((c) => `${c.method} ${strip(c.url)}`),
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}

describe('cloudflare edge', () => {
  it('createTunnel makes a remotely managed, prefixed tunnel with ingress and returns its token', async () => {
    const fake = fakeCf();
    const out = await createCloudflareEdge(env, fake.fetchImpl).createTunnel(spec, origins);
    expect(out).toEqual({ tunnelId: TUNNEL, tunnelToken: cf.token.result });
    expect(fake.routes()).toEqual([
      'GET /accounts/acct-1/cfd_tunnel?…', // an earlier attempt's tunnel? none
      'POST /accounts/acct-1/cfd_tunnel',
      `PUT /accounts/acct-1/cfd_tunnel/${TUNNEL}/configurations`,
      `GET /accounts/acct-1/cfd_tunnel/${TUNNEL}/token`,
    ]);
    expect(new URL(fake.calls[0]!.url).searchParams.get('name')).toBe('worca-run-inst-1');
    expect(fake.calls[1]!.headers.authorization).toBe('Bearer cf-token');
    expect(fake.calls[1]!.body).toEqual({ name: 'worca-run-inst-1', config_src: 'cloudflare' });
    expect(fake.calls[2]!.body).toEqual({
      config: {
        ingress: [
          { hostname: 'k7m2qz9xwp.worca.run', service: 'http://worca-run-worca.railway.internal:4317' },
          { hostname: 'p3n8vt6rcd.worca.run', service: 'http://worca-run-broker.railway.internal:8081' },
          { service: 'http_status:404' },
        ],
      },
    });
    expect(fake.calls[3]!.body).toBeUndefined();
  });

  it('addDns creates two proxied CNAMEs to the tunnel', async () => {
    const fake = fakeCf();
    const ids = await createCloudflareEdge(env, fake.fetchImpl).addDns(spec, TUNNEL);
    expect(ids).toEqual(['rec-1', 'rec-2']);
    expect(fake.writes().map((c) => c.body)).toEqual(
      [spec.host, spec.keyHost].map((name) => ({
        type: 'CNAME',
        name,
        content: `${TUNNEL}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: 'worca-run inst-1',
      })),
    );
  });

  it('tunnel created at Cloudflare but the answer lost: the same tunnel is used, never a second one', async () => {
    const fake = fakeCf((c, answer) => (c.method === 'POST' && c.url === T ? (answer(), new Response('', { status: 502 })) : undefined));
    const out = await createCloudflareEdge(env, fake.fetchImpl).createTunnel(spec, origins);
    expect(out.tunnelId).toBe(TUNNEL);
    expect(fake.world.tunnels).toHaveLength(1);
    expect(fake.routes().filter((r) => r === 'POST /accounts/acct-1/cfd_tunnel')).toHaveLength(1);
  });

  it('a retry after the configuration call failed configures the tunnel the first attempt made', async () => {
    let failed = false;
    const fake = fakeCf((c) => (c.method === 'PUT' && !failed ? ((failed = true), Response.json(cf.error, { status: 500 })) : undefined));
    const edge = createCloudflareEdge(env, fake.fetchImpl);
    await expect(edge.createTunnel(spec, origins)).rejects.toThrow();
    const out = await edge.createTunnel(spec, origins);
    expect(out).toEqual({ tunnelId: TUNNEL, tunnelToken: cf.token.result });
    expect(fake.world.tunnels).toHaveLength(1);
    expect(fake.routes().filter((r) => r.startsWith('PUT'))).toEqual(Array(2).fill(`PUT /accounts/acct-1/cfd_tunnel/${TUNNEL}/configurations`));
  });

  it('addDns after a lost answer reuses the record instead of adding a duplicate', async () => {
    let lost = false;
    const fake = fakeCf((c, answer) => (c.method === 'POST' && c.url === Z && !lost ? (answer(), (lost = true), new Response('', { status: 502 })) : undefined));
    const edge = createCloudflareEdge(env, fake.fetchImpl);
    await expect(edge.addDns(spec, TUNNEL)).rejects.toThrow('HTTP 502');
    expect(await edge.addDns(spec, TUNNEL)).toEqual(['rec-1', 'rec-2']);
    expect(fake.world.records.map((r) => r.name)).toEqual([spec.host, spec.keyHost]);
  });

  it('addDns points an earlier attempt\'s record at the current tunnel', async () => {
    const fake = fakeCf();
    fake.world.records.push({ id: 'rec-old', type: 'CNAME', name: spec.host, content: 'old-tunnel.cfargotunnel.com', proxied: true, comment: 'worca-run inst-1' });
    expect(await createCloudflareEdge(env, fake.fetchImpl).addDns(spec, TUNNEL)).toEqual(['rec-old', 'rec-1']);
    expect(fake.world.records[0]!.content).toBe(`${TUNNEL}.cfargotunnel.com`);
    expect(fake.routes()).toContain('PUT /zones/zone-1/dns_records/rec-old');
  });

  it('addDns never touches a record it did not make', async () => {
    const fake = fakeCf();
    fake.world.records.push({ id: 'rec-x', type: 'A', name: spec.host, content: '192.0.2.1', proxied: true, comment: null });
    await expect(createCloudflareEdge(env, fake.fetchImpl).addDns(spec, TUNNEL)).rejects.toThrow('not a worca-run one');
    expect(fake.writes()).toEqual([]);
  });

  it('findEdge finds the tunnel by name and only this instance\'s records', async () => {
    const fake = fakeCf();
    fake.world.tunnels.push({ id: 'tun-9', name: 'worca-run-inst-1' });
    fake.world.records.push(
      { id: 'mine', type: 'CNAME', name: spec.host, content: 'x', proxied: true, comment: 'worca-run inst-1' },
      { id: 'other', type: 'CNAME', name: spec.keyHost, content: 'x', proxied: true, comment: 'worca-run inst-2' },
    );
    const edge = createCloudflareEdge(env, fake.fetchImpl);
    expect(await edge.findEdge('inst-1', [spec.host, spec.keyHost])).toEqual({ tunnelId: 'tun-9', dnsRecordIds: ['mine'] });
    expect(await edge.findEdge('inst-3', [spec.host])).toBeNull();
  });

  it('deleteDns deletes each record and ignores ones already gone', async () => {
    const fake = fakeCf((c) => (c.url.endsWith('/rec-2') ? Response.json(cf.error, { status: 404 }) : undefined));
    await createCloudflareEdge(env, fake.fetchImpl).deleteDns(['rec-1', 'rec-2']);
    expect(fake.routes()).toEqual(['DELETE /zones/zone-1/dns_records/rec-1', 'DELETE /zones/zone-1/dns_records/rec-2']);
  });

  it('deleteTunnel cleans up connections first', async () => {
    const fake = fakeCf();
    await createCloudflareEdge(env, fake.fetchImpl).deleteTunnel(TUNNEL);
    expect(fake.routes()).toEqual([
      `DELETE /accounts/acct-1/cfd_tunnel/${TUNNEL}/connections`,
      `DELETE /accounts/acct-1/cfd_tunnel/${TUNNEL}`,
    ]);
  });

  it('throws the API error messages on success:false', async () => {
    const fake = fakeCf((c) => (c.method === 'POST' && c.url === Z ? Response.json(cf.error, { status: 400 }) : undefined));
    await expect(createCloudflareEdge(env, fake.fetchImpl).addDns(spec, TUNNEL)).rejects.toThrow(
      '81053: An A, AAAA, or CNAME record with that host already exists.',
    );
  });

  it('retries on 429', async () => {
    let n = 0;
    const waits: number[] = [];
    const fake = fakeCf((c) => (c.method === 'POST' && c.url === T && ++n === 1 ? new Response('', { status: 429 }) : undefined));
    await createCloudflareEdge(env, fake.fetchImpl, { sleep: async (ms) => void waits.push(ms) }).createTunnel(spec, origins);
    expect(waits).toEqual([1000]);
    expect(fake.routes()[1]).toBe(fake.routes()[2]);
  });

  it('rotateTunnelSecret sets a new secret on our tunnel and returns its new token (D74)', async () => {
    const tunnelById = (name: string): Handler => (c) =>
      c.method === 'GET' && c.url === `${T}/${TUNNEL}` ? Response.json({ success: true, result: { id: TUNNEL, name } }) : undefined;
    const patched: Handler = (c) => (c.method === 'PATCH' ? Response.json({ success: true, result: { id: TUNNEL } }) : undefined);
    const fake = fakeCf(tunnelById('worca-run-inst-1'), patched);
    expect(await createCloudflareEdge(env, fake.fetchImpl).rotateTunnelSecret(TUNNEL)).toBe(cf.token.result);
    expect(fake.routes()).toEqual([
      `GET /accounts/acct-1/cfd_tunnel/${TUNNEL}`,
      `PATCH /accounts/acct-1/cfd_tunnel/${TUNNEL}`,
      `DELETE /accounts/acct-1/cfd_tunnel/${TUNNEL}/connections`, // open connections don't survive the old secret
      `GET /accounts/acct-1/cfd_tunnel/${TUNNEL}/token`,
    ]);
    const secret = fake.calls[1]!.body.tunnel_secret as string;
    expect(Object.keys(fake.calls[1]!.body)).toEqual(['tunnel_secret']);
    expect(atob(secret)).toHaveLength(32);

    // Another tunnel in the account (the team's own instance) is never touched.
    const foreign = fakeCf(tunnelById('worca-01'), patched);
    await expect(createCloudflareEdge(env, foreign.fetchImpl).rotateTunnelSecret(TUNNEL)).rejects.toThrow('not one of ours (worca-run-*)');
    expect(foreign.writes()).toEqual([]);
  });

  it('refuses to run without credentials', async () => {
    const fake = fakeCf();
    await expect(createCloudflareEdge({} as Env, fake.fetchImpl).deleteTunnel(TUNNEL)).rejects.toThrow('is not set');
    expect(fake.calls).toHaveLength(0);
  });
});
