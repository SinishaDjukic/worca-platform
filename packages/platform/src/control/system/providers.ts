// Provider usage for the system page (P12): the compute provider's plan and usage (its own
// usage(); Railway: workspace plan and project count), Cloudflare tunnel and DNS record counts
// against the zone's record quota, Turnstile configured. All calls are read-only and timed by us
// (providers publish no latency API); the result is cached in KV.
import type { Env } from '../env';
import { computeDefinition, loadDeploymentSettings, providerContext } from '../providers';
import { CF_API } from '../providers/cloudflare';
import type { ProviderUsage } from '../providers/types';

export const PROVIDERS_CACHE_KEY = 'system:providers';
export const PROVIDERS_CACHE_TTL_S = 600;
/** Partial failures are retried sooner. */
const PROVIDERS_ERROR_TTL_S = 60;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultDeps = { fetch: ((url, init) => fetch(url, init)) as Fetch, now: () => Date.now() };
let deps = defaultDeps;
export function setSystemDeps(d: Partial<typeof defaultDeps>): void {
  deps = { ...defaultDeps, ...d };
}
export function resetSystemDeps(): void {
  deps = defaultDeps;
}

/** One provider call: its own wall time and either the values or an error. */
export type Probe<T> =
  | ({ ok: true; fake?: true; latencyMs: number } & T)
  | { ok: false; fake?: true; latencyMs: number | null; error: string };

export interface ProvidersReport {
  /** True when every section is a fake (local dev or fake providers). */
  fake: boolean;
  checkedAt: number;
  /** The compute provider's account: COMPUTE_PROVIDER's name and display name, then what its usage() said. */
  compute: Probe<{ provider: string; displayName: string } & ProviderUsage>;
  cloudflare: {
    tunnels: Probe<{ count: number }>;
    dnsRecords: Probe<{ count: number; quota: number | null; zonePlan: string | null }>;
  };
  turnstile: { configured: boolean };
}

/**
 * DNS records per zone (developers.cloudflare.com/dns/troubleshooting/faq, "record quota"):
 * Free zones created on or after 2024-09-01 get 200, older Free zones 1,000; paid plans 3,500.
 */
export function dnsRecordQuota(plan: string | null, createdOn: string | null): number | null {
  if (!plan) return null;
  if (plan === 'free') {
    const created = createdOn ? Date.parse(createdOn) : NaN;
    return Number.isFinite(created) && created < Date.parse('2024-09-01T00:00:00Z') ? 1000 : 200;
  }
  if (plan === 'pro' || plan === 'business' || plan === 'enterprise') return 3500;
  return null;
}

const short = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

async function timed<T>(f: () => Promise<T>): Promise<Probe<T>> {
  const start = deps.now();
  try {
    const value = await f();
    return { ok: true, latencyMs: deps.now() - start, ...value };
  } catch (err) {
    return { ok: false, latencyMs: deps.now() - start, error: short(err) };
  }
}

const notConfigured = (names: string): { ok: false; latencyMs: null; error: string } => ({ ok: false, latencyMs: null, error: `not_configured: ${names}` });

async function computeProbe(env: Env): Promise<ProvidersReport['compute']> {
  const def = computeDefinition(env.COMPUTE_PROVIDER);
  const ctx = providerContext(env, deps.fetch as typeof fetch, await loadDeploymentSettings(env));
  const missing = def.missingConfig?.(ctx) ?? [];
  if (missing.length) return notConfigured(missing.join(', '));
  const { usage } = def;
  if (!usage) return { ok: false, latencyMs: null, error: 'not_supported: the compute provider reports no usage' };
  const who = { provider: env.COMPUTE_PROVIDER, displayName: def.info.displayName };
  return timed(async () => ({ ...who, ...(await usage(ctx)) }));
}

