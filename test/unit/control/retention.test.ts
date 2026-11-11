// Retention of sessions, verifications, invitations, support requests and mail records
// (system/retention.ts): each kind is deleted after its period and kept before it, mail still in
// flight is never deleted, the batches stop at their bound, and the daily cron runs them.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { CRON_DAILY, runCrons } from '../../../packages/platform/src/control/instances/crons';
import {
  BATCH,
  INVITATION_RETENTION_MS,
  MAIL_IN_FLIGHT_MAX_MS,
  MAIL_RETENTION_MS,
  MAX_BATCHES,
  pruneInvitations,
  pruneMailMessages,
  pruneSessions,
  pruneSupportRequests,
  pruneVerifications,
  SESSION_GRACE_MS,
  SUPPORT_REQUEST_RETENTION_MS,
  VERIFICATION_GRACE_MS,
} from '../../../packages/platform/src/control/system/retention';

const E = env as unknown as Env;
const ORIGIN = E.APP_ORIGIN;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 3, 17);
const iso = (ms: number) => new Date(ms).toISOString();
const uid = () => crypto.randomUUID();

const exists = async (table: string, id: string, column = 'id') =>
  (await E.DB.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).bind(id).first()) !== null;

let userId: string;
let orgId: string;

beforeEach(async () => {
  await E.DB.batch([
    E.DB.prepare('DELETE FROM "session"'),
    E.DB.prepare('DELETE FROM "verification"'),
    E.DB.prepare('DELETE FROM "invitation"'),
    E.DB.prepare('DELETE FROM support_requests'),
    E.DB.prepare('DELETE FROM mail_messages'),
  ]);
  userId = uid();
  orgId = uid();
  await E.DB.batch([
    E.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, status) VALUES (?, 'enc:n', 'enc:e', 1, ?, ?, 'active')`).bind(
      userId,
      iso(NOW),
      iso(NOW),
    ),
    E.DB.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, ?)`).bind(orgId, orgId, iso(NOW)),
  ]);
});

const session = (id: string, expiresAt: number) =>
  E.DB.prepare(`INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, 'enc:ip', 'enc:ua', ?)`).bind(
    id,
    iso(expiresAt),
    `tok-${id}`,
    iso(expiresAt - 7 * DAY),
    iso(expiresAt - 7 * DAY),
    userId,
  );
const verification = (id: string, expiresAt: number) =>
  E.DB.prepare(`INSERT INTO "verification" (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, 'idx', 'hash', ?, ?, ?)`).bind(
    id,
    iso(expiresAt),
    iso(expiresAt - 300_000),
    iso(expiresAt - 300_000),
  );
const invitation = (id: string, status: string, expiresAt: number) =>
  E.DB.prepare(`INSERT INTO "invitation" (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES (?, ?, 'enc:x', 'tenant_user', ?, ?, ?, ?)`).bind(
    id,
    orgId,
    status,
    iso(expiresAt),
    iso(expiresAt - 7 * DAY),
    userId,
  );
