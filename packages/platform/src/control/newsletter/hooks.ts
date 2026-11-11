// POST /api/hooks/release (D70): worca-cc's release workflow announces a release. The body is
// JSON { version, url, notes? }, signed with RELEASE_HOOK_SECRET:
//   x-worca-signature: sha256=<hex HMAC-SHA256(key = secret as UTF-8, message = raw body)>
// 404 while the secret is unset, 401 on a bad signature, 200 { duplicate: true } for a version
// already announced, else 202 with the classification and the recipient count.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { hmacSha256Hex, timingSafeEqual, utf8 } from '../crypto';
import { readBounded } from '../system/resend-webhook';
import { auditPlatform } from '../tenancy/audit';
import { queueReleaseIssue, ReleaseVersionError } from './core';

export const hooksApp = new Hono<AppContext>();

export const HOOK_MAX_BODY = 64 * 1024;

/** `sha256=<hex>` of the raw body under the shared secret (what the release workflow sends). */
export async function releaseSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${await hmacSha256Hex(key, body)}`;
}

const httpsUrl = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

const bodySchema = z.object({
  version: z.string().min(1).max(80),
  url: z.string().max(500).refine(httpsUrl),
  notes: z.string().max(100_000).nullish(),
});

hooksApp.post('/release', async (c) => {
  const secret = c.env.RELEASE_HOOK_SECRET;
  if (!secret) return c.json({ error: 'not_found' }, 404);
  const declared = c.req.header('content-length');
  if (declared !== undefined && !(/^\d+$/.test(declared) && Number(declared) <= HOOK_MAX_BODY)) return c.json({ error: 'too_large' }, 413);
  const raw = await readBounded(c.req.raw.body, HOOK_MAX_BODY);
  if (raw === null) return c.json({ error: 'too_large' }, 413);

  const given = (c.req.header('x-worca-signature') ?? '').trim().toLowerCase();
  if (!timingSafeEqual(given, await releaseSignature(secret, raw))) {
    console.warn(JSON.stringify({ at: 'release_hook_rejected' }));
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    const r = bodySchema.safeParse(JSON.parse(raw));
    if (!r.success) return c.json({ error: 'invalid_body' }, 400);
    body = r.data;
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }

  let out;
  try {
    out = await queueReleaseIssue(c.env, body);
  } catch (err) {
    if (err instanceof ReleaseVersionError) return c.json({ error: 'invalid_version' }, 400);
    throw err;
  }
  if (out.duplicate) return c.json({ ok: true, duplicate: true, issueId: out.issueId }, 200);
  await auditPlatform(c.env, {
    actorId: null,
    actorRole: 'system',
    action: 'newsletter.release_queued',
    targetType: 'system',
    targetId: out.issueId,
    details: { version: out.version, level: out.level, recipients: out.recipients },
  });
  return c.json({ ok: true, issueId: out.issueId, version: out.version, level: out.level, recipients: out.recipients }, 202);
});
