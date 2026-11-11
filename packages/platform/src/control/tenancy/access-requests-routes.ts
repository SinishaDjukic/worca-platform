// Access requests in the platform console (D69), mounted under /api/platform by platform-routes.ts.
// Superadmins only ('access_requests.manage'). They see confirmed requests with the address, use
// case and company, and grant (a single-use registration code tied to the address, mailed to it)
// or decline (an optional polite mail). Unconfirmed requests are only counted. Requests whose
// personal data retention removed (shredded_at) are listed under "all" with `removed: true`.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { accessDeclinedEmail, accessGrantedEmail } from '../public/access-request-mail';
import { accessRequestField, logSafe, type AccessRequestStatus } from '../public/access-requests';
import { auditPlatform, type PlatformActorRole } from './audit';
import { deps } from './deps';
import { assertTier, createRegistrationCode } from './registration-codes';
import { getPlatformRoles, requireCap, strongestRole } from './roles';
import { actor, fail, parseBody, tryDecrypt } from './util';
import { siteOf } from '../../shared/site';

export const accessRequestsApp = new Hono<AppContext>();

async function staff(c: Context<AppContext>): Promise<{ id: string; role: PlatformActorRole }> {
  const { user } = actor(c);
  return { id: user.id, role: strongestRole(await getPlatformRoles(c.env, user.id)) ?? 'user' };
}

interface Row {
  id: string;
  email: string | null;
  use_case: string | null;
  company: string | null;
  source: string | null;
  status: AccessRequestStatus;
  created_at: number;
  confirmed_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  registration_code_id: string | null;
  joined_at: number | null;
  shredded_at: number | null;
}

/** Every field of grant and decline is optional, so an empty body counts as {}. */
async function optionalBody<S extends z.ZodType>(c: Context<AppContext>, schema: S): Promise<z.infer<S>> {
  if (!(await c.req.raw.clone().text()).trim()) {
    const parsed = schema.safeParse({});
    if (parsed.success) return parsed.data;
  }
  return parseBody(c, schema);
}

const decrypt = (env: Env, r: Row, column: 'email' | 'use_case' | 'company', value: string | null) =>
  value ? tryDecrypt(env, accessRequestField(r.id, column), value) : Promise.resolve(null);

async function view(env: Env, r: Row) {
  return {
    id: r.id,
    email: await decrypt(env, r, 'email', r.email),
    useCase: await decrypt(env, r, 'use_case', r.use_case),
    company: await decrypt(env, r, 'company', r.company),
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    joinedAt: r.joined_at,
    removed: r.shredded_at !== null,
  };
}

/**
 * The funnel: every request made (as far as retention keeps them), confirmed by the requester,
 * granted, signed up, and signed up people who are admin of an org with an instance.
 */
async function funnel(env: Env) {
  const db = env.DB;
  const [byStatus, withInstance] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status'),
    db.prepare(
      `SELECT COUNT(DISTINCT ar.id) AS n FROM access_requests ar
       JOIN user u ON u.registrationCodeId = ar.registration_code_id
       JOIN member m ON m.userId = u.id
       JOIN instances i ON i.org_id = m.organizationId
       WHERE ar.status = 'joined'`,
    ),
  ]);
  const n: Record<string, number> = { unconfirmed: 0, pending: 0, granted: 0, declined: 0, joined: 0 };
  for (const r of byStatus?.results ?? []) n[String(r.status)] = Number(r.n);
  return {
    byStatus: n,
    requested: n.unconfirmed! + n.pending! + n.granted! + n.declined! + n.joined!,
    confirmed: n.pending! + n.granted! + n.declined! + n.joined!,
    granted: n.granted! + n.joined!,
    joined: n.joined!,
    withInstance: Number(withInstance?.results[0]?.n ?? 0),
  };
}

/**
 * ?status=pending (default, oldest first) or all (every confirmed request, newest first), plus
 * the funnel counts. Each listing is audited with the count only, like the waitlist.
 */
accessRequestsApp.get('/access-requests', requireCap('access_requests.manage'), async (c) => {
  const me = await staff(c);
  const status = c.req.query('status') === 'all' ? 'all' : 'pending';
  const rows = await c.env.DB.prepare(
    status === 'pending'
      ? "SELECT * FROM access_requests WHERE status = 'pending' AND shredded_at IS NULL ORDER BY confirmed_at, created_at LIMIT 500"
      : "SELECT * FROM access_requests WHERE status <> 'unconfirmed' ORDER BY created_at DESC LIMIT 500",
  ).all<Row>();
  const requests = [];
  for (const r of rows.results) requests.push(await view(c.env, r));
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'platform.access_requests_viewed',
    targetType: 'system',
    targetId: 'access_requests',
    details: { count: requests.length },
  });
  return c.json({ status, requests, counts: await funnel(c.env) });
});

