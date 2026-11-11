// The gate object: one Durable Object per instance (D43). Source of truth for the instance's
// status as the gate sees it, its live gate sessions, its last visit, waking, and the alarm that
// suspends it when idle (D27) or wakes it before a scheduled run (D56).
import { DurableObject } from 'cloudflare:workers';
import type { GateState, InstanceStatus, SessionFilter } from '../shared/contracts';
import { alarmSettings } from './config';
import { randomId } from './cookie';
import type { Env } from './env';

/** Visits are kept in memory and written at most this often. */
const VISIT_PERSIST_MS = 60_000;
/** A wake that hasn't set the status back to running by then may be started again. */
const WAKE_TIMEOUT_MS = 10 * 60_000;
/** Retry delay when a call to the control plane from the alarm fails. */
const ALARM_RETRY_MS = 60_000;

export type GateStatus = InstanceStatus | 'unknown';

export interface CheckResult {
  ok: boolean; // session exists and the instance is running
  status: GateStatus;
  session: { userId: string; cpSessionId: string } | null;
}

interface Meta {
  instanceId: string | null;
  status: GateStatus;
  statusAt: number | null; // unix ms
  lastVisit: number | null; // unix ms (persisted copy may lag by a minute)
  suspendable: boolean | null;
  nextScheduledAt: number | null; // unix seconds
  wakingSince: number | null; // unix ms
  recheckAt: number | null; // unix ms: not before this, after a declined or requested suspend
}

const EMPTY: Meta = {
  instanceId: null, status: 'unknown', statusAt: null, lastVisit: null, suspendable: null,
  nextScheduledAt: null, wakingSince: null, recheckAt: null,
};

