// Creating registration codes (D25, D49), shared by POST /api/platform/registration/codes and the
// grant of an access request (access-requests-routes.ts), so both make codes the same way.
import type { Env } from '../env';
import { sha256Hex } from '../keys-api';
import { auditPlatform, type PlatformActorRole } from './audit';
import { deps } from './deps';
import { fail, field, randomSlug, userOwner } from './util';

/** registration_codes.note: owned by the staff member who created the code. */
export const codeNoteField = (codeHash: string, createdBy: string) => field('registration_codes', 'note', codeHash, userOwner(createdBy));

export interface NewCodeInput {
  createdBy: { id: string; role: PlatformActorRole };
  tier: string;
  uses: number;
  expiresInDays: number | null;
  /** Staff-written, e.g. who the code is for: encrypted with the creator's user key. */
  note?: string;
  /** Ties the code to one address (its KeyRing.emailIndex); claimCode refuses any other. */
  emailIndex?: string | null;
}

export interface NewCode {
  code: string;
  id: string; // registration_codes.code_hash
  tier: string;
  uses: number;
  expiresAt: number | null;
}

/** 400 unknown_tier for a tier that doesn't exist. */
export async function assertTier(env: Env, tier: string): Promise<void> {
  if (!(await env.DB.prepare('SELECT 1 FROM tiers WHERE id = ?').bind(tier).first())) fail(400, 'unknown_tier');
}

/** The code is returned once; only its hash is stored (D49). Audited as platform.code_created. */
export async function createRegistrationCode(env: Env, input: NewCodeInput): Promise<NewCode> {
  await assertTier(env, input.tier);
  const code = `${randomSlug(5)}-${randomSlug(5)}-${randomSlug(5)}`.toUpperCase();
  const hash = await sha256Hex(code);
  const now = Date.now();
  const expiresAt = input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null;
  const note = input.note ? await deps().keyRing(env).encrypt(codeNoteField(hash, input.createdBy.id), input.note) : null;
  await env.DB.prepare(
    'INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, uses_total, note, expires_at, created_at, email_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(hash, input.createdBy.id, input.tier, input.uses, input.uses, note, expiresAt, now, input.emailIndex ?? null)
    .run();
  // The note is free text: never in the platform log (D15, audit.ts).
  await auditPlatform(env, {
    actorId: input.createdBy.id,
    actorRole: input.createdBy.role,
    action: 'platform.code_created',
    targetType: 'code',
    targetId: hash.slice(0, 16),
    details: { tier: input.tier, uses: input.uses, ...(input.emailIndex ? { boundToEmail: true } : {}) },
  });
  return { code, id: hash, tier: input.tier, uses: input.uses, expiresAt };
}
