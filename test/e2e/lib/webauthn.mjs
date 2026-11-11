// A virtual WebAuthn authenticator: ES256, 'none' attestation, flags UP|UV, a counting signCount.
// Speaks the JSON shapes of @simplewebauthn (what Better Auth's passkey plugin returns and verifies):
// options from /passkey/generate-register-options and /passkey/generate-authenticate-options,
// responses for /passkey/verify-registration and /passkey/verify-authentication.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { APP_ORIGIN } from './config.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

// ---- Minimal CBOR encoder (RFC 8949): ints, byte strings, text, arrays, maps ------------------

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cborEncode(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('cbor: integers only');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
    return Buffer.concat(parts);
  }
  if (value && typeof value === 'object') return cborEncode(new Map(Object.entries(value)));
  throw new Error(`cbor: unsupported ${typeof value}`);
}

// ---- Authenticator --------------------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class VirtualAuthenticator {
  constructor({ origin = APP_ORIGIN } = {}) {
    this.origin = origin;
    this.credentials = []; // { id: Buffer, privateKey, x, y, rpId, userHandle, signCount }
  }

  #authData(rpId, flags, signCount, attested) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) parts.push(attested);
    return Buffer.concat(parts);
  }

  #clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() given PublicKeyCredentialCreationOptionsJSON. */
  create(options) {
    const rpId = options.rp?.id ?? new URL(this.origin).hostname;
    if (!(options.pubKeyCredParams ?? [{ alg: -7 }]).some((p) => p.alg === -7)) throw new Error('RP does not accept ES256');
    const excluded = new Set((options.excludeCredentials ?? []).map((c) => c.id));
    if (this.credentials.some((c) => c.rpId === rpId && excluded.has(b64url(c.id)))) throw new Error('InvalidStateError: credential already registered');

    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(16);
    const cred = { id, privateKey, rpId, userHandle: options.user?.id ?? null, signCount: 0 };
    this.credentials.push(cred);

    const cose = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16) /* aaguid */, idLen, id, cose]);
    const authData = this.#authData(rpId, FLAG_UP | FLAG_UV | FLAG_AT, cred.signCount, attested);
    const attestationObject = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge);
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        authenticatorData: b64url(authData),
        transports: ['internal'],
        publicKeyAlgorithm: -7,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Credentials as JSON (private keys included), to keep a passkey across test processes. */
  export() {
    return this.credentials.map((c) => ({
      id: b64url(c.id),
      privateKey: c.privateKey.export({ format: 'jwk' }),
      rpId: c.rpId,
      userHandle: c.userHandle,
      signCount: c.signCount,
    }));
  }

  import(list) {
    for (const c of list) {
      this.credentials.push({ id: fromB64url(c.id), privateKey: createPrivateKey({ key: c.privateKey, format: 'jwk' }), rpId: c.rpId, userHandle: c.userHandle, signCount: c.signCount });
    }
    return this;
  }

  /** navigator.credentials.get() given PublicKeyCredentialRequestOptionsJSON. */
  get(options) {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const cred = this.credentials.find((c) => c.rpId === rpId && (allowed.length === 0 || allowed.includes(b64url(c.id))));
    if (!cred) throw new Error(`NotAllowedError: no credential for ${rpId}`);
    cred.signCount += 1;
    const authData = this.#authData(rpId, FLAG_UP | FLAG_UV, cred.signCount);
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey); // DER
    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: cred.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

// ---- Better Auth passkey plugin flows ---------------------------------------------------------

const AUTH = `${APP_ORIGIN}/api/auth`;

/** Adds a passkey to the signed-in account of `browser`. Needs a fresh session. */
export async function registerPasskey(browser, authenticator, { name = 'e2e key' } = {}) {
  const optRes = await browser.fetch(`${AUTH}/passkey/generate-register-options?authenticatorAttachment=platform&name=${encodeURIComponent(name)}`);
  if (optRes.status !== 200) throw new Error(`generate-register-options: ${optRes.describe()}`);
  const response = authenticator.create(optRes.json());
  const verRes = await browser.fetch(`${AUTH}/passkey/verify-registration`, { method: 'POST', body: { response, name } });
  if (verRes.status !== 200) throw new Error(`verify-registration: ${verRes.describe()}`);
  return verRes.json();
}

/** Signs `browser` in with a passkey held by `authenticator`. Returns the verify response. */
export async function signInWithPasskey(browser, authenticator) {
  const optRes = await browser.fetch(`${AUTH}/passkey/generate-authenticate-options`);
  if (optRes.status !== 200) throw new Error(`generate-authenticate-options: ${optRes.describe()}`);
  const response = authenticator.get(optRes.json());
  const verRes = await browser.fetch(`${AUTH}/passkey/verify-authentication`, { method: 'POST', body: { response } });
  if (verRes.status !== 200) throw new Error(`verify-authentication: ${verRes.describe()}`);
  return verRes.json();
}
