// What the gate object asks for over ControlRpc (D27, D47, D56). Both are idempotent: the gate
// may ask again while an operation is already under way.
import type { Env } from '../env';
import { startOp } from './api';

/** Suspends only a running instance whose latest heartbeat says it may be suspended. */
export async function requestSuspend(env: Env, _ctx: ExecutionContext, instanceId: string): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE instances SET pending_op = 'suspend', updated_at = ?
      WHERE id = ? AND status = 'running' AND pending_op IS NULL
        AND EXISTS (SELECT 1 FROM heartbeats h WHERE h.instance_id = instances.id AND h.suspendable = 1)`,
  )
    .bind(Date.now(), instanceId)
    .run();
  if (!res.meta.changes) return;
  await startOrRelease(env, instanceId, 'suspend');
}

/** Wakes a suspended instance once, however many visits ask (stopped instances never wake, D47). */
export async function requestWake(env: Env, _ctx: ExecutionContext, instanceId: string, reason: 'visit' | 'schedule'): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE instances SET pending_op = 'wake', updated_at = ? WHERE id = ? AND status = 'suspended' AND pending_op IS NULL`,
  )
    .bind(Date.now(), instanceId)
    .run();
  if (!res.meta.changes) return;
  console.log(JSON.stringify({ at: 'instances.requestWake', instanceId, reason }));
  await startOrRelease(env, instanceId, 'wake');
}

/** If the Workflow can't be started, clear the claim so the next request can try again. */
async function startOrRelease(env: Env, instanceId: string, op: 'suspend' | 'wake'): Promise<void> {
  try {
    await startOp(env, { op, instanceId, actorId: null });
  } catch (err) {
    await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = ?`).bind(instanceId, op).run();
    throw err;
  }
}
