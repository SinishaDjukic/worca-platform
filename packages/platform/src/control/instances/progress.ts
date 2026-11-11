// Operation progress (ui-feasibility.md T8, P2, P6, G1): one instance_ops row per operation,
// written when it starts (startOp) and from inside every Workflow step. Steps map to a few
// user-facing phases; the tenant console sees kind and phase only, platform staff also the step,
// attempts and last error.
import type { Env } from '../env';
import type { InstanceOp, OpParams } from './api';
import { computeProviderNames } from '../providers';

export type OpStatus = 'running' | 'done' | 'failed';

/** The happy path of each kind, in order. Upgrade may also show 'rolling_back'. */
export const OP_PHASES: Record<InstanceOp, readonly string[]> = {
  create: ['reserving', 'compute', 'network', 'starting', 'waiting', 'ready'],
  upgrade: ['preparing', 'deploying', 'waiting', 'ready'],
  wake: ['starting', 'waiting', 'ready'],
  lift: ['starting', 'waiting', 'ready'],
  suspend: ['stopping', 'suspended'],
  stop: ['stopping', 'stopped'],
  delete: ['closing', 'compute', 'network', 'cleanup', 'deleted'],
  reconfigure: ['preparing', 'applying', 'restarting', 'ready'],
  rotate: ['preparing', 'renewing', 'restarting', 'waiting', 'ready'],
  refresh: ['preparing', 'deploying', 'waiting', 'ready'],
};

/** Step names of ops.ts → phase. Steps not listed (failure records) keep the current phase. */
const STEP_PHASES: Record<InstanceOp, Record<string, string>> = {
  create: {
    load: 'reserving',
    'create project': 'compute',
    'create tunnel': 'network',
    'add dns': 'network',
    'gate hosts': 'network',
    'set variables': 'starting',
    deploy: 'starting',
    'first heartbeat: check': 'waiting',
    'notify created': 'ready',
  },
  upgrade: {
    load: 'preparing',
    'set worca settings': 'deploying',
    'deploy new version': 'deploying',
    'new version: check': 'waiting',
    'mark applied': 'ready',
    'notify upgraded': 'ready',
    'roll back': 'rolling_back',
  },
  wake: {
    load: 'starting', 'set worca settings': 'starting', 'start services': 'starting', 'heartbeat: check': 'waiting', 'mark applied': 'ready',
    'new connector: check': 'ready', 'record images': 'ready',
  },
  lift: {
    load: 'starting', 'set worca settings': 'starting', 'start services': 'starting', 'heartbeat: check': 'waiting', 'mark applied': 'ready',
    'new connector: check': 'ready', 'record images': 'ready',
  },
  suspend: { load: 'stopping', 'stop services': 'stopping', 'mark suspended': 'suspended' },
  stop: { load: 'stopping', 'gate stopped': 'stopping', 'stop services': 'stopping' },
  delete: {
    load: 'closing',
    'gate deleting': 'closing',
    'destroy compute': 'compute',
    'delete edge': 'network',
    'revoke heartbeat credential': 'cleanup',
    'destroy gate object': 'cleanup',
    'delete rows': 'cleanup',
  },
  reconfigure: { load: 'preparing', 'set worca settings': 'applying', 'restart worca': 'restarting', 'confirm restart: check': 'restarting', 'mark applied': 'ready' },
  rotate: {
    load: 'preparing',
    'renew secrets': 'renewing',
    'restart services': 'restarting',
    'new credential: check': 'waiting',
    'tunnel: check': 'waiting',
    finish: 'ready',
  },
  refresh: { load: 'preparing', 'deploy components': 'deploying', 'new connector: check': 'waiting', finish: 'ready' },
};

export function phaseForStep(kind: InstanceOp, step: string): string | null {
  // A step repeated in a later round of the same op ("restart worca (2)") keeps its phase.
  return STEP_PHASES[kind]?.[step.replace(/ \(\d+\)$/, '')] ?? null;
}

/** Outcomes where the operation stopped because the instance moved on, not because it failed. */
const SUPERSEDED = new Set(['aborted', 'gone', 'skipped', 'already_gone', 'stopped_meanwhile']);

const log = (at: string, err: unknown, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ at: `instances.progress.${at}`, message: String((err as Error)?.message ?? err), ...extra }));

