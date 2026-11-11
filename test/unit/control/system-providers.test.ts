import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dnsRecordQuota, PROVIDERS_CACHE_KEY, resetSystemDeps, setSystemDeps } from '../../../packages/platform/src/control/system/providers';
import { envWith, staffUser, systemHarness, testEnv } from './helpers/system-harness';

const call = systemHarness();
const realEnv = envWith({
  LOCAL_DEV: undefined,
  COMPUTE_PROVIDER: 'railway',
  EDGE_PROVIDER: 'cloudflare',
  RAILWAY_TOKEN: 'rw-token',
  RAILWAY_WORKSPACE_ID: 'ws-1',
  CF_API_TOKEN: 'cf-token',
  CF_ACCOUNT_ID: 'acct-1',
  CF_ZONE_ID: 'zone-1',
  TURNSTILE_SECRET: 'ts',
  TURNSTILE_SITE_KEY: 'tk',
});

const cf = (result: unknown, total?: number) =>
  new Response(JSON.stringify({ success: true, result, result_info: total === undefined ? undefined : { total_count: total } }));

function fakeProviders(opts: { railwayFails?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1_000;
  setSystemDeps({
    now: () => clock,
    fetch: async (url, init) => {
      calls.push({ url, init });
      clock += url.includes('railway') ? 120 : 30;
      if (url.includes('railway')) {
        if (opts.railwayFails) return new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }));
        return new Response(JSON.stringify({ data: { workspace: { plan: 'HOBBY', projectCount: 18, subscriptionPlanLimit: { projects: 50, volumes: 10 } } } }));
      }
      if (url.includes('/cfd_tunnel')) return cf([{}], 7);
      if (url.includes('/dns_records')) return cf([{}], 15);
      if (url.endsWith('/zones/zone-1')) return cf({ plan: { legacy_id: 'free' }, created_on: '2026-10-06T10:00:00Z' });
      return new Response('{}', { status: 404 });
    },
  });
  return calls;
}

beforeEach(async () => {
  await testEnv.KV.delete(PROVIDERS_CACHE_KEY);
});
afterEach(resetSystemDeps);

describe('GET /api/platform/system/providers (P12)', () => {
  it('needs platform.view', async () => {
    expect((await call('/api/platform/system/providers', { user: await staffUser(null), env: realEnv })).status).toBe(403);
  });

  it('reports Railway and Cloudflare usage with our own latency, read-only, then serves the cache', async () => {
    const calls = fakeProviders();
    const user = await staffUser('support');
    const res = await call('/api/platform/system/providers', { user, env: realEnv });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      fake: false,
      cached: false,
      compute: { ok: true, provider: 'railway', displayName: 'Railway', plan: 'HOBBY', items: [{ label: 'projects', used: 18, limit: 50 }] },
      cloudflare: { tunnels: { ok: true, count: 7 }, dnsRecords: { ok: true, count: 15, quota: 200, zonePlan: 'free' } },
      turnstile: { configured: true },
    });
    expect(body.compute.latencyMs).toBeGreaterThan(0);
    expect(body.cloudflare.tunnels.latencyMs).toBeGreaterThan(0);
    expect(body.compute.fake).toBeUndefined();

    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acct-1/cfd_tunnel?is_deleted=false&per_page=1',
      'https://api.cloudflare.com/client/v4/zones/zone-1',
      'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?per_page=1',
      'https://backboard.railway.com/graphql/v2',
    ]);
    for (const c of calls) if (c.url.includes('cloudflare')) expect(c.init.method).toBe('GET');
    const gql = JSON.parse(calls.find((c) => c.url.includes('railway'))!.init.body as string);
    expect(gql.query).toMatch(/^query /);
    expect(gql.variables).toEqual({ workspaceId: 'ws-1' });

    const again = (await (await call('/api/platform/system/providers', { user, env: realEnv })).json()) as Record<string, unknown>;
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('reports a failing provider without failing the page', async () => {
    fakeProviders({ railwayFails: true });
    const body = (await (await call('/api/platform/system/providers', { user: await staffUser('admin'), env: realEnv })).json()) as Record<string, any>;
    expect(body.compute).toMatchObject({ ok: false, error: expect.stringContaining('Not Authorized') });
    expect(body.cloudflare.tunnels.ok).toBe(true);
  });

  it('reports missing credentials as not configured, without calling out', async () => {
    const calls = fakeProviders();
    const env = envWith({ LOCAL_DEV: undefined, COMPUTE_PROVIDER: 'railway', EDGE_PROVIDER: 'cloudflare', RAILWAY_TOKEN: undefined, CF_API_TOKEN: undefined, TURNSTILE_SECRET: undefined });
    const body = (await (await call('/api/platform/system/providers', { user: await staffUser('support'), env })).json()) as Record<string, any>;
    expect(body.compute).toMatchObject({ ok: false, error: expect.stringContaining('not_configured: RAILWAY_TOKEN') });
    expect(body.cloudflare.dnsRecords).toMatchObject({ ok: false, error: expect.stringContaining('not_configured') });
    expect(body.turnstile.configured).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('local dev and fake providers get a clearly marked fake result', async () => {
    const calls = fakeProviders();
    const body = (await (await call('/api/platform/system/providers', { user: await staffUser('support') })).json()) as Record<string, any>;
    expect(body.fake).toBe(true);
    expect(body.compute.fake).toBe(true);
    expect(body.cloudflare.tunnels.fake).toBe(true);
    expect(body.cloudflare.dnsRecords.fake).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('dnsRecordQuota', () => {
  it('follows the zone plan and creation date', () => {
    expect(dnsRecordQuota('free', '2026-10-06T10:00:00Z')).toBe(200);
    expect(dnsRecordQuota('free', '2023-01-01T00:00:00Z')).toBe(1000);
    expect(dnsRecordQuota('pro', null)).toBe(3500);
    expect(dnsRecordQuota(null, null)).toBeNull();
  });
});
