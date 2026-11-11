// P2, P6: operations for platform staff, mounted at /api/platform (index.ts). Ids, kinds, phases,
// attempts and errors only; never tenant names (D15).
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../env';
import { getPlatformRoles, requireCap, strongestRole } from '../tenancy/roles';
import { auditOrgSafe, auditPlatformSafe, restartWorkflow, rotateAll, rotateSecrets } from './api';
import { OP_PHASES, type OpRow } from './progress';

/** A running operation that has sat in one phase this long, or retried a step this often, is stuck. */
export const STUCK_AFTER_MS = 15 * 60_000; // the heartbeat waits alone may take 10 minutes
export const STUCK_ATTEMPTS = 3;

const StateSchema = z.enum(['stuck', 'failed', 'running']).default('stuck');

/** The staff view of one operation (GET /ops, and `op` in GET /instances/:id). */
export function platformOpView(r: OpRow, now: number) {
  return {
    opId: r.op_id,
    instanceId: r.instance_id,
    orgId: r.org_id,
    kind: r.kind,
    workflowId: r.workflow_id,
    status: r.status,
    phase: r.phase,
    phases: OP_PHASES[r.kind] ?? [],
    step: r.step,
    phaseStartedAt: r.phase_started_at,
    inPhaseMs: (r.finished_at ?? now) - r.phase_started_at,
    attempts: r.attempts,
    lastError: r.last_error,
    outcome: r.outcome,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    stuck: r.status === 'running' && (now - r.phase_started_at >= STUCK_AFTER_MS || r.attempts >= STUCK_ATTEMPTS),
  };
}

export const platformOpsApp = new Hono<AppContext>();

platformOpsApp.get('/ops', requireCap('platform.view'), async (c) => {
  const parsed = StateSchema.safeParse(c.req.query('state') ?? undefined);
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_state' });
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const now = Date.now();
  const stmt =
    parsed.data === 'stuck'
      ? c.env.DB.prepare(
          `SELECT * FROM instance_ops WHERE status = 'running' AND (phase_started_at <= ? OR attempts >= ?)
            ORDER BY phase_started_at LIMIT ?`,
        ).bind(now - STUCK_AFTER_MS, STUCK_ATTEMPTS, limit)
      : parsed.data === 'failed'
        ? c.env.DB.prepare(`SELECT * FROM instance_ops WHERE status = 'failed' ORDER BY finished_at DESC LIMIT ?`).bind(limit)
        : c.env.DB.prepare(`SELECT * FROM instance_ops WHERE status = 'running' ORDER BY started_at LIMIT ?`).bind(limit);
  const { results } = await stmt.all<OpRow>();
  return c.json({ state: parsed.data, ops: results.map((r) => platformOpView(r, now)) });
});

/**
 * "Restart operation" (P6): Workflows can't re-run one step; restart() runs the operation again
 * from the top and finished steps return their cached results, so only the failed or stuck step
 * and the ones after it run. The ops re-check the instance's status in every step.
 */
platformOpsApp.post('/ops/:opId/restart', requireCap('instances.stop'), async (c) => {
  const user = c.get('user')!;
  const op = await c.env.DB.prepare(`SELECT * FROM instance_ops WHERE op_id = ?`).bind(c.req.param('opId')).first<OpRow>();
  if (!op) throw new HTTPException(404, { message: 'not_found' });
  if (op.status === 'done') throw new HTTPException(409, { message: 'op_finished' });
  if (!op.workflow_id) throw new HTTPException(409, { message: 'no_workflow' });
  await restartWorkflow(c.env, op.workflow_id);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE instance_ops SET status = 'running', finished_at = NULL, outcome = NULL, step_running = 0, attempts = 0, updated_at = ? WHERE op_id = ?`,
  )
    .bind(now, op.op_id)
    .run();
  const role = strongestRole(await getPlatformRoles(c.env, user.id));
  const details = { opId: op.op_id, kind: op.kind, phase: op.phase, status: op.status };
  await auditPlatformSafe(c.env, {
    actorId: user.id, actorRole: role, action: 'instance.op_restarted', targetType: 'instance', targetId: op.instance_id,
    details: { ...details, orgId: op.org_id },
  });
  await auditOrgSafe(c.env, op.org_id, {
    actorId: user.id, actorScope: 'platform', action: 'instance.op_restarted', targetType: 'instance', targetId: op.instance_id, details,
  });
  return c.json({ ok: true, opId: op.op_id, status: 'running' }, 202);
});

// ---- renew credentials (D74) ----------------------------------------------------------------------

/** One instance: running ones restart, suspended and stopped ones get the new values for their next start. */
platformOpsApp.post('/instances/:id/rotate', requireCap('instances.rotate'), async (c) => {
  const user = c.get('user')!;
  const role = strongestRole(await getPlatformRoles(c.env, user.id));
  await rotateSecrets(c.env, c.req.param('id'), { actorId: user.id, actorRole: role });
  return c.json({ ok: true });
});

/** The phrase staff type to rotate every instance at once: it restarts every running one. */
export const ROTATE_ALL_CONFIRM = 'all instances';

platformOpsApp.post('/instances/rotate', requireCap('instances.rotate'), async (c) => {
  const user = c.get('user')!;
  const body = z.object({ confirm: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || body.data.confirm.trim().toLowerCase() !== ROTATE_ALL_CONFIRM) throw new HTTPException(400, { message: 'confirm_name_mismatch' });
  const role = strongestRole(await getPlatformRoles(c.env, user.id));
  const result = await rotateAll(c.env, { actorId: user.id, actorRole: role });
  return c.json(result);
});
