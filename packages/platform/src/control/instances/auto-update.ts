// Automatic updates (D26 as amended, D75; docs/instance-lifecycle.md "Automatic updates"). The
// 5-minute cron installs the latest release on idle instances whose setting covers it: a newer micro
// of the running major.minor (1.9.1 → 1.9.2) with mode 'micro' or 'minor', a newer minor of the
// running major (1.9.4 → 1.10.1) only with 'minor' (auto_update_minor). Through the same start as the tenant
// admin's upgrade (api.ts startUpgrade), as the `system` actor. It also refreshes running instances
// whose cloudflared is older than the pinned image (D76, autoRefresh), whatever their setting.
import type { Env } from '../env';
import { gate } from '../gate-client';
import { AUTO_UPDATE_MODE_SQL, autoUpdateModesFor, startRefresh, startUpgrade, type AutoUpdateMode, type InstanceRow } from './api';
import { compareVersions, imageSources, isPublishedVersion, isSemver, needsRefresh, runsHosted } from './images';
import { autoUpdateTarget } from './releases';

export { isMicroUpdate, isMinorUpdate } from './images';

/** At most this many automatic upgrades start per tick. */
export const AUTO_UPDATE_PER_TICK = 2;
/** At most this many candidates have their gate state read per tick (one subrequest each). */
export const AUTO_UPDATE_CANDIDATES = 8;
/** The latest heartbeat must be this recent and say `suspendable`. */
export const AUTO_BEAT_FRESH_MS = 10 * 60_000;
/** No gate visit within this long before, and no scheduled run within this long after. */
export const AUTO_QUIET_MS = 30 * 60_000;

type Candidate = Pick<InstanceRow, 'id' | 'org_id' | 'worca_version' | 'auto_update_failed_version'> & { mode: AutoUpdateMode };

/**
 * auto_update_failed_version holds the version an automatic attempt rolled back from, or the one a
 * tenant admin downgraded away from: that version and anything not newer is skipped.
 */
export function skipped(skip: string | null, latest: string): boolean {
  return isSemver(skip) && compareVersions(latest, skip) <= 0;
}

/**
 * Running instances whose automatic updates cover `latest` (autoUpdateModesFor) and that could take it now: no pending operation,
 * no abuse stop, newer than the version a previous automatic attempt rolled back from or a tenant
 * admin downgraded away from (`skipped`), and a fresh
 * heartbeat that says nothing runs or is queued and no run is scheduled within 30 minutes. A
 * scheduled time already past counts as soon (a run due or overdue). Oldest-updated first.
 * Never an instance pinned to a release candidate (D80): only a tenant admin moves it, also once
 * its release is out.
 */
async function candidates(env: Env, latest: string, now: number): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.org_id, i.worca_version, ${AUTO_UPDATE_MODE_SQL} AS mode, i.auto_update_failed_version FROM instances i JOIN heartbeats h ON h.instance_id = i.id
      WHERE i.auto_update = 'micro' AND i.status = 'running' AND i.pending_op IS NULL AND i.stopped_reason IS NULL
        AND i.worca_version IS NOT NULL AND i.worca_version <> ?1 AND i.worca_version NOT LIKE '%-rc.%'
        AND h.received_at >= ?2 AND h.suspendable = 1
        AND (h.next_scheduled_at IS NULL OR h.next_scheduled_at * 1000 > ?3)
      ORDER BY i.updated_at LIMIT 50`,
  )
    .bind(latest, now - AUTO_BEAT_FRESH_MS, now + AUTO_QUIET_MS)
    .all<Candidate>();
  return results
    .filter((r) => autoUpdateModesFor(r.worca_version, latest).includes(r.mode) && !skipped(r.auto_update_failed_version, latest))
    .slice(0, AUTO_UPDATE_CANDIDATES);
}

/** Nobody used it in the last 30 minutes, per the gate object; false when the gate can't be read. */
async function quietAtGate(env: Env, id: string, now: number): Promise<boolean> {
  try {
    const state = await gate(env).getState(id);
    const last: unknown = state?.lastVisit;
    if (last !== null && typeof last !== 'number') throw new Error('no lastVisit');
    return last === null || last <= now - AUTO_QUIET_MS;
  } catch (err) {
    console.error(JSON.stringify({ at: 'instances.autoUpdate', id, message: `gate state unreadable: ${(err as Error).message}` }));
    return false;
  }
}

/**
 * One tick: starts at most AUTO_UPDATE_PER_TICK automatic upgrades to the newest release that has
 * settled (D77: enrolled at least the platform's soak time ago, never a withdrawn one; usually the
 * latest). Suspended instances are never woken for it: they are picked up once running and idle.
 * Returns the ids started.
 */
export async function autoUpdate(env: Env, now = Date.now()): Promise<string[]> {
  const latest = await autoUpdateTarget(env, now);
  if (!latest || !runsHosted(latest) || !(await isPublishedVersion(env, latest, null))) return [];
  const started: string[] = [];
  for (const row of await candidates(env, latest, now)) {
    if (started.length >= AUTO_UPDATE_PER_TICK) break;
    if (!(await quietAtGate(env, row.id, now))) continue;
    try {
      if (await startUpgrade(env, row, latest, { actorId: null, actorScope: 'system', automatic: true })) started.push(row.id);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.autoUpdate', id: row.id, message: (err as Error).message }));
    }
  }
  return started;
}

// ---- Component refresh (D76) ----

/** At most this many refreshes start per tick. */
export const AUTO_REFRESH_PER_TICK = 3;
/** An instance whose refresh failed is tried again only after this long. */
export const REFRESH_RETRY_MS = 6 * 60 * 60_000;

/**
 * One tick: starts at most AUTO_REFRESH_PER_TICK refreshes of running instances whose cloudflared is
 * older than the pinned image (images.ts needsRefresh). Not tied to the automatic-updates setting
 * and not waiting for idle: the connector belongs to the platform, often carries a security fix, and
 * restarting it interrupts no run. A suspended instance gets the new image when it wakes (ops.ts
 * startAndWait). Returns the ids started.
 */
export async function autoRefresh(env: Env, now = Date.now()): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.org_id, i.worca_version, i.deployed_images FROM instances i
      WHERE i.status = 'running' AND i.pending_op IS NULL AND i.stopped_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM instance_ops o WHERE o.instance_id = i.id AND o.kind = 'refresh' AND o.status = 'failed' AND o.updated_at >= ?1)
      ORDER BY i.updated_at LIMIT 200`,
  )
    .bind(now - REFRESH_RETRY_MS)
    .all<Pick<InstanceRow, 'id' | 'org_id' | 'worca_version' | 'deployed_images'>>();
  const started: string[] = [];
  const sources = imageSources(env);
  for (const row of results.filter((r) => needsRefresh(r, sources))) {
    if (started.length >= AUTO_REFRESH_PER_TICK) break;
    try {
      if (await startRefresh(env, row, { actorId: null, actorScope: 'system', automatic: true })) started.push(row.id);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.autoRefresh', id: row.id, message: (err as Error).message }));
    }
  }
  return started;
}