/** Inserts the row before the Workflow exists, so its first step finds it. Never throws. */
export async function recordOpStart(env: Env, opId: string, params: OpParams, workflowId: string | null): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO instance_ops (op_id, instance_id, org_id, kind, workflow_id, phase, phase_started_at, started_at, updated_at, status)
       SELECT ?1, id, org_id, ?2, ?3, ?4, ?5, ?5, ?5, 'running' FROM instances WHERE id = ?6`,
    )
      .bind(opId, params.op, workflowId, OP_PHASES[params.op][0], now, params.instanceId)
      .run();
  } catch (err) {
    log('start', err, { opId });
  }
}

export async function setOpWorkflowId(env: Env, opId: string, workflowId: string): Promise<void> {
  await env.DB.prepare(`UPDATE instance_ops SET workflow_id = ?, updated_at = ? WHERE op_id = ?`).bind(workflowId, Date.now(), opId).run()
    .catch((err) => log('workflowId', err, { opId }));
}

export async function opIdForWorkflow(env: Env, workflowId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(`SELECT op_id FROM instance_ops WHERE workflow_id = ?`).bind(workflowId).first<{ op_id: string }>();
    return row?.op_id ?? null;
  } catch (err) {
    log('lookup', err, { workflowId });
    return null;
  }
}

/** A step starts (or is retried: the same step entered again before it finished). */
export async function enterStep(env: Env, opId: string, kind: InstanceOp, step: string): Promise<void> {
  const now = Date.now();
  const phase = phaseForStep(kind, step);
  try {
    await env.DB.prepare(
      `UPDATE instance_ops SET
         attempts = CASE WHEN step = ?1 AND step_running = 1 THEN attempts + 1 ELSE 1 END,
         phase_started_at = CASE WHEN ?2 IS NULL OR phase = ?2 THEN phase_started_at ELSE ?3 END,
         phase = COALESCE(?2, phase),
         step = ?1, step_running = 1, status = 'running', finished_at = NULL, updated_at = ?3
       WHERE op_id = ?4`,
    )
      .bind(step, phase, now, opId)
      .run();
  } catch (err) {
    log('enter', err, { opId, step });
  }
}

export async function leaveStep(env: Env, opId: string, error?: unknown): Promise<void> {
  try {
    if (error === undefined) {
      await env.DB.prepare(`UPDATE instance_ops SET step_running = 0, last_error = NULL, updated_at = ? WHERE op_id = ?`).bind(Date.now(), opId).run();
    } else {
      const message = String((error as Error)?.message ?? error).slice(0, 500);
      await env.DB.prepare(`UPDATE instance_ops SET last_error = ?, updated_at = ? WHERE op_id = ?`).bind(message, Date.now(), opId).run();
    }
  } catch (err) {
    log('leave', err, { opId });
  }
}

/** The operation ended: done (also when superseded) or failed. A successful op shows its last phase. */
export async function finishOp(
  env: Env,
  opId: string,
  kind: InstanceOp,
  result: { ok: boolean; outcome: string } | { error: unknown },
): Promise<void> {
  const now = Date.now();
  let status: OpStatus;
  let outcome: string;
  let error: string | null = null;
  if ('error' in result) {
    status = 'failed';
    outcome = 'error';
    error = String((result.error as Error)?.message ?? result.error).slice(0, 500);
  } else {
    outcome = result.outcome;
    status = result.ok || SUPERSEDED.has(outcome) ? 'done' : 'failed';
    if (status === 'failed') error = outcome;
  }
  const finalPhase = 'outcome' in result && result.ok ? OP_PHASES[kind].at(-1)! : null;
  try {
    await env.DB.prepare(
      `UPDATE instance_ops SET status = ?1, outcome = ?2, last_error = COALESCE(?3, last_error), finished_at = ?4, updated_at = ?4,
         step_running = 0,
         phase_started_at = CASE WHEN ?5 IS NULL OR phase = ?5 THEN phase_started_at ELSE ?4 END,
         phase = COALESCE(?5, phase)
       WHERE op_id = ?6`,
    )
      .bind(status, outcome, error, now, finalPhase, opId)
      .run();
  } catch (err) {
    log('finish', err, { opId });
  }
}

export interface OpRow {
  op_id: string;
  instance_id: string;
  org_id: string;
  kind: InstanceOp;
  workflow_id: string | null;
  phase: string;
  phase_started_at: number;
  step: string | null;
  step_running: number;
  attempts: number;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  status: OpStatus;
  outcome: string | null;
  last_error: string | null;
}

/**
 * Why a provider step failed, in a word tenants may see (D15: never the provider's own text, which
 * can name ids and accounts). The UI words each one (views/instances.mjs, PROBLEM_TEXT).
 */
export type ProblemCode = 'provider_limit' | 'provider_auth' | 'provider_unavailable' | 'provider_slow' | 'image_missing' | 'platform_error';

export function problemCode(raw: string | null | undefined): ProblemCode | null {
  if (!raw) return null;
  const s = String(raw);
  if (/not stopped yet|not stoppable|still (starting|deploying)/i.test(s)) return 'provider_slow';
  if (/limit for new accounts|creation limit|plan limit|quota|usage limit|resource limit|maximum number of/i.test(s)) return 'provider_limit';
  if (/manifest unknown|image .*not found|pull access denied|image_not_found|unknown_version/i.test(s)) return 'image_missing';
  if (/unauthori[sz]ed|authentication error|not authorized|permission|invalid (api )?token|forbidden/i.test(s)) return 'provider_auth';
  if (/\b5\d\d\b|timed? ?out|timeout|ECONN|ENOTFOUND|fetch failed|network|rate limit|\b429\b|unavailable|too many requests/i.test(s)) return 'provider_unavailable';
  return 'platform_error';
}

/**
 * Which provider a failure came from, when its message says so: a compute provider's errors name
 * it (docs/providers.md: "railway …", "fake compute: …"), the edge's say "cloudflare …".
 */
export function problemSource(raw: string | null | undefined): 'compute' | 'network' | null {
  if (!raw) return null;
  if (computeProviderNames().some((name) => new RegExp(`\\b${name}\\b`, 'i').test(raw))) return 'compute';
  if (/^cloudflare\b/i.test(raw) || /\bcloudflare\b|\btunnel\b|\bdns\b/i.test(raw)) return 'network';
  return null;
}

/**
 * An instance's last_error for tenants: the known codes as they are, a failed create as
 * `create_failed` with its reason.
 */
export function tenantError(raw: string | null | undefined): { error: string | null; errorReason: ProblemCode | null; errorSource: 'compute' | 'network' | null } {
  if (!raw) return { error: null, errorReason: null, errorSource: null };
  const m = /^create_failed:?\s*(.*)$/s.exec(raw);
  if (m) return { error: 'create_failed', errorReason: problemCode(m[1] || raw), errorSource: problemSource(m[1]) };
  return { error: /^[a-z_]+$/.test(raw) ? raw : 'operation_failed', errorReason: null, errorSource: null };
}

/** What tenants see: no ids, steps or provider errors; a failing step only as a ProblemCode. */
export function tenantOpView(row: OpRow) {
  const failing = row.status === 'running' && !!row.last_error;
  return {
    kind: row.kind,
    phase: row.phase,
    phases: OP_PHASES[row.kind] ?? [],
    startedAt: row.started_at,
    phaseStartedAt: row.phase_started_at,
    finishedAt: row.finished_at,
    status: row.status,
    // The current step keeps failing and is being retried (cleared when a step succeeds).
    problem: failing ? problemCode(row.last_error) : null,
    problemSource: failing ? problemSource(row.last_error) : null,
  };
}

/** Latest operation per instance. */
export async function latestOps(env: Env, instanceIds: string[]): Promise<Map<string, OpRow>> {
  const out = new Map<string, OpRow>();
  if (!instanceIds.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT o.* FROM instance_ops o
      WHERE o.instance_id IN (${instanceIds.map(() => '?').join(',')})
        AND o.started_at = (SELECT MAX(x.started_at) FROM instance_ops x WHERE x.instance_id = o.instance_id)`,
  )
    .bind(...instanceIds)
    .all<OpRow>();
  for (const r of results) out.set(r.instance_id, r);
  return out;
}

/** G1: the wake sub-state for the gate's starting page; null when no wake is under way. */
export async function wakePhase(env: Env, instanceId: string): Promise<'starting' | 'waiting' | null> {
  const row = await env.DB.prepare(
    `SELECT phase FROM instance_ops WHERE instance_id = ? AND kind IN ('wake', 'lift') AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(instanceId)
    .first<{ phase: string }>();
  if (row?.phase === 'starting' || row?.phase === 'waiting') return row.phase;
  return null;
}

export const OPS_KEEP_MS = 30 * 86_400_000;

export async function pruneOps(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare(`DELETE FROM instance_ops WHERE finished_at IS NOT NULL AND finished_at < ?`).bind(now - OPS_KEEP_MS).run();
  return res.meta.changes ?? 0;
}
