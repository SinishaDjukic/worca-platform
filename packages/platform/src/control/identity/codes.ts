// OWNER: agent:identity. One-time codes from /authorize to the gate's callback: 32 random bytes,
// bound to one host, valid 60 seconds, usable once, stored only as SHA-256 (D49).
import { sha256Hex } from '../keys-api';
import type { Env } from '../env';

export const CODE_TTL_MS = 60_000;
/** Used and expired codes are kept this long for troubleshooting, then pruned. */
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CodeGrant {
  host: string;
  userId: string;
  sessionId: string;
  instanceId: string;
}

export async function createGateCode(env: Env, grant: CodeGrant, now = Date.now()): Promise<string> {
  const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    `INSERT INTO gate_codes (code_hash, host, user_id, session_id, instance_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(await sha256Hex(code), grant.host, grant.userId, grant.sessionId, grant.instanceId, now + CODE_TTL_MS, now)
    .run();
  return code;
}

/**
 * Marks the code used in one statement, so two concurrent exchanges can't both win. A code
 * presented for another host is burned too: it has leaked.
 */
export async function consumeGateCode(env: Env, code: string, host: string, now = Date.now()): Promise<CodeGrant | null> {
  if (typeof code !== 'string' || code.length < 20 || code.length > 128) return null;
  const row = await env.DB.prepare(
    `UPDATE gate_codes SET used_at = ?1
     WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING host, user_id, session_id, instance_id`,
  )
    .bind(now, await sha256Hex(code))
    .first<{ host: string; user_id: string; session_id: string; instance_id: string }>();
  if (!row || row.host !== host) return null;
  return { host: row.host, userId: row.user_id, sessionId: row.session_id, instanceId: row.instance_id };
}

/** For the instances module's daily cron. Returns the number of rows deleted. */
export async function pruneGateCodes(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare('DELETE FROM gate_codes WHERE expires_at < ?').bind(now - CODE_RETENTION_MS).run();
  return res.meta.changes ?? 0;
}
