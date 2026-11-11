// Mail counting (P12, P13) and delivery status (S2). Our Resend key can only send, so the
// numbers here are our own: every send we make, per UTC day and kind, plus Resend's quota
// headers from the last send response and the last webhook event per referenced mail.
// No recipient addresses are stored.
import type { Env } from '../env';

// access_request: mail to someone who asked for access (confirm link, grant, decline);
// staff_digest: the superadmins' notice of new access requests (D69).
// newsletter: issues (NewsletterSendWorkflow); newsletter_confirm: opt-in and manage-link mails.
export const MAIL_KINDS = ['sign_in_code', 'invitation', 'confirmation', 'notification', 'passkey_notice', 'access_request', 'staff_digest', 'newsletter', 'newsletter_confirm'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** Resend free plan (resend.com/pricing); our sends are counted against these. */
export const RESEND_PLAN = { plan: 'free', daily: 100, monthly: 3000 } as const;

export const MAIL_QUOTA_KEY = 'mail:quota';
const HISTORY_DAYS = 14;

/** Reference under which an invitation's mail is recorded (see deliveryStatusFor). */
export const invitationMailRef = (invitationId: string) => `invitation:${invitationId}`;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Never lets bookkeeping break a send: the mail went out (or failed) either way. */
async function quietly(at: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (err) {
    console.error(JSON.stringify({ at, message: (err as Error).message }));
  }
}

export async function countMail(env: Env, kind: MailKind, now = Date.now()): Promise<void> {
  await quietly('mail_count_failed', () =>
    env.DB.prepare('INSERT INTO mail_daily (day, kind, count) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET count = count + 1')
      .bind(utcDay(now), kind)
      .run(),
  );
}

export interface QuotaSnapshot {
  daily: string | null;
  monthly: string | null;
  at: number;
}

/** Resend's documented quota headers (unverified on our account); stored only when present. */
export async function captureQuotaHeaders(env: Env, headers: Headers, now = Date.now()): Promise<void> {
  const daily = headers.get('x-resend-daily-quota');
  const monthly = headers.get('x-resend-monthly-quota');
  if (daily === null && monthly === null) return;
  const snap: QuotaSnapshot = { daily, monthly, at: now };
  await quietly('mail_quota_store_failed', () => env.KV.put(MAIL_QUOTA_KEY, JSON.stringify(snap)));
}

export async function recordSentMail(env: Env, input: { emailId: string; ref: string; kind: MailKind }, now = Date.now()): Promise<void> {
  await quietly('mail_record_failed', () =>
    env.DB.prepare('INSERT OR IGNORE INTO mail_messages (email_id, ref, kind, sent_at, last_event, last_event_at) VALUES (?, ?, ?, ?, NULL, NULL)')
      .bind(input.emailId, input.ref, input.kind, now)
      .run(),
  );
}

/** A send Resend refused: recorded under the ref so the UI can say so. */
export async function recordFailedSend(env: Env, input: { ref: string; kind: MailKind }, now = Date.now()): Promise<void> {
  await quietly('mail_record_failed', () =>
    env.DB.prepare("INSERT INTO mail_messages (email_id, ref, kind, sent_at, last_event, last_event_at) VALUES (?, ?, ?, ?, 'send_failed', ?)")
      .bind(`local-failed:${crypto.randomUUID()}`, input.ref, input.kind, now, now)
      .run(),
  );
}

// suppressed: Resend didn't send because the address is on its suppression list (an earlier bounce or complaint).
export const DELIVERY_EVENTS = ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed'] as const;
export type DeliveryEvent = (typeof DELIVERY_EVENTS)[number];

/** Applies a webhook event; older events than the stored one are ignored. Unknown ids too. */
export async function applyDeliveryEvent(env: Env, emailId: string, event: DeliveryEvent, at: number): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE mail_messages SET last_event = ?, last_event_at = ? WHERE email_id = ? AND (last_event_at IS NULL OR last_event_at <= ?)',
  )
    .bind(event, at, emailId, at)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface DeliveryStatus {
  emailId: string | null; // null when the send itself failed
  kind: MailKind;
  sentAt: number;
  /** Last webhook event; 'accepted' when Resend took the mail and no event has arrived yet. */
  status: DeliveryEvent | 'accepted' | 'send_failed';
  at: number; // time of that status
}

/** Delivery status of the newest mail sent under `ref` (e.g. invitationMailRef(id)), or null. */
export async function deliveryStatusFor(env: Env, ref: string): Promise<DeliveryStatus | null> {
  const row = await env.DB.prepare(
    'SELECT email_id, kind, sent_at, last_event, last_event_at FROM mail_messages WHERE ref = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1',
  )
    .bind(ref)
    .first<{ email_id: string; kind: MailKind; sent_at: number; last_event: DeliveryStatus['status'] | null; last_event_at: number | null }>();
  if (!row) return null;
  return {
    emailId: row.email_id.startsWith('local-failed:') ? null : row.email_id,
    kind: row.kind,
    sentAt: row.sent_at,
    status: row.last_event ?? 'accepted',
    at: row.last_event_at ?? row.sent_at,
  };
}

/** Mails counted today (UTC) and since the start of the UTC month, over every kind. */
export async function mailUsage(env: Env, now = Date.now()): Promise<{ today: number; monthToDate: number }> {
  const today = utcDay(now);
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(CASE WHEN day = ?1 THEN count ELSE 0 END), 0) AS today, COALESCE(SUM(count), 0) AS month FROM mail_daily WHERE day >= ?2 AND day <= ?1',
  )
    .bind(today, `${today.slice(0, 7)}-01`)
    .first<{ today: number; month: number }>();
  return { today: row?.today ?? 0, monthToDate: row?.month ?? 0 };
}

// ---- system page --------------------------------------------------------------------------------

export interface MailOverview {
  today: { day: string; total: number; byKind: Record<MailKind, number> };
  monthToDate: number;
  last14Days: { day: string; total: number }[];
  quotaHeaders: QuotaSnapshot | null;
  limits: typeof RESEND_PLAN;
}

export async function mailOverview(env: Env, now = Date.now()): Promise<MailOverview> {
  const today = utcDay(now);
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => utcDay(now - (HISTORY_DAYS - 1 - i) * 86_400_000));
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = days[0]! < monthStart ? days[0]! : monthStart;
  const rows = await env.DB.prepare('SELECT day, kind, count FROM mail_daily WHERE day >= ? AND day <= ?')
    .bind(from, today)
    .all<{ day: string; kind: string; count: number }>();

  const byKind = Object.fromEntries(MAIL_KINDS.map((k) => [k, 0])) as Record<MailKind, number>;
  const perDay = new Map<string, number>();
  let monthToDate = 0;
  for (const r of rows.results) {
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.count);
    if (r.day >= monthStart) monthToDate += r.count;
    if (r.day === today && (MAIL_KINDS as readonly string[]).includes(r.kind)) byKind[r.kind as MailKind] += r.count;
  }
  return {
    today: { day: today, total: perDay.get(today) ?? 0, byKind },
    monthToDate,
    last14Days: days.map((day) => ({ day, total: perDay.get(day) ?? 0 })),
    quotaHeaders: await env.KV.get<QuotaSnapshot>(MAIL_QUOTA_KEY, 'json'),
    limits: RESEND_PLAN,
  };
}
