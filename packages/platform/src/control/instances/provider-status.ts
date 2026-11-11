// P1, P6: read-only provider health, polled by the 5-minute cron and cached in KV, so a console
// view never calls the compute provider (Railway: 1,000 requests an hour on Hobby) or Cloudflare itself. One compute
// query and one Cloudflare tunnel list per tick, whatever the number of instances.
import type { Env } from '../env';
import { providersFor, type Providers } from '../providers';
import type { ComputeRef, ProjectStatus, TunnelStatus } from '../providers/types';
import { parseComputeRef, parseEdgeRef } from './api';

export const PROVIDER_STATUS_KEY = 'provider-status:v1';
/** Kept a while past the next ticks, so a few failed polls still show the last known state. */
const CACHE_TTL_S = 60 * 60;

export interface ProviderStatusCache {
  checkedAt: number; // unix ms of the last poll
  tunnels: Record<string, TunnelStatus>; // by tunnel id
  tunnelsAt: number | null; // when tunnels last succeeded
  projects: Record<string, ProjectStatus>; // by the compute provider's project id
  projectsAt: number | null;
  errors: { compute?: string; edge?: string };
}

export async function readProviderStatus(env: Env): Promise<ProviderStatusCache | null> {
  return env.KV.get<ProviderStatusCache>(PROVIDER_STATUS_KEY, 'json');
}

/** Polls both providers once and caches the result; a failing provider keeps its last answer. */
export async function refreshProviderStatus(env: Env, given?: Providers, now = Date.now()): Promise<ProviderStatusCache> {
  const { results } = await env.DB.prepare(
    `SELECT compute_ref, edge_ref FROM instances WHERE status <> 'deleting' AND (compute_ref IS NOT NULL OR edge_ref IS NOT NULL)`,
  ).all<{ compute_ref: string | null; edge_ref: string | null }>();
  const refs = results.map(parseComputeRef).filter((r): r is ComputeRef => !!r);
  const tunnelIds = results.map((r) => parseEdgeRef(r)?.tunnelId).filter((t): t is string => !!t);

  const providers = given ?? (await providersFor(env));
  const prev = await readProviderStatus(env).catch(() => null);
  const next: ProviderStatusCache = {
    checkedAt: now,
    tunnels: prev?.tunnels ?? {},
    tunnelsAt: prev?.tunnelsAt ?? null,
    projects: prev?.projects ?? {},
    projectsAt: prev?.projectsAt ?? null,
    errors: {},
  };
  if (refs.length) {
    try {
      next.projects = await providers.compute.deploymentStatuses(refs);
      next.projectsAt = now;
    } catch (err) {
      next.errors.compute = String((err as Error).message).slice(0, 300);
    }
  } else {
    next.projects = {};
    next.projectsAt = now;
  }
  if (tunnelIds.length) {
    try {
      next.tunnels = await providers.edge.tunnelStatuses(tunnelIds);
      next.tunnelsAt = now;
    } catch (err) {
      next.errors.edge = String((err as Error).message).slice(0, 300);
    }
  } else {
    next.tunnels = {};
    next.tunnelsAt = now;
  }
  await env.KV.put(PROVIDER_STATUS_KEY, JSON.stringify(next), { expirationTtl: CACHE_TTL_S });
  return next;
}

export interface InstanceProviderStatus {
  checkedAt: number | null;
  /** Cloudflare tunnel status; null when unknown (not polled yet, no tunnel, or not found). */
  tunnel: TunnelStatus | null;
  tunnelCheckedAt: number | null;
  /** The compute provider's latest deployment status per service; null when unknown. */
  services: ProjectStatus | null;
  servicesCheckedAt: number | null;
  errors: { compute?: string; edge?: string };
}

/**
 * For the platform instance detail (P6): the cached provider status of one instance. Platform
 * staff only: provider error texts may carry provider ids. Null when the instance doesn't exist.
 */
export async function providerStatusFor(env: Env, instanceId: string): Promise<InstanceProviderStatus | null> {
  const row = await env.DB.prepare(`SELECT compute_ref, edge_ref FROM instances WHERE id = ?`)
    .bind(instanceId)
    .first<{ compute_ref: string | null; edge_ref: string | null }>();
  if (!row) return null;
  const cache = await readProviderStatus(env).catch(() => null);
  const projectId = parseComputeRef(row)?.projectId;
  const tunnelId = parseEdgeRef(row)?.tunnelId;
  return {
    checkedAt: cache?.checkedAt ?? null,
    tunnel: (tunnelId && cache?.tunnels[tunnelId]) || null,
    tunnelCheckedAt: cache?.tunnelsAt ?? null,
    services: (projectId && cache?.projects[projectId]) || null,
    servicesCheckedAt: cache?.projectsAt ?? null,
    errors: cache?.errors ?? {},
  };
}
