// What an instance really runs on (region, each service's CPU and memory ceilings, volume sizes),
// read from the compute provider and kept on the instance row (0019_compute_facts.sql), so the
// consoles never call the provider. The tier's cpu/memory_mb/volume_gb stay what the instance was
// meant to get; these are what the provider reports. docs/instance-lifecycle.md "Compute facts".
//
// Refreshed after a create's first heartbeat and after an upgrade (ops.ts), and by the 5-minute
// cron for a few instances at a time that were not checked for FACTS_MAX_AGE_MS. Best effort
// everywhere: a failed read logs and keeps the previous facts.
import type { Env } from '../env';
import { providersFor, type Providers } from '../providers';
import type { ComputeFacts, ComputeProviderInfo, ComputeRegion } from '../providers/types';
import { computeRefOf, getInstance } from './api';

/** How old facts may get before the cron reads them again. */
export const FACTS_MAX_AGE_MS = 6 * 3_600_000;
/**
 * Instances read per 5-minute tick: one provider request each (48 an hour at most; Railway allows
 * 1,000 an hour on Hobby), few subrequests on top of the tick's other work.
 */
export const FACTS_PER_TICK = 4;

/** The provider's label for a region id it reported: an entry equal to it or a prefix of it (`europe-west4-drams3a`). */
export function regionOf(info: Pick<ComputeProviderInfo, 'regions'>, region: string | null | undefined): ComputeRegion | null {
  if (!region) return null;
  return info.regions.find((r) => region === r.id || region.startsWith(`${r.id}-`)) ?? null;
}

export function regionLabel(info: Pick<ComputeProviderInfo, 'regions'>, region: string | null | undefined): string | null {
  if (!region) return null;
  return regionOf(info, region)?.label ?? region;
}

/** D6: instances belong in the EU. False for a region the provider doesn't list. */
export const isEuRegion = (info: Pick<ComputeProviderInfo, 'regions'>, region: string | null | undefined): boolean => !!regionOf(info, region)?.eu;

export interface ComputeView extends ComputeFacts {
  regionLabel: string | null;
  /** Whether the region is in the EU; null when the region is unknown. */
  eu: boolean | null;
  checkedAt: number;
}

/** The API shape of the stored facts; null until the first successful read. */
export function computeView(info: Pick<ComputeProviderInfo, 'regions'>, row: { compute_facts: string | null; compute_facts_at: number | null }): ComputeView | null {
  if (!row.compute_facts || !row.compute_facts_at) return null;
  let facts: ComputeFacts;
  try {
    facts = JSON.parse(row.compute_facts) as ComputeFacts;
  } catch {
    return null;
  }
  return {
    region: facts.region ?? null,
    regionLabel: regionLabel(info, facts.region),
    eu: facts.region ? isEuRegion(info, facts.region) : null,
    services: facts.services,
    checkedAt: row.compute_facts_at,
  };
}

const log = (id: string, err: unknown) =>
  console.error(JSON.stringify({ at: 'instances.computeFacts', id, message: String((err as Error)?.message ?? err).slice(0, 300) }));

/** Reads one instance's facts and stores them. Never throws; false when nothing was stored. */
export async function refreshComputeFacts(env: Env, providers: Providers, id: string, now = Date.now()): Promise<boolean> {
  try {
    const row = await getInstance(env, id);
    const ref = row && row.status !== 'deleting' ? computeRefOf(env, row) : null;
    if (!ref) return false;
    const facts = await providers.compute.describe(ref);
    const res = await env.DB.prepare(`UPDATE instances SET compute_facts = ?, compute_facts_at = ? WHERE id = ? AND status <> 'deleting'`)
      .bind(JSON.stringify(facts), now, id)
      .run();
    return (res.meta.changes ?? 0) > 0;
  } catch (err) {
    log(id, err);
    return false;
  }
}

/**
 * The cron's pass: a few instances whose facts are missing or older than FACTS_MAX_AGE_MS, picked
 * at random so one that keeps failing (its project gone, say) never holds up the rest. Instances
 * still being created get theirs from the create op. Returns how many were stored.
 */
export async function refreshDueComputeFacts(env: Env, given?: Providers, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM instances
      WHERE compute_ref IS NOT NULL AND status NOT IN ('creating', 'deleting')
        AND (compute_facts_at IS NULL OR compute_facts_at < ?)
      ORDER BY RANDOM() LIMIT ?`,
  )
    .bind(now - FACTS_MAX_AGE_MS, FACTS_PER_TICK)
    .all<{ id: string }>();
  let stored = 0;
  if (!results.length) return 0;
  const providers = given ?? (await providersFor(env));
  for (const { id } of results) if (await refreshComputeFacts(env, providers, id, now)) stored++;
  return stored;
}
