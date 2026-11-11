// OWNER: agent:identity. Identity tokens for worca (identity-and-access.md "The instance gate").
// ES256 JWTs, audience = instance host, verified by worca against /.well-known/jwks.json.
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';
import type { IdentityClaims } from '../../shared/contracts';
import type { Env } from '../env';

/** Short on purpose: the gate renews server to server and access is re-checked each time (D45). */
export const TOKEN_TTL_S = 5 * 60;

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

/**
 * IDENTITY_SIGNING_JWK is one private JWK, an array of them, or `{ keys: [...] }`. With several,
 * the first signs and all are published, so a new key can be added before it takes over.
 */
function parseSigningJwks(raw: string): JWK[] {
  const parsed = JSON.parse(raw) as JWK | JWK[] | { keys: JWK[] };
  const list = Array.isArray(parsed) ? parsed : 'keys' in parsed && Array.isArray(parsed.keys) ? parsed.keys : [parsed as JWK];
  if (list.length === 0) throw new Error('IDENTITY_SIGNING_JWK holds no key');
  for (const jwk of list) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('IDENTITY_SIGNING_JWK: ES256 (P-256) keys only');
    if (!jwk.kid) throw new Error('IDENTITY_SIGNING_JWK: every key needs a kid');
  }
  return list;
}

export function getJwks(env: Env): { keys: PublicJwk[] } {
  const keys = parseSigningJwks(env.IDENTITY_SIGNING_JWK).map((k) => ({
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: k.x!,
    y: k.y!,
    kid: k.kid!,
    alg: 'ES256' as const,
    use: 'sig' as const,
  }));
  return { keys };
}

// Per isolate; keyed by the secret's value so a rotated secret is picked up.
let cached: { raw: string; kid: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<{ kid: string; key: CryptoKey }> {
  const raw = env.IDENTITY_SIGNING_JWK;
  if (cached?.raw === raw) return cached;
  const jwk = parseSigningJwks(raw)[0]!; // never empty: parseSigningJwks throws
  if (!jwk.d) throw new Error('IDENTITY_SIGNING_JWK: the first key must be private');
  const key = (await importJWK({ ...jwk, alg: 'ES256' }, 'ES256')) as CryptoKey;
  cached = { raw, kid: jwk.kid!, key };
  return cached;
}

export type TokenSubject = Omit<IdentityClaims, 'iss' | 'iat' | 'exp'>;

/** Signs a token for `claims.aud` (the instance host); iss, iat and exp are set here. */
export async function signIdentityToken(env: Env, claims: TokenSubject, nowS = Math.floor(Date.now() / 1000)): Promise<{ token: string; exp: number }> {
  const { kid, key } = await signingKey(env);
  const exp = nowS + TOKEN_TTL_S;
  const payload: IdentityClaims = { ...claims, iss: env.APP_ORIGIN, iat: nowS, exp };
  const token = await new SignJWT({ ...payload }).setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).sign(key);
  return { token, exp };
}
