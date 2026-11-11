// Compute sizes (D78): what an instance's worca service may use, and how much worca runs at once
// on it. The compute provider offers them (ComputeProviderInfo.sizes); a size is the worca service's
// vCPU and memory ceiling plus worca's parallelism (WORCA_MAX_PARALLEL, WORCA_MAX_PARALLEL_SCRIPTS).
// The broker and the tunnel keep the provider's own ceiling whatever the size.
//
// The sizes are fixed by the provider, not in the database: changing what "large" means would
// silently change running instances. A tier (tiers.sizes) lists the ones its orgs may pick.
import type { Env } from '../env';
import { computeInfo } from '../providers';
import type { ComputeProviderInfo, ComputeSize } from '../providers/types';

export type { ComputeSize };

/** The sizes one provider offers, and the lookups over them. */
export interface SizeTable {
  readonly all: readonly ComputeSize[];
  readonly defaultId: string;
  byId(id: string | null | undefined): ComputeSize | null;
  /** The size an instance row is on; rows from before D78 (or with a size the provider no longer offers) get the default. */
  of(row: { compute_size?: string | null }): ComputeSize;
  /** tiers.sizes (a JSON list of size ids) → the known ids in the provider's order; the default when unreadable or empty. */
  parseTier(raw: unknown): string[];
}

export function sizeTable(info: Pick<ComputeProviderInfo, 'sizes' | 'defaultSize'>): SizeTable {
  const all = info.sizes;
  const byId = (id: string | null | undefined) => all.find((s) => s.id === id) ?? null;
  const fallback = byId(info.defaultSize) ?? all[0];
  if (!fallback) throw new Error('the compute provider offers no sizes');
  return {
    all,
    defaultId: fallback.id,
    byId,
    of: (row) => byId(row.compute_size) ?? fallback,
    parseTier(raw) {
      let list: unknown = raw;
      if (typeof raw === 'string') {
        try {
          list = JSON.parse(raw);
        } catch {
          list = null;
        }
      }
      const ids = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
      const known = all.filter((s) => ids.has(s.id)).map((s) => s.id);
      return known.length ? known : [fallback.id];
    },
  };
}

/** The configured compute provider's sizes. */
export function computeSizes(env: Pick<Env, 'COMPUTE_PROVIDER'>): SizeTable {
  return sizeTable(computeInfo(env));
}

/** A size as the APIs show it. */
export function sizeView(s: ComputeSize) {
  return { id: s.id, name: s.name, vcpu: s.vcpu, memoryMb: s.memoryMb, maxParallel: s.maxParallel, maxParallelScripts: s.maxParallelScripts };
}