async function cfGet<T>(env: Env, path: string): Promise<{ result: T; result_info?: { total_count?: number } }> {
  const res = await deps.fetch(`${CF_API}${path}`, { method: 'GET', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result: T; result_info?: { total_count?: number }; errors?: { code: number; message: string }[] } | null;
  if (!json?.success) {
    const messages = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`cloudflare GET ${path.split('?')[0]}: ${messages || `HTTP ${res.status}`}`);
  }
  return json;
}

const totalCount = (r: { result_info?: { total_count?: number } }) => {
  const n = r.result_info?.total_count;
  if (typeof n !== 'number') throw new Error('cloudflare: no result_info.total_count');
  return n;
};

async function tunnelsProbe(env: Env): Promise<ProvidersReport['cloudflare']['tunnels']> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return notConfigured('CF_API_TOKEN, CF_ACCOUNT_ID');
  return timed(async () => ({ count: totalCount(await cfGet(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=1`)) }));
}

async function dnsProbe(env: Env): Promise<ProvidersReport['cloudflare']['dnsRecords']> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return notConfigured('CF_API_TOKEN, CF_ZONE_ID');
  // Latency covers both calls (records count and zone plan), made in parallel.
  return timed(async () => {
    const [records, zone] = await Promise.all([
      cfGet(env, `/zones/${env.CF_ZONE_ID}/dns_records?per_page=1`),
      cfGet<{ plan?: { legacy_id?: string }; created_on?: string }>(env, `/zones/${env.CF_ZONE_ID}`).catch(() => null),
    ]);
    const zonePlan = zone?.result.plan?.legacy_id ?? null;
    return { count: totalCount(records), zonePlan, quota: dnsRecordQuota(zonePlan, zone?.result.created_on ?? null) };
  });
}

// Clearly marked stand-ins for local dev and the fake providers: nothing is called.
const fakeCompute = (env: Env): ProvidersReport['compute'] => ({
  ok: true, fake: true, latencyMs: 0, provider: env.COMPUTE_PROVIDER, displayName: computeDefinition(env.COMPUTE_PROVIDER).info.displayName,
  plan: 'FAKE', items: [{ label: 'projects', used: 0, limit: null }], details: null,
});
const FAKE_TUNNELS: ProvidersReport['cloudflare']['tunnels'] = { ok: true, fake: true, latencyMs: 0, count: 0 };
const FAKE_DNS: ProvidersReport['cloudflare']['dnsRecords'] = { ok: true, fake: true, latencyMs: 0, count: 0, quota: null, zonePlan: 'FAKE' };

export async function collectProviders(env: Env): Promise<ProvidersReport> {
  const now = deps.now();
  const local = env.LOCAL_DEV === '1';
  const localCompute = local || env.COMPUTE_PROVIDER === 'fake';
  const fakeEdge = local || env.EDGE_PROVIDER === 'fake';
  const [compute, tunnels, dnsRecords] = await Promise.all([
    localCompute ? fakeCompute(env) : computeProbe(env),
    fakeEdge ? FAKE_TUNNELS : tunnelsProbe(env),
    fakeEdge ? FAKE_DNS : dnsProbe(env),
  ]);
  return {
    fake: localCompute && fakeEdge,
    checkedAt: now,
    compute,
    cloudflare: { tunnels, dnsRecords },
    turnstile: { configured: Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY) },
  };
}

/** Cached for 10 minutes (1 minute when a call failed). `cached` tells the UI which it got. */
export async function providersReport(env: Env): Promise<ProvidersReport & { cached: boolean }> {
  const hit = await env.KV.get<ProvidersReport>(PROVIDERS_CACHE_KEY, 'json');
  if (hit) return { ...hit, cached: true };
  const report = await collectProviders(env);
  const allOk = report.compute.ok && report.cloudflare.tunnels.ok && report.cloudflare.dnsRecords.ok;
  await env.KV.put(PROVIDERS_CACHE_KEY, JSON.stringify(report), { expirationTtl: allOk ? PROVIDERS_CACHE_TTL_S : PROVIDERS_ERROR_TTL_S });
  return { ...report, cached: false };
}
