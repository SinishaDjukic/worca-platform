// Master key rotation (D37), mounted at /api/platform. Superadmin with an MFA session only
// (requireCap('keys.master')); the UI adds the D30-style confirmation before the first POST.
//
//   GET  /api/platform/keys/master         -> MasterKeyStatus
//   POST /api/platform/keys/rotate-master  -> re-wraps a bounded batch of data keys under
//        MASTER_KEY; call again until status is 'done'. Body (optional): { limit?: number }.
//
// Operator runbook: docs/security.md "Rotating the master key" (set MASTER_KEY_PREVIOUS to the
// old key and MASTER_KEY to the new one, deploy, POST until done, then delete the previous one).
import { Hono } from 'hono';
import type { AppContext } from './env';
import { masterKeyStatus, rewrapDataKeys } from './keys';
import { auditPlatform, type AuditAction } from './tenancy/audit';
import { requireCap } from './tenancy/roles';
import { actor } from './tenancy/util';

export const keysPlatformApp = new Hono<AppContext>();

/** Rows per request: a few batches, well inside one request's CPU and subrequest budget. */
const MAX_ROWS_PER_REQUEST = 1000;
const BATCH = 100;

keysPlatformApp.get('/keys/master', requireCap('keys.master'), async (c) => c.json(await masterKeyStatus(c.env)));

keysPlatformApp.post('/keys/rotate-master', requireCap('keys.master'), async (c) => {
  const { user } = actor(c);
  let body: { limit?: unknown } = {};
  try {
    body = (await c.req.json()) as { limit?: unknown };
  } catch {
    // no body: defaults
  }
  const requested = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.floor(body.limit) : MAX_ROWS_PER_REQUEST;
  const budget = Math.min(Math.max(requested, 1), MAX_ROWS_PER_REQUEST);

  let rewrapped = 0;
  let failed = 0;
  let cursor: string | null = null;
  let left = budget;
  while (left > 0) {
    const r = await rewrapDataKeys(c.env, { limit: Math.min(BATCH, left), after: cursor });
    rewrapped += r.rewrapped;
    failed += r.failed;
    cursor = r.cursor;
    left -= Math.min(BATCH, left);
    if (r.exhausted) break;
  }
  const status = await masterKeyStatus(c.env);
  await auditPlatform(c.env, {
    actorId: user.id,
    actorRole: 'superadmin',
    action: 'platform.master_key_rotated',
    targetType: 'system',
    targetId: status.masterId,
    details: { rewrapped, failed, done: status.done, total: status.total, status: status.status },
  });
  return c.json({ ...status, rewrapped, failed });
});
