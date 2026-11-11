// The key hierarchy and field encryption (security.md "Application-level encryption", D36–D38,
// D49). Implemented in src/control/keys.ts; this file is the contract other modules code against.

export type KeyOwner = { type: 'org'; id: string } | { type: 'user'; id: string };

/** Binds a ciphertext to where it lives (additional authenticated data). */
export interface FieldContext {
  table: string; // e.g. "user"
  column: string; // e.g. "email"
  rowId: string;
  owner: KeyOwner;
}

export interface KeyRing {
  /** Creates the owner's data key (wrapped under the master key) if it doesn't exist yet. */
  ensureKey(owner: KeyOwner): Promise<void>;
  encrypt(ctx: FieldContext, plaintext: string): Promise<string>;
  /** Throws KeyDestroyedError when the owner's key was destroyed. */
  decrypt(ctx: FieldContext, ciphertext: string): Promise<string>;
  /** True when the value looks like one of our ciphertexts (versioned prefix). */
  isCiphertext(value: unknown): boolean;
  /** HMAC-SHA256 with the blind-index key, of a value normalized by the caller. */
  blindIndex(value: string): Promise<string>;
  /** Emails: trim + lowercase only (no +tag or dot stripping). */
  emailIndex(email: string): Promise<string>;
  /** Crypto-erasure: the wrapped key is wiped and destroyed_at set (D29, D59). */
  destroyKey(owner: KeyOwner): Promise<void>;
  /**
   * D38: new version of an org's key (data_keys.rotated_at / rotated_by = `by`), and a job that
   * re-encrypts the org's rows to it and then destroys the older versions (keys-jobs.ts, run by
   * the KeyRotationWorkflow). Old rows stay readable while it runs.
   */
  rotateOrgKey(orgId: string, opts?: { by?: string | null }): Promise<number>;
}

export class KeyDestroyedError extends Error {
  constructor(owner: KeyOwner) {
    super(`data key destroyed for ${owner.type}:${owner.id}`);
    this.name = 'KeyDestroyedError';
  }
}

/** SHA-256 hex, for tokens and codes stored only as hashes (D49). */
export async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
