// The platform's own secrets: generated once per deployment, never by hand. MASTER_KEY encrypts
// tenant data (D36, D37): without it, backups can't be read.
import { webcrypto as crypto } from 'node:crypto';

/** Which Worker reads which generated secret. */
export const CORE_SECRETS = {
  control: ['BETTER_AUTH_SECRET', 'MASTER_KEY', 'BLIND_INDEX_KEY', 'IDENTITY_SIGNING_JWK', 'SETUP_TOKEN'],
  gate: ['GATE_COOKIE_KEY'],
};
export const CORE_SECRET_NAMES = [...CORE_SECRETS.control, ...CORE_SECRETS.gate];

const b64 = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64');

/** One fresh value per name (default: all six). */
export async function generateSecrets(names = CORE_SECRET_NAMES, { kidPrefix = 'key' } = {}) {
  const out = {};
  for (const name of names) {
    if (name === 'IDENTITY_SIGNING_JWK') {
      const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await crypto.subtle.exportKey('jwk', privateKey);
      jwk.kid = `${kidPrefix}-${Date.now()}`;
      jwk.alg = 'ES256';
      out[name] = JSON.stringify(jwk);
    } else if (name === 'SETUP_TOKEN') out[name] = b64(24);
    else if (CORE_SECRET_NAMES.includes(name)) out[name] = b64(32);
    else throw new Error(`${name} is not a generated secret`);
  }
  return out;
}
