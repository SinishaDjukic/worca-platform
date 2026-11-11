import { beforeEach, describe, expect, it } from 'vitest';
import { orgInvitationEmail, sendEmail, signInCodeEmail } from '../../../packages/platform/src/control/auth/email';
import { siteOf } from '../../../packages/platform/src/shared/site';
import { deliveryStatusFor, invitationMailRef, MAIL_QUOTA_KEY, utcDay } from '../../../packages/platform/src/control/system/mail';
import { envWith, staffUser, systemHarness, testEnv } from './helpers/system-harness';

const call = systemHarness();
const resendEnv = envWith({ RESEND_API_KEY: 're_test', LOCAL_DEV: undefined, EMAIL_FROM: 'worca <no-reply@worca.dev>' });

type Sent = { url: string; body: Record<string, unknown> };
function fakeResend(opts: { status?: number; id?: string; headers?: Record<string, string> } = {}) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(init.body as string) });
    const status = opts.status ?? 200;
    return new Response(JSON.stringify(status === 200 ? { id: opts.id ?? crypto.randomUUID() } : { message: 'nope' }), { status, headers: opts.headers });
  }) as unknown as typeof fetch;
  return { f, sent };
}

async function counts(): Promise<Record<string, number>> {
  const rows = await testEnv.DB.prepare('SELECT kind, count FROM mail_daily WHERE day = ?').bind(utcDay(Date.now())).all<{ kind: string; count: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.kind, r.count]));
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM mail_daily').run();
  await testEnv.DB.prepare('DELETE FROM mail_messages').run();
  await testEnv.KV.delete(MAIL_QUOTA_KEY);
});

describe('mail counting (P12, P13)', () => {
  it('counts each send per day and kind, tags from templates, infers the rest', async () => {
    const { f, sent } = fakeResend();
    await sendEmail(resendEnv, { to: 'a@example.com', ...signInCodeEmail('123456', siteOf(testEnv)) }, f);
    await sendEmail(resendEnv, { to: 'a@example.com', ...signInCodeEmail('654321', siteOf(testEnv)) }, f);
    await sendEmail(resendEnv, { to: 'b@example.com', subject: 'Confirm: delete org', text: 't', html: 'h' }, f);
    await sendEmail(resendEnv, { to: 'b@example.com', subject: 'Instance stopped', text: 't', html: 'h' }, f);
    expect(await counts()).toEqual({ sign_in_code: 2, confirmation: 1, notification: 1 });
    // Our bookkeeping fields never reach Resend.
    expect(Object.keys(sent[0]!.body).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    // No addresses stored.
    const tables = await testEnv.DB.prepare('SELECT * FROM mail_daily').all();
    expect(JSON.stringify(tables.results)).not.toContain('example.com');
  });

  it('counts captured mail in local dev', async () => {
    await sendEmail(envWith({ RESEND_API_KEY: undefined, LOCAL_DEV: '1' }), { to: 'dev@example.com', subject: 'Hello', text: 't', html: 'h', kind: 'passkey_notice' });
    expect(await counts()).toEqual({ passkey_notice: 1 });
  });

  it('stores the quota headers when present, and only then', async () => {
    await sendEmail(resendEnv, { to: 'a@example.com', subject: 's', text: 't', html: 'h' }, fakeResend().f);
    expect(await testEnv.KV.get(MAIL_QUOTA_KEY)).toBeNull();
    const { f } = fakeResend({ headers: { 'x-resend-daily-quota': '7', 'x-resend-monthly-quota': '42' } });
    await sendEmail(resendEnv, { to: 'a@example.com', subject: 's', text: 't', html: 'h' }, f);
    expect(await testEnv.KV.get(MAIL_QUOTA_KEY, 'json')).toMatchObject({ daily: '7', monthly: '42' });
  });

  it('a refused send is not counted; with a ref it is recorded as send_failed', async () => {
    const ref = invitationMailRef('inv-fail');
    await expect(sendEmail(resendEnv, { to: 'a@example.com', subject: 's', text: 't', html: 'h', ref }, fakeResend({ status: 422 }).f)).rejects.toThrow(/422/);
    expect(await counts()).toEqual({});
    expect(await deliveryStatusFor(testEnv, ref)).toMatchObject({ emailId: null, status: 'send_failed' });
  });

  it('invitation mails record their Resend id under invitation:<id>', async () => {
    const mail = orgInvitationEmail({ orgName: 'Acme', inviterName: 'Ann', invitationId: 'inv-1', site: siteOf(testEnv) });
    expect(mail).toMatchObject({ kind: 'invitation', ref: 'invitation:inv-1' });
    expect(await deliveryStatusFor(testEnv, 'invitation:inv-1')).toBeNull();
    await sendEmail(resendEnv, { to: 'c@example.com', ...mail }, fakeResend({ id: 're_abc' }).f);
    expect(await deliveryStatusFor(testEnv, 'invitation:inv-1')).toMatchObject({ emailId: 're_abc', kind: 'invitation', status: 'accepted' });
    const row = await testEnv.DB.prepare('SELECT * FROM mail_messages').first();
    expect(JSON.stringify(row)).not.toContain('example.com');
  });
});

describe('GET /api/platform/system/mail', () => {
  it('needs platform.view with MFA', async () => {
    expect((await call('/api/platform/system/mail')).status).toBe(401);
    expect((await call('/api/platform/system/mail', { user: await staffUser(null) })).status).toBe(403);
    expect((await call('/api/platform/system/mail', { user: await staffUser('support'), mfa: false })).status).toBe(403);
  });

  it('returns today by kind, 14 days of totals, month to date, quota headers and plan limits', async () => {
    const now = Date.now();
    const today = utcDay(now);
    const old = utcDay(now - 3 * 86_400_000);
    const tooOld = utcDay(now - 20 * 86_400_000);
    const seed = testEnv.DB.prepare('INSERT INTO mail_daily (day, kind, count) VALUES (?, ?, ?)');
    await testEnv.DB.batch([seed.bind(today, 'sign_in_code', 4), seed.bind(today, 'invitation', 1), seed.bind(old, 'notification', 5), seed.bind(tooOld, 'notification', 9)]);
    await testEnv.KV.put(MAIL_QUOTA_KEY, JSON.stringify({ daily: '5', monthly: null, at: now }));

    const res = await call('/api/platform/system/mail', { user: await staffUser('support') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: { day: string; total: number; byKind: Record<string, number> };
      monthToDate: number;
      last14Days: { day: string; total: number }[];
      quotaHeaders: unknown;
      limits: unknown;
    };
    expect(body.today).toEqual({ day: today, total: 5, byKind: { sign_in_code: 4, invitation: 1, confirmation: 0, notification: 0, passkey_notice: 0, access_request: 0, staff_digest: 0, newsletter: 0, newsletter_confirm: 0 } });
    expect(body.last14Days).toHaveLength(14);
    expect(body.last14Days.at(-1)).toEqual({ day: today, total: 5 });
    expect(body.last14Days.find((d) => d.day === old)?.total).toBe(5);
    expect(body.last14Days.some((d) => d.day === tooOld)).toBe(false);
    const expectedMonth = 5 + (old.slice(0, 7) === today.slice(0, 7) ? 5 : 0) + (tooOld.slice(0, 7) === today.slice(0, 7) ? 9 : 0);
    expect(body.monthToDate).toBe(expectedMonth);
    expect(body.quotaHeaders).toMatchObject({ daily: '5', monthly: null });
    expect(body.limits).toEqual({ plan: 'free', daily: 100, monthly: 3000 });
  });
});