/** The request, decrypted, or 404; 409 unless it is waiting for a decision. */
async function pendingRequest(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM access_requests WHERE id = ?').bind(id).first<Row>();
  if (!row) fail(404, 'not_found');
  if (row.status !== 'pending') fail(409, 'not_pending');
  const email = await decrypt(env, row, 'email', row.email);
  if (!email) fail(409, 'unreadable');
  return { row, email };
}

const grantBody = z.object({
  tier: z.string().min(1).max(40).default('free'),
  expiresInDays: z.number().int().min(1).max(365).default(14),
  message: z.string().trim().max(2000).optional(),
});

/**
 * Makes a single-use registration code tied to the requester's address (the same code path as
 * POST /registration/codes) and mails it. The code is also returned, so it can be passed on by
 * hand when the mail could not be sent (`mailed: false`).
 */
accessRequestsApp.post('/access-requests/:id/grant', requireCap('access_requests.manage'), async (c) => {
  const me = await staff(c);
  const body = await optionalBody(c, grantBody);
  const id = c.req.param('id');
  const { row, email } = await pendingRequest(c.env, id);
  await assertTier(c.env, body.tier);
  const ring = deps().keyRing(c.env);
  const made = await createRegistrationCode(c.env, {
    createdBy: me,
    tier: body.tier,
    uses: 1,
    expiresInDays: body.expiresInDays,
    note: 'Access request',
    emailIndex: await ring.emailIndex(email),
  });
  const now = Date.now();
  const note = body.message ? await ring.encrypt(accessRequestField(id, 'decision_note'), body.message) : null;
  const res = await c.env.DB.prepare(
    "UPDATE access_requests SET status = 'granted', decided_at = ?, decided_by = ?, decision_note = ?, registration_code_id = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(now, me.id, note, made.id, row.id)
    .run();
  if (!res.meta.changes) {
    // Someone else decided in the meantime: the code must not outlive this attempt.
    await c.env.DB.prepare('DELETE FROM registration_codes WHERE code_hash = ?').bind(made.id).run();
    fail(409, 'not_pending');
  }
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'platform.access_request_granted',
    targetType: 'access_request',
    targetId: id,
    details: { tier: body.tier, expiresInDays: body.expiresInDays, message: !!body.message },
  });
  let mailed = true;
  try {
    await deps().sendEmail(c.env, { to: email, ...accessGrantedEmail({ code: made.code, expiresAt: made.expiresAt ?? now, message: body.message, site: siteOf(c.env) }) });
  } catch (err) {
    mailed = false;
    console.error(JSON.stringify({ at: 'access_request.grant_mail_failed', message: logSafe(err) }));
  }
  return c.json({ ok: true, code: made.code, codeId: made.id, expiresAt: made.expiresAt, mailed });
});

const declineBody = z.object({
  notify: z.boolean().default(true),
  message: z.string().trim().max(2000).optional(),
});

accessRequestsApp.post('/access-requests/:id/decline', requireCap('access_requests.manage'), async (c) => {
  const me = await staff(c);
  const body = await optionalBody(c, declineBody);
  const id = c.req.param('id');
  const { row, email } = await pendingRequest(c.env, id);
  const note = body.message ? await deps().keyRing(c.env).encrypt(accessRequestField(id, 'decision_note'), body.message) : null;
  const res = await c.env.DB.prepare(
    "UPDATE access_requests SET status = 'declined', decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(Date.now(), me.id, note, row.id)
    .run();
  if (!res.meta.changes) fail(409, 'not_pending');
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'platform.access_request_declined',
    targetType: 'access_request',
    targetId: id,
    details: { notified: body.notify },
  });
  let mailed = false;
  if (body.notify) {
    try {
      await deps().sendEmail(c.env, { to: email, ...accessDeclinedEmail({ message: body.message, site: siteOf(c.env) }) });
      mailed = true;
    } catch (err) {
      console.error(JSON.stringify({ at: 'access_request.decline_mail_failed', message: logSafe(err) }));
    }
  }
  return c.json({ ok: true, mailed });
});
