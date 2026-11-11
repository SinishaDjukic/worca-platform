// Retention of rows nothing else cleans up (daily cron, instances/crons.ts). Each kind is deleted
// in bounded batches, so one run stays well inside a Worker's limits; a backlog drains over
// several days. The periods are listed in docs/security.md ("Retention of sign-in, invitation
// and mail records").
//
//   session          7 days after it expired (Better Auth never deletes expired sessions; they
//                    hold the encrypted IP address and user agent)
//   verification     1 day after it expired (sign-in codes and other one-time values)
//   invitation       30 days after its expiry date, whatever its status (pending, accepted,
//                    rejected, canceled); the table has no "decided at", and expiry is at most
//                    7 days after the invitation was sent
//   support_requests 30 days after the request ended: an open one 30 days after it expired
//                    unapproved, an approved or executed one 30 days after that
//   mail_messages    30 days after its final delivery event (delivered, bounced, complained,
//                    failed, suppressed, send_failed). A mail with no final event (accepted, sent,
//                    delivery_delayed) is still in flight and kept, until 180 days after it was
//                    sent, long after Resend has stopped trying. A mail of an invitation that
//                    still exists is kept with it, so the invitation list keeps its delivery status.
import type { Env } from '../env';

const DAY = 86_400_000;
export const SESSION_GRACE_MS = 7 * DAY;
export const VERIFICATION_GRACE_MS = DAY;
export const INVITATION_RETENTION_MS = 30 * DAY;
export const SUPPORT_REQUEST_RETENTION_MS = 30 * DAY;
export const MAIL_RETENTION_MS = 30 * DAY;
export const MAIL_IN_FLIGHT_MAX_MS = 180 * DAY;

/** Rows per DELETE, and DELETEs per kind per run: at most 10,000 rows of each kind a day. */
export const BATCH = 500;
export const MAX_BATCHES = 20;

const FINAL_MAIL_EVENTS = ['delivered', 'bounced', 'complained', 'failed', 'suppressed', 'send_failed'];

/**
 * Deletes rows of `table` matching `where`, BATCH at a time, until fewer than BATCH match or
 * MAX_BATCHES ran. `table` and `where` are constants of this module, never input.
 */
async function deleteBatched(env: Env, table: string, where: string, binds: unknown[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`)
      .bind(...binds)
      .run();
    const n = res.meta.changes ?? 0;
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

// Better Auth stores its dates as ISO strings (supportsDates is false for SQLite), which compare
// in time order as text.
const iso = (ms: number) => new Date(ms).toISOString();

export async function pruneSessions(env: Env, now = Date.now()): Promise<number> {
  return deleteBatched(env, '"session"', '"expiresAt" < ?1', [iso(now - SESSION_GRACE_MS)]);
}

export async function pruneVerifications(env: Env, now = Date.now()): Promise<number> {
  return deleteBatched(env, '"verification"', '"expiresAt" < ?1', [iso(now - VERIFICATION_GRACE_MS)]);
}

export async function pruneInvitations(env: Env, now = Date.now()): Promise<number> {
  return deleteBatched(env, '"invitation"', '"expiresAt" < ?1', [iso(now - INVITATION_RETENTION_MS)]);
}

export async function pruneSupportRequests(env: Env, now = Date.now()): Promise<number> {
  return deleteBatched(
    env,
    'support_requests',
    `(status = 'open' AND expires_at < ?1) OR (status IN ('approved', 'executed') AND COALESCE(executed_at, approved_at, expires_at) < ?1)`,
    [now - SUPPORT_REQUEST_RETENTION_MS],
  );
}

export async function pruneMailMessages(env: Env, now = Date.now()): Promise<number> {
  const final = FINAL_MAIL_EVENTS.map((e) => `'${e}'`).join(', ');
  // sent_at <= last_event_at, so the sent_at bound only narrows the scan (mail_messages_sent_at).
  return deleteBatched(
    env,
    'mail_messages',
    `sent_at < ?1
     AND ((last_event IN (${final}) AND COALESCE(last_event_at, sent_at) < ?1) OR sent_at < ?2)
     AND NOT (ref LIKE 'invitation:%' AND EXISTS (SELECT 1 FROM "invitation" WHERE "invitation"."id" = substr(mail_messages.ref, 12)))`,
    [now - MAIL_RETENTION_MS, now - MAIL_IN_FLIGHT_MAX_MS],
  );
}