export class GateObject extends DurableObject<Env> {
  private meta: Meta = { ...EMPTY };
  private persistedVisit: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private load(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      cp_session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS sessions_cp ON sessions (cp_session_id)`);
    const meta: Meta = { ...EMPTY };
    for (const row of this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta`)) {
      if (row.key in meta) (meta as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
    this.meta = meta;
    this.persistedVisit = meta.lastVisit;
  }

  private save(patch: Partial<Meta>): void {
    Object.assign(this.meta, patch);
    for (const [key, value] of Object.entries(patch)) {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, JSON.stringify(value));
    }
  }

  private remember(instanceId: string): void {
    if (this.meta.instanceId !== instanceId) this.save({ instanceId });
  }

  // ---- sessions -------------------------------------------------------------------------

  /** A new gate session after a successful code exchange; also counts as a visit. */
  async createSession(instanceId: string, userId: string, cpSessionId: string): Promise<{ sid: string; status: GateStatus }> {
    this.remember(instanceId);
    const sid = randomId();
    this.sql.exec(`INSERT INTO sessions (sid, user_id, cp_session_id, created_at) VALUES (?, ?, ?, ?)`,
      sid, userId, cpSessionId, Date.now());
    await this.recordVisit();
    return { sid, status: this.meta.status };
  }

  /** Asked when a pass runs out, on unsafe methods and WebSocket upgrades (D44). */
  async check(sid: string): Promise<CheckResult> {
    const row = this.sql
      .exec<{ user_id: string; cp_session_id: string }>(`SELECT user_id, cp_session_id FROM sessions WHERE sid = ?`, sid)
      .toArray()[0];
    const status = this.meta.status;
    if (!row) return { ok: false, status, session: null };
    await this.recordVisit();
    return { ok: status === 'running', status, session: { userId: row.user_id, cpSessionId: row.cp_session_id } };
  }

  async dropSession(sid: string): Promise<number> {
    return this.sql.exec(`DELETE FROM sessions WHERE sid = ?`, sid).rowsWritten;
  }

  /** D46: revocation. Unsafe requests are refused at once, reads when their pass runs out. */
  async dropSessions(filter: SessionFilter): Promise<number> {
    if ('all' in filter) return this.sql.exec(`DELETE FROM sessions`).rowsWritten;
    if ('userId' in filter) return this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, filter.userId).rowsWritten;
    return this.sql.exec(`DELETE FROM sessions WHERE cp_session_id = ?`, filter.cpSessionId).rowsWritten;
  }

  private async recordVisit(): Promise<void> {
    const now = Date.now();
    this.meta.lastVisit = now;
    if (this.persistedVisit === null || now - this.persistedVisit >= VISIT_PERSIST_MS) {
      this.save({ lastVisit: now });
      this.persistedVisit = now;
      await this.planAlarm();
    }
  }

  // ---- status, heartbeat, wake -------------------------------------------------------------

  async setStatus(instanceId: string, status: InstanceStatus, onlyFrom?: InstanceStatus[]): Promise<void> {
    this.remember(instanceId);
    if (onlyFrom && !onlyFrom.includes(this.meta.status as InstanceStatus)) return;
    // The control plane re-asserts the status on every heartbeat; only a change restarts the
    // idle clock (statusAt) and the recheck, or nothing would ever go idle.
    if (this.meta.status === status) return;
    const patch: Partial<Meta> = { status, statusAt: Date.now(), recheckAt: null };
    if (status !== 'suspended') patch.wakingSince = null;
    this.save(patch);
    await this.planAlarm();
  }

  async heartbeat(instanceId: string, beat: { suspendable: boolean; nextScheduledAt: number | null }): Promise<void> {
    this.remember(instanceId);
    const patch: Partial<Meta> = { suspendable: beat.suspendable, nextScheduledAt: beat.nextScheduledAt };
    if (this.meta.status === 'running') patch.wakingSince = null;
    this.save(patch);
    await this.planAlarm();
  }

  /** Starts one wake however many visitors wait (instance-lifecycle.md, Waking). */
  async startWake(instanceId: string, reason: 'visit' | 'schedule'): Promise<boolean> {
    this.remember(instanceId);
    if (this.meta.status !== 'suspended') return false;
    const now = Date.now();
    if (this.meta.wakingSince !== null && now - this.meta.wakingSince < WAKE_TIMEOUT_MS) return false;
    this.save({ wakingSince: now }); // set before the call so concurrent visits see it
    try {
      await this.env.CONTROL.requestWake(instanceId, reason);
      return true;
    } catch (err) {
      this.save({ wakingSince: null });
      throw err;
    }
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.load(); // recreate empty tables so a late call doesn't fail
  }

  async getState(): Promise<GateState> {
    const sessions = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n;
    const m = this.meta;
    return {
      instanceId: m.instanceId ?? '',
      status: m.status,
      sessions,
      lastVisit: m.lastVisit,
      suspendable: m.suspendable,
      nextScheduledAt: m.nextScheduledAt,
      waking: m.wakingSince !== null,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  // ---- alarms (D27, D56) --------------------------------------------------------------------

  /** When the instance counts as idle: a day after the last visit or the last status change. */
  private idleAt(): number {
    const base = Math.max(this.meta.lastVisit ?? 0, this.meta.statusAt ?? 0);
    return base + alarmSettings(this.env).idle * 1000;
  }

  private scheduleWakeAt(): number | null {
    if (this.meta.nextScheduledAt === null) return null;
    return (this.meta.nextScheduledAt - alarmSettings(this.env).wakeLead) * 1000;
  }

  private desiredAlarm(): number | null {
    const m = this.meta;
    if (m.status === 'running') return Math.max(this.idleAt(), m.recheckAt ?? 0);
    if (m.status === 'suspended' && m.wakingSince === null) return this.scheduleWakeAt();
    return null;
  }

  private async planAlarm(): Promise<void> {
    const want = this.desiredAlarm();
    const have = await this.ctx.storage.getAlarm();
    if (want === have) return;
    if (want === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(want);
  }

  async alarm(): Promise<void> {
    const instanceId = this.meta.instanceId;
    const now = Date.now();
    try {
      if (instanceId && this.meta.status === 'running' && now >= this.idleAt()) await this.idle(instanceId, now);
      const wakeAt = this.scheduleWakeAt();
      if (instanceId && this.meta.status === 'suspended' && wakeAt !== null && now >= wakeAt) {
        await this.startWake(instanceId, 'schedule');
      }
    } catch (err) {
      console.error('gate object alarm failed', err);
      await this.ctx.storage.setAlarm(now + ALARM_RETRY_MS);
      return;
    }
    await this.planAlarm();
  }

  /** Idle for a day: ask for suspension when the heartbeat allows it, else look again later. */
  private async idle(instanceId: string, now: number): Promise<void> {
    // Either way, don't ask again before the recheck time; setStatus('suspended') clears it.
    this.save({ recheckAt: now + alarmSettings(this.env).recheck * 1000 });
    if (this.meta.suspendable === true) await this.env.CONTROL.requestSuspend(instanceId);
  }
}
