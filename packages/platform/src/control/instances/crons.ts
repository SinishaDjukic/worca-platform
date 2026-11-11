// Cron Triggers (wrangler.control.jsonc): stale heartbeats every 5 minutes, housekeeping daily.
import type { Env } from '../env';
import { deps } from './deps';
import { checkNpmReleases, markAvailableVersion } from './releases';
import { pruneOps } from './progress';
import { refreshDueComputeFacts } from './compute-facts';
import { refreshProviderStatus } from './provider-status';
import { autoRefresh, autoUpdate } from './auto-update';
import { featureOn } from '../features';
import { pruneUnconfirmed, shredExpired } from '../newsletter/core';
import { pruneInvitations, pruneMailMessages, pruneSessions, pruneSupportRequests, pruneVerifications } from '../system/retention';

export const CRON_STALE = '*/5 * * * *';
export const CRON_DAILY = '17 3 * * *';
export const STALE_AFTER_MS = 5 * 60_000;
const CRON_RUNS_KEEP_MS = 40 * 86_400_000;

/** The slot a tick belongs to: its 5-minute window, or its UTC day for the daily cron. */
export function cronSlot(cron: string, scheduledTime: number): string {
  const iso = new Date(scheduledTime).toISOString();
  if (cron === CRON_DAILY) return iso.slice(0, 10);
  const d = new Date(Math.floor(scheduledTime / 300_000) * 300_000);
  return d.toISOString().slice(0, 16);
}

/** First delivery of (cron, slot) wins; Cloudflare may deliver a tick twice. */
export async function claimCronSlot(env: Env, cron: string, scheduledTime: number): Promise<boolean> {
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO cron_runs (cron, slot, at) VALUES (?, ?, ?)`)
    .bind(cron, cronSlot(cron, scheduledTime), Date.now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** A running instance with no heartbeat for 5 minutes shows as degraded; suspended/stopped never. */
export async function markStale(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE instances SET health = 'degraded', health_since = ?1, updated_at = ?1
      WHERE status = 'running' AND last_heartbeat_at < ?2 AND (health IS NULL OR health <> 'degraded')`,
  )
    .bind(now, now - STALE_AFTER_MS)
    .run();
  return res.meta.changes ?? 0;
}

// Moved to releases.ts (D77); re-exported for the callers that import it from here.
export { markAvailableVersion } from './releases';

async function runDaily(env: Env, now: number): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    ['pruneAudit', () => deps().pruneAudit(env)], // D57
    ['pruneGateCodes', () => deps().pruneGateCodes(env)],
    ['pruneCronRuns', () => env.DB.prepare(`DELETE FROM cron_runs WHERE at < ?`).bind(now - CRON_RUNS_KEEP_MS).run()],
    ['markAvailableVersion', () => markAvailableVersion(env)],
    ['pruneOps', () => pruneOps(env, now)],
    // Retention of the optional modules (2.4) runs whether the module is on or not: it only ever
    // deletes, so rows kept while a module was on still expire after it is turned off.
    ['pruneAccessRequests', async () => (await import('../public/access-requests')).pruneAccessRequests(env, now)], // D69, 180 days
    ['pruneNewsletter', () => pruneUnconfirmed(env, now)], // D70: unconfirmed after 30 days
    ['shredNewsletter', () => shredExpired(env, now)], // D70: unsubscribed/suppressed addresses after 30 days
    // system/retention.ts: rows nothing else deletes, in bounded batches.
    ['pruneSessions', () => pruneSessions(env, now)], // 7 days after expiry
    ['pruneVerifications', () => pruneVerifications(env, now)], // 1 day after expiry
    ['pruneInvitations', () => pruneInvitations(env, now)], // 30 days after expiry, any status
    ['pruneSupportRequests', () => pruneSupportRequests(env, now)], // 30 days after expiry or execution
    ['pruneMailMessages', () => pruneMailMessages(env, now)], // 30 days after the final event; in flight kept
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: name, message: (err as Error).message }));
    }
  }
}

let providerRefresher: ((env: Env) => Promise<unknown>) | null = null;
let releaseChecker: ((env: Env, now: number) => Promise<unknown>) | null = null;

/** Tests only: replace the npm release check of the 5-minute tick (no network in unit tests). */
export function setReleaseChecker(fn?: (env: Env, now: number) => Promise<unknown>): void {
  releaseChecker = fn ?? null;
}

/** Tests only: replace the provider poll of the 5-minute tick (no network in unit tests). */
export function setProviderRefresher(fn?: (env: Env) => Promise<unknown>): void {
  providerRefresher = fn ?? null;
}

export async function runCrons(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const { cron, scheduledTime } = controller;
  if (!(await claimCronSlot(env, cron, scheduledTime))) {
    console.log(JSON.stringify({ at: 'instances.cron', cron, message: 'duplicate delivery, skipped' }));
    return;
  }
  if (cron === CRON_STALE) {
    await markStale(env, scheduledTime);
    // P1: one compute provider query and one Cloudflare list per tick, cached in KV for the consoles.
    try {
      await (providerRefresher ?? refreshProviderStatus)(env);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: 'refreshProviderStatus', message: (err as Error).message }));
    }
    // Compute facts (compute-facts.ts): a few instances per tick, each re-read every 6 hours.
    try {
      await refreshDueComputeFacts(env, undefined, scheduledTime);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: 'refreshComputeFacts', message: (err as Error).message }));
    }
    // D77: enroll new stable npm releases whose image is on GHCR, before automatic updates look.
    try {
      await (releaseChecker ?? checkNpmReleases)(env, scheduledTime);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: 'checkNpmReleases', message: (err as Error).message }));
    }
    // D26 as amended, D75: at most 2 automatic upgrades of idle instances per tick (auto-update.ts).
    try {
      await autoUpdate(env, scheduledTime);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: 'autoUpdate', message: (err as Error).message }));
    }
    // D76: at most 3 refreshes of running instances with an out-of-date cloudflared per tick.
    try {
      await autoRefresh(env, scheduledTime);
    } catch (err) {
      console.error(JSON.stringify({ at: 'instances.cron', job: 'autoRefresh', message: (err as Error).message }));
    }
    // D69: the superadmins' hourly digest of new access requests (imported lazily: it pulls in
    // tenancy). Mail of the access-requests module, so only while it is on (2.4).
    if (featureOn(env, 'accessRequests')) {
      try {
        await (await import('../public/access-requests')).notifyStaff(env, scheduledTime);
      } catch (err) {
        console.error(JSON.stringify({ at: 'instances.cron', job: 'notifyStaff', message: (err as Error).message }));
      }
    }
  }
  else if (cron === CRON_DAILY) await runDaily(env, scheduledTime);
}
