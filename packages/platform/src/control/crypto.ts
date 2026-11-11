// Crypto primitives on WebCrypto. Key hierarchy and field
// formats live in keys.ts; this file knows nothing about owners or tables.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: ArrayBuffer | Uint8Array): string => dec.decode(b);

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token, `n` bytes of entropy. */
export function randomToken(n = 32): string {
  return toBase64Url(randomBytes(n));
}

/** A 32-byte secret given as base64 (MASTER_KEY, BLIND_INDEX_KEY). */
export function decodeKey32(b64: string | undefined, name: string): Uint8Array {
  if (!b64) throw new Error(`${name} is not configured`);
  const raw = fromBase64(b64.trim());
  if (raw.length !== 32) throw new Error(`${name} must be 32 bytes of base64`);
  return raw;
}

export function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

export function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

/** AES-256-GCM with a fresh 96-bit IV; `aad` binds the ciphertext to its context. */
export async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(aad) as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws (OperationError) when the key, IV, ciphertext or AAD don't match. */
export async function aesGcmDecrypt(key: CryptoKey, sealed: Sealed, aad: string): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv as BufferSource, additionalData: utf8(aad) as BufferSource },
    key,
    sealed.ct as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function hmacSha256Hex(key: CryptoKey, value: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', key, utf8(value) as BufferSource));
}

/** Constant-time string equality; only the length leaks early. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
