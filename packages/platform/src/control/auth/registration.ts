// Registration modes (D25): invite_code at launch, then waitlist, then open. Enforced when
// Better Auth creates a user (databaseHooks.user.create in auth/index.ts), because email-code
// sign-in, OAuth callbacks and SSO all create users implicitly; there is no sign-up endpoint.
import { sha256Hex } from '../keys-api';
import { getKeyRing } from '../keys';
import type { Env } from '../env';

export type RegistrationMode = 'invite_code' | 'waitlist' | 'open';
export type RegisteredVia = 'code' | 'invitation' | 'sso' | 'waitlist' | 'approved' | 'open' | 'setup';
export type UserStatus = 'pending' | 'active' | 'disabled';

export const SIGNUP_CODE_HEADER = 'x-signup-code';
/** Set by the sign-in page so OAuth round trips (which arrive as plain GETs) carry the code. */
export const SIGNUP_CODE_COOKIE = 'worca_signup_code';

const MODES: readonly RegistrationMode[] = ['invite_code', 'waitlist', 'open'];

export async function getRegistrationMode(env: Env): Promise<RegistrationMode> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM platform_settings WHERE key = 'registration_mode'`).first<{ value: string }>();
    const mode = row?.value as RegistrationMode | undefined;
    return mode && MODES.includes(mode) ? mode : 'invite_code';
  } catch {
    return 'invite_code'; // table not migrated yet: the most restrictive mode
  }
}

/** Registration codes are stored only as SHA-256 of the trimmed code (D49). */
export const hashRegistrationCode = (code: string) => sha256Hex(code.trim());

/** The blind index a code tied to an address is compared with; null without an address. */
const codeEmailIndex = async (env: Env, email: string | null | undefined): Promise<string | null> =>
  email?.trim() ? getKeyRing(env).emailIndex(email) : null;

/**
 * A usable code. A code made for one address (registration_codes.email_index, set when an access
 * request is granted) is only valid for that address; codes without one work for anyone.
 */
export async function findValidCode(env: Env, code: string, email?: string | null): Promise<{ codeHash: string; tier: string } | null> {
  if (!code.trim()) return null;
  const codeHash = await hashRegistrationCode(code);
  const row = await env.DB.prepare(
    `SELECT tier FROM registration_codes WHERE code_hash = ? AND uses_left > 0 AND (expires_at IS NULL OR expires_at > ?)
       AND (email_index IS NULL OR email_index = ?)`,
  )
    .bind(codeHash, Date.now(), await codeEmailIndex(env, email))
    .first<{ tier: string }>();
  return row ? { codeHash, tier: row.tier } : null;
}

/**
 * Takes one use atomically and returns the code's tier, or null when none is left. Done while
 * deciding, before the user row is written: checking first and counting after would let two
 * concurrent sign-ups share the last use. A sign-up that fails after this burns the use; with
 * email codes the user row is only created once the code is verified, so that is rare.
 * A code tied to an address is refused for any other address (see findValidCode).
 */
export async function claimCode(env: Env, code: string, email?: string | null): Promise<{ tier: string; codeHash: string } | null> {
  if (!code.trim()) return null;
  const codeHash = await hashRegistrationCode(code);
  const row = await env.DB.prepare(
    `UPDATE registration_codes SET uses_left = uses_left - 1
     WHERE code_hash = ? AND uses_left > 0 AND (expires_at IS NULL OR expires_at > ?)
       AND (email_index IS NULL OR email_index = ?)
     RETURNING tier`,
  )
    .bind(codeHash, Date.now(), await codeEmailIndex(env, email))
    .first<{ tier: string }>();
  return row ? { tier: row.tier, codeHash } : null;
}

/** The sign-up code a request carries: header, JSON body field `signupCode`, or the page's cookie. */
export function signupCodeFrom(req: { headers?: Headers | null; body?: unknown }): string | null {
  const header = req.headers?.get(SIGNUP_CODE_HEADER)?.trim();
  if (header) return header;
  const body = req.body as { signupCode?: unknown } | null | undefined;
  if (body && typeof body === 'object' && typeof body.signupCode === 'string' && body.signupCode.trim()) return body.signupCode.trim();
  const cookie = req.headers?.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SIGNUP_CODE_COOKIE) {
      const value = decodeURIComponent(rest.join('=')).trim();
      if (value) return value;
    }
  }
  return null;
}

export class RegistrationError extends Error {
  constructor(public code: 'signup_code_required' | 'invalid_signup_code' | 'email_not_verified', message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

/** The org SSO provider a sign-in came through, resolved from the callback's providerId. */
export interface SsoProviderFacts {
  organizationId: string | null;
  /** The provider's `domain` field as stored (decrypted). */
  domain: string;
  domainVerified: boolean;
  /** The organization exists and isn't suspended or being deleted. */
  orgActive: boolean;
}

export interface RegistrationInput {
  email: string;
  emailVerified: boolean;
  /** Set only when the user is being created by an org SSO callback. */
  sso?: SsoProviderFacts | null;
  code: string | null;
  /** Whether a pending, unexpired org invitation exists for this exact email. */
  hasPendingInvitation: () => Promise<boolean>;
}

export interface RegistrationDecision {
  status: UserStatus;
  registeredVia: RegisteredVia;
  signupTier: string | null;
  /** The claimed code's id (registration_codes.code_hash) when registeredVia is 'code'; else null. */
  registrationCodeId: string | null;
}

/** Org-owned, active org, verified domain, and the email's domain is exactly that domain. */
export function ssoVouches(p: SsoProviderFacts, email: string): boolean {
  const at = email.lastIndexOf('@');
  const emailDomain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : '';
  return !!p.organizationId && p.orgActive && p.domainVerified === true && !!emailDomain && emailDomain === p.domain.trim().toLowerCase();
}

export async function decideRegistration(env: Env, input: RegistrationInput): Promise<RegistrationDecision> {
  // An org's SSO vouches for people on the domain the org proved it owns; like an invitation,
  // allowed in every mode. Anything short of that falls through to the normal checks, so a
  // self-registered provider can't be used to skip the registration mode.
  if (input.sso && ssoVouches(input.sso, input.email)) return { status: 'active', registeredVia: 'sso', signupTier: null, registrationCodeId: null };
  // D50: accounts exist only for addresses someone vouched for. Email codes always verify;
  // OAuth profiles only when the provider says so (emailVouched in auth/index.ts).
  if (!input.emailVerified) {
    throw new RegistrationError('email_not_verified', 'Sign in with an email code first; this provider did not confirm your email address.');
  }
  if (await input.hasPendingInvitation()) return { status: 'active', registeredVia: 'invitation', signupTier: null, registrationCodeId: null };

  const mode = await getRegistrationMode(env);
  const valid = input.code ? await claimCode(env, input.code, input.email) : null;
  if (valid) return { status: 'active', registeredVia: 'code', signupTier: valid.tier, registrationCodeId: valid.codeHash };
  if (mode === 'invite_code') {
    if (input.code) throw new RegistrationError('invalid_signup_code', 'This sign-up code is not valid.');
    throw new RegistrationError('signup_code_required', 'A sign-up code is required to create an account.');
  }
  if (mode === 'waitlist') return { status: 'pending', registeredVia: 'waitlist', signupTier: null, registrationCodeId: null };
  return { status: 'active', registeredVia: 'open', signupTier: null, registrationCodeId: null };
}

/**
 * Better Auth's allowUserToCreateOrganization. Active users only. Registering with a code, in
 * open mode, by setup, or being approved off the waitlist (approveWaitlistedUser) allows it.
 * People who came in through an org invitation or org SSO joined someone else's tenant, and
 * waitlisted people not yet approved, may start their own only once registration is open (D25).
 */
export async function canCreateOrganization(env: Env, user: Record<string, unknown>): Promise<boolean> {
  if (user.status !== 'active') return false;
  const via = user.registeredVia as RegisteredVia | undefined;
  if (via === 'code' || via === 'open' || via === 'setup' || via === 'approved') return true;
  return (await getRegistrationMode(env)) === 'open';
}
