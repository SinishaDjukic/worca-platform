// Heartbeats from instances (D28, D56): authenticated by the instance's own credential (during a
// rotation also the one before it, D74), stored as the latest beat, forwarded to the gate object,
// and the moment an operation completes.
import { Hono } from 'hono';
import { z } from 'zod';
import type { HeartbeatBody, InstanceStatus } from '../../shared/contracts';
import type { AppContext, Env } from '../env';
import { gate } from '../gate-client';
import { sha256Hex } from '../keys-api';
import type { InstanceRow } from './api';

export const HeartbeatSchema = z.object({
  health: z.enum(['ok', 'degraded']),
  version: z.string().min(1).max(64),
  pipelines: z
    .record(z.string().min(1).max(32), z.number().int().min(0))
    .refine((o) => Object.keys(o).length <= 20, 'too many pipeline statuses'),
  nextScheduledAt: z.number().int().nonnegative().nullable(),
  suspendable: z.boolean(),
}) satisfies z.ZodType<HeartbeatBody>;

type BeatRow = Pick<InstanceRow, 'id' | 'status' | 'pending_op' | 'target_version'>;

/**
 * The status a beat moves the instance to. `creating` → running on the first beat (the create
 * Workflow waits for it); a wake or lift completes on the first beat; an upgrade only once the new
 * version reports. A late beat from an instance being suspended changes nothing.
 */
export function nextStatus(row: BeatRow, beat: HeartbeatBody): InstanceStatus {
  if (row.status === 'creating') return 'running';
  if (row.status === 'suspended' && row.pending_op === 'wake') return 'running';
  if (row.status === 'stopped' && row.pending_op === 'lift') return 'running';
  if (row.status === 'upgrading' && row.target_version === beat.version) return 'running';
  return row.status;
}

/** Stopped (unless being lifted) and deleting instances are ignored: they must not come back. */
export function ignoresBeats(row: BeatRow): boolean {
  return row.status === 'deleting' || (row.status === 'stopped' && row.pending_op !== 'lift');
}

export async function recordHeartbeat(
  env: Env,
  row: BeatRow,
  beat: HeartbeatBody,
  now = Date.now(),
): Promise<{ ignored: boolean; status: InstanceStatus; transitioned: boolean }> {
  if (ignoresBeats(row)) return { ignored: true, status: row.status, transitioned: false };
  const to = nextStatus(row, beat);
  const moving = to !== row.status;
  const upsert = env.DB.prepare(
    `INSERT INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (instance_id) DO UPDATE SET received_at = ?2, health = ?3, worca_version = ?4, pipelines = ?5,
       next_scheduled_at = ?6, suspendable = ?7`,
  ).bind(row.id, now, beat.health, beat.version, JSON.stringify(beat.pipelines), beat.nextScheduledAt, beat.suspendable ? 1 : 0);
  // Guarded on the status we read, so a concurrent change (stop, delete) wins over the beat.
  // SQLite evaluates SET against the old row: health_since moves only when health changes (T5).
  const update = moving
    ? env.DB.prepare(
        `UPDATE instances SET worca_version = ?, health = ?, last_heartbeat_at = ?, updated_at = ?, status = ?,
           health_since = CASE WHEN health IS ? THEN health_since ELSE ? END,
           pending_op = NULL, target_version = NULL, last_error = NULL,
           stopped_reason = CASE WHEN status = 'stopped' THEN NULL ELSE stopped_reason END,
           stopped_by = CASE WHEN status = 'stopped' THEN NULL ELSE stopped_by END
         WHERE id = ? AND status = ?`,
      ).bind(beat.version, beat.health, now, now, to, beat.health, now, row.id, row.status)
    : env.DB.prepare(
        `UPDATE instances SET worca_version = ?, health = ?, last_heartbeat_at = ?, updated_at = ?,
           health_since = CASE WHEN health IS ? THEN health_since ELSE ? END
         WHERE id = ? AND status = ?`,
      ).bind(beat.version, beat.health, now, now, beat.health, now, row.id, row.status);
  const [, res] = await env.DB.batch([upsert, update]);
  const transitioned = moving && !!res?.meta.changes;
  if (transitioned) await gate(env).setStatus(row.id, to);
  // A running instance's beat repairs a gate object still showing `creating` (the create
  // Workflow registered the hosts as the first beat arrived). Only that move: a stop,
  // suspension or deletion racing this beat must never be overridden back to running.
  else if (row.status === 'running') await gate(env).setStatus(row.id, 'running', ['creating']);
  await gate(env).heartbeat(row.id, { suspendable: beat.suspendable, nextScheduledAt: beat.nextScheduledAt });
  return { ignored: false, status: transitioned ? to : row.status, transitioned };
}

export const heartbeatApp = new Hono<AppContext>();

heartbeatApp.post('/', async (c) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  // During a rotation (D74) the credential from before is accepted too, until the instance's first
  // beat with the new one retires it (its services restart in between), and never after
  // heartbeat_cred_prev_until: a failed rotation must not leave a possibly leaked credential working.
  const hash = await sha256Hex(m[1]!);
  const row = await c.env.DB.prepare(
    `SELECT id, status, pending_op, target_version, heartbeat_cred_hash = ?1 AS is_current, heartbeat_cred_hash_prev IS NOT NULL AS has_prev
       FROM instances WHERE heartbeat_cred_hash = ?1 OR (heartbeat_cred_hash_prev = ?1 AND heartbeat_cred_prev_until > ?2)`,
  )
    .bind(hash, Date.now())
    .first<BeatRow & { is_current: number; has_prev: number }>();
  if (!row) return c.json({ error: 'unauthorized' }, 401);
  const parsed = HeartbeatSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  if (row.is_current && row.has_prev) {
    await c.env.DB.prepare(`UPDATE instances SET heartbeat_cred_hash_prev = NULL, heartbeat_cred_prev_until = NULL WHERE id = ? AND heartbeat_cred_hash = ?`)
      .bind(row.id, hash)
      .run();
  }
  const result = await recordHeartbeat(c.env, row, parsed.data);
  return c.json({ ok: true, ...result });
});