const supportRequest = (id: string, status: string, expiresAt: number, executedAt: number | null = null) =>
  E.DB.prepare(
    `INSERT INTO support_requests (id, kind, user_id, requested_by, reason, created_at, expires_at, approved_by, approved_at, executed_at, status)
     VALUES (?, 'signin_reset', ?, 'staff-a', 'enc:reason', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, expiresAt - DAY, expiresAt, executedAt ? 'staff-b' : null, executedAt, executedAt, status);
const mail = (id: string, ref: string, sentAt: number, lastEvent: string | null, lastEventAt: number | null = lastEvent ? sentAt + 60_000 : null) =>
  E.DB.prepare('INSERT INTO mail_messages (email_id, ref, kind, sent_at, last_event, last_event_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
    id,
    ref,
    ref.startsWith('invitation:') ? 'invitation' : 'notification',
    sentAt,
    lastEvent,
    lastEventAt,
  );

describe('sessions', () => {
  it('deletes a session 7 days after it expired, and keeps it before', async () => {
    await E.DB.batch([
      session('old', NOW - SESSION_GRACE_MS - 60_000),
      session('grace', NOW - SESSION_GRACE_MS + 60_000), // expired, still within the 7 days
      session('live', NOW + DAY),
    ]);
    expect(await pruneSessions(E, NOW)).toBe(1);
    expect(await exists('"session"', 'old')).toBe(false);
    expect(await exists('"session"', 'grace')).toBe(true);
    expect(await exists('"session"', 'live')).toBe(true);
  });

  it('works on the rows Better Auth writes itself (a real email-code sign-in)', async () => {
    await E.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'open', 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    const email = `retention-${Date.now()}@example.com`;
    const post = (path: string, body: unknown) =>
      SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
    const otp = /code: (\d{6})/.exec(mails.at(-1)!.subject)![1]!;
    // A second code request leaves a verification row behind that nobody consumes.
    expect((await post('/api/auth/email-otp/send-verification-otp', { email: `other-${email}`, type: 'sign-in' })).status).toBe(200);
    expect((await post('/api/auth/sign-in/email-otp', { email, otp })).status).toBe(200);

    const s = await E.DB.prepare('SELECT id, expiresAt FROM "session"').first<{ id: string; expiresAt: unknown }>();
    expect(typeof s?.expiresAt).toBe('string'); // ISO, as retention.ts compares it
    const sessionExpiry = Date.parse(String(s!.expiresAt));
    expect(await pruneSessions(E, sessionExpiry + SESSION_GRACE_MS - 60_000)).toBe(0);
    expect(await pruneSessions(E, sessionExpiry + SESSION_GRACE_MS + 60_000)).toBe(1);
    expect(await exists('"session"', s!.id)).toBe(false);

    const v = await E.DB.prepare('SELECT id, expiresAt FROM "verification"').all<{ id: string; expiresAt: unknown }>();
    expect(v.results.length).toBeGreaterThan(0);
    const latest = Math.max(...v.results.map((r) => Date.parse(String(r.expiresAt))));
    expect(await pruneVerifications(E, Date.now())).toBe(0);
    expect(await pruneVerifications(E, latest + VERIFICATION_GRACE_MS + 60_000)).toBe(v.results.length);
  });
});

describe('verifications', () => {
  it('deletes a verification 1 day after it expired, and keeps it before', async () => {
    await E.DB.batch([
      verification('old', NOW - VERIFICATION_GRACE_MS - 60_000),
      verification('grace', NOW - VERIFICATION_GRACE_MS + 60_000),
      verification('live', NOW + 300_000),
    ]);
    expect(await pruneVerifications(E, NOW)).toBe(1);
    expect(await exists('"verification"', 'old')).toBe(false);
    expect(await exists('"verification"', 'grace')).toBe(true);
    expect(await exists('"verification"', 'live')).toBe(true);
  });
});

describe('invitations', () => {
  it('deletes an invitation of any status 30 days after its expiry date, and keeps it before', async () => {
    const old = NOW - INVITATION_RETENTION_MS - 60_000;
    const recent = NOW - INVITATION_RETENTION_MS + 60_000;
    await E.DB.batch([
      invitation('pending-old', 'pending', old),
      invitation('accepted-old', 'accepted', old),
      invitation('rejected-old', 'rejected', old),
      invitation('canceled-old', 'canceled', old),
      invitation('pending-recent', 'pending', recent), // expired, still listed as expired
      invitation('accepted-recent', 'accepted', recent),
      invitation('pending-open', 'pending', NOW + 5 * DAY),
    ]);
    expect(await pruneInvitations(E, NOW)).toBe(4);
    for (const id of ['pending-old', 'accepted-old', 'rejected-old', 'canceled-old']) expect(await exists('"invitation"', id), id).toBe(false);
    for (const id of ['pending-recent', 'accepted-recent', 'pending-open']) expect(await exists('"invitation"', id), id).toBe(true);
  });
});

describe('sign-in reset requests', () => {
  it('deletes a request 30 days after it expired unapproved or was executed, and keeps it before', async () => {
    const old = NOW - SUPPORT_REQUEST_RETENTION_MS - 60_000;
    const recent = NOW - SUPPORT_REQUEST_RETENTION_MS + 60_000;
    await E.DB.batch([
      supportRequest('open-old', 'open', old),
      supportRequest('open-recent', 'open', recent),
      supportRequest('open-live', 'open', NOW + 3_600_000),
      // Executed long after it was made would be impossible (24 hours), but the anchor is executed_at.
      supportRequest('executed-old', 'executed', old - DAY, old),
      supportRequest('executed-recent', 'executed', old - DAY, recent),
      supportRequest('approved-old', 'approved', old - DAY, old), // approved, execution interrupted
    ]);
    expect(await pruneSupportRequests(E, NOW)).toBe(3);
    for (const id of ['open-old', 'executed-old', 'approved-old']) expect(await exists('support_requests', id), id).toBe(false);
    for (const id of ['open-recent', 'open-live', 'executed-recent']) expect(await exists('support_requests', id), id).toBe(true);
  });
});

describe('mail records', () => {
  it('deletes a mail 30 days after its final event, and keeps it before', async () => {
    const old = NOW - MAIL_RETENTION_MS - DAY;
    await E.DB.batch([
      mail('delivered-old', 'notification:a', old, 'delivered'),
      mail('bounced-old', 'newsletter:nl_x:i1', old, 'bounced'),
      mail('complained-old', 'newsletter:nl_y:i1', old, 'complained'),
      mail('failed-old', 'notification:b', old, 'failed'),
      mail('suppressed-old', 'notification:c', old, 'suppressed'),
      mail('local-failed:old', 'notification:d', old, 'send_failed', old),
      mail('delivered-recent', 'notification:e', NOW - DAY, 'delivered'),
      // Sent long ago, but the final event (a late complaint) came 10 days ago: kept 30 days from that.
      mail('complained-late', 'newsletter:nl_z:i1', old, 'complained', NOW - 10 * DAY),
    ]);
    expect(await pruneMailMessages(E, NOW)).toBe(6);
    for (const id of ['delivered-recent', 'complained-late']) expect(await exists('mail_messages', id, 'email_id'), id).toBe(true);
    expect((await E.DB.prepare('SELECT COUNT(*) AS n FROM mail_messages').first<{ n: number }>())!.n).toBe(2);
  });

  it('never deletes a mail still in flight (accepted, sent, delivery_delayed) before 180 days', async () => {
    const old = NOW - MAIL_RETENTION_MS - 60 * DAY; // 90 days ago
    await E.DB.batch([
      mail('accepted', 'notification:a', old, null),
      mail('sent', 'notification:b', old, 'sent'),
      mail('delayed', 'notification:c', old, 'delivery_delayed'),
      mail('accepted-now', 'notification:d', NOW - 60_000, null),
      mail('abandoned', 'notification:e', NOW - MAIL_IN_FLIGHT_MAX_MS - DAY, 'sent'),
    ]);
    expect(await pruneMailMessages(E, NOW)).toBe(1);
    expect(await exists('mail_messages', 'abandoned', 'email_id')).toBe(false);
    for (const id of ['accepted', 'sent', 'delayed', 'accepted-now']) expect(await exists('mail_messages', id, 'email_id'), id).toBe(true);
  });

  it('keeps the mail of an invitation that still exists, so its delivery status stays', async () => {
    const old = NOW - MAIL_RETENTION_MS - DAY;
    await E.DB.batch([
      invitation('inv-kept', 'pending', NOW - 5 * DAY), // expired, still listed
      mail('inv-kept-mail', 'invitation:inv-kept', old, 'delivered'),
      mail('inv-gone-mail', 'invitation:inv-gone', old, 'delivered'),
    ]);
    expect(await pruneMailMessages(E, NOW)).toBe(1);
    expect(await exists('mail_messages', 'inv-kept-mail', 'email_id')).toBe(true);
    expect(await exists('mail_messages', 'inv-gone-mail', 'email_id')).toBe(false);
  });
});

describe('bounded batches', () => {
  it('deletes at most BATCH x MAX_BATCHES rows of a kind per run; the rest goes on the next run', async () => {
    const total = BATCH * MAX_BATCHES + 7;
    const stmts = [];
    for (let i = 0; i < total; i++) stmts.push(verification(`v${i}`, NOW - 2 * DAY));
    for (let i = 0; i < stmts.length; i += 1000) await E.DB.batch(stmts.slice(i, i + 1000));
    expect(await pruneVerifications(E, NOW)).toBe(BATCH * MAX_BATCHES);
    expect(await pruneVerifications(E, NOW)).toBe(7);
  });
});

describe('daily cron', () => {
  it('runs every retention job', async () => {
    await E.DB.batch([
      session('s-old', NOW - SESSION_GRACE_MS - DAY),
      session('s-live', NOW + DAY),
      verification('v-old', NOW - 2 * DAY),
      invitation('i-old', 'canceled', NOW - INVITATION_RETENTION_MS - DAY),
      supportRequest('r-old', 'open', NOW - SUPPORT_REQUEST_RETENTION_MS - DAY),
      mail('m-old', 'notification:x', NOW - MAIL_RETENTION_MS - DAY, 'delivered'),
      mail('m-flight', 'notification:y', NOW - MAIL_RETENTION_MS - DAY, null),
    ]);
    await E.DB.prepare('DELETE FROM cron_runs').run();
    await runCrons({ cron: CRON_DAILY, scheduledTime: NOW, noRetry() {} } as ScheduledController, E, {} as ExecutionContext);
    expect(await exists('"session"', 's-old')).toBe(false);
    expect(await exists('"session"', 's-live')).toBe(true);
    expect(await exists('"verification"', 'v-old')).toBe(false);
    expect(await exists('"invitation"', 'i-old')).toBe(false);
    expect(await exists('support_requests', 'r-old')).toBe(false);
    expect(await exists('mail_messages', 'm-old', 'email_id')).toBe(false);
    expect(await exists('mail_messages', 'm-flight', 'email_id')).toBe(true);
  });
});
