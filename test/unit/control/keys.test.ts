import { describe, expect, it } from 'vitest';
import { getKeyRing, KeyDestroyedError, _clearKeyCaches } from '../../../packages/platform/src/control/keys';
import type { FieldContext, KeyOwner } from '../../../packages/platform/src/control/keys-api';
import { toBase64 } from '../../../packages/platform/src/control/crypto';
import { keysEnv, uid } from './helpers/keys-env';

const env = keysEnv();
const ring = getKeyRing(env);

function ctxFor(owner: KeyOwner, over: Partial<FieldContext> = {}): FieldContext {
  return { table: 'user', column: 'email', rowId: owner.id, owner, ...over };
}

describe('KeyRing', () => {
  it('round-trips and produces versioned, non-deterministic ciphertexts', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    await ring.ensureKey(owner);
    const a = await ring.encrypt(ctxFor(owner), 'ana@example.com');
    const b = await ring.encrypt(ctxFor(owner), 'ana@example.com');
    expect(a).toMatch(/^e1\.1\./);
    expect(a).not.toBe(b);
    expect(a).not.toContain('ana@example.com'); // not just 'ana': random base64url can contain that
    expect(ring.isCiphertext(a)).toBe(true);
    expect(ring.isCiphertext('ana@example.com')).toBe(false);
    expect(ring.isCiphertext(null)).toBe(false);
    expect(await ring.decrypt(ctxFor(owner), a)).toBe('ana@example.com');
    expect(await ring.decrypt(ctxFor(owner), await ring.encrypt(ctxFor(owner), ''))).toBe('');
  });

  it('binds ciphertexts to table, column, row and owner (AAD)', async () => {
    const owner: KeyOwner = { type: 'org', id: uid() };
    const ctx = ctxFor(owner, { table: 'organization', column: 'name', rowId: owner.id });
    const ct = await ring.encrypt(ctx, 'Acme');
    await expect(ring.decrypt({ ...ctx, rowId: uid() }, ct)).rejects.toThrow(/cannot decrypt/);
    await expect(ring.decrypt({ ...ctx, column: 'slug' }, ct)).rejects.toThrow(/cannot decrypt/);
    await expect(ring.decrypt({ ...ctx, table: 'team' }, ct)).rejects.toThrow(/cannot decrypt/);
    const other: KeyOwner = { type: 'org', id: uid() };
    await ring.ensureKey(other);
    await expect(ring.decrypt({ ...ctx, owner: other }, ct)).rejects.toThrow();
  });

  it('stores one wrapped key per owner, never the raw key', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    await ring.ensureKey(owner);
    await ring.ensureKey(owner);
    const rows = await env.DB.prepare('SELECT * FROM data_keys WHERE owner_id = ?').bind(owner.id).all<{ wrapped: string; version: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.version).toBe(1);
    expect(rows.results[0]!.wrapped).toMatch(/^m1\./);
  });

  it('needs the right master key to unwrap', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    const ct = await ring.encrypt(ctxFor(owner), 'x');
    _clearKeyCaches();
    const wrong = getKeyRing(keysEnv({ MASTER_KEY: toBase64(new Uint8Array(32).fill(1)) }));
    await expect(wrong.decrypt(ctxFor(owner), ct)).rejects.toThrow();
  });

  it('rotates an org key; old rows still decrypt with their version', async () => {
    const owner: KeyOwner = { type: 'org', id: uid() };
    const ctx = ctxFor(owner, { table: 'team', column: 'name', rowId: uid() });
    const v1 = await ring.encrypt(ctx, 'Team one');
    expect(await ring.rotateOrgKey(owner.id)).toBe(2);
    const v2 = await ring.encrypt(ctx, 'Team one');
    expect(v1).toMatch(/^e1\.1\./);
    expect(v2).toMatch(/^e1\.2\./);
    _clearKeyCaches();
    expect(await ring.decrypt(ctx, v1)).toBe('Team one');
    expect(await ring.decrypt(ctx, v2)).toBe('Team one');
    expect(await ring.rotateOrgKey(owner.id)).toBe(3);
  });

  it('destroyKey wipes every version; decrypt then throws KeyDestroyedError', async () => {
    const owner: KeyOwner = { type: 'org', id: uid() };
    const ctx = ctxFor(owner, { table: 'organization', column: 'name' });
    const v1 = await ring.encrypt(ctx, 'Gone');
    await ring.rotateOrgKey(owner.id);
    await ring.destroyKey(owner);
    await expect(ring.decrypt(ctx, v1)).rejects.toBeInstanceOf(KeyDestroyedError);
    await expect(ring.encrypt(ctx, 'new')).rejects.toBeInstanceOf(KeyDestroyedError);
    await expect(ring.rotateOrgKey(owner.id)).rejects.toBeInstanceOf(KeyDestroyedError);
    await ring.ensureKey(owner); // must not resurrect
    await expect(ring.encrypt(ctx, 'new')).rejects.toBeInstanceOf(KeyDestroyedError);
    const rows = await env.DB.prepare('SELECT wrapped, destroyed_at FROM data_keys WHERE owner_id = ?').bind(owner.id).all();
    expect(rows.results.every((r) => r.wrapped === null && r.destroyed_at !== null)).toBe(true);
  });

  it('a key load still running when the key is destroyed does not put the key back in the cache', async () => {
    const owner: KeyOwner = { type: 'org', id: uid() };
    const ctx = ctxFor(owner, { table: 'organization', column: 'name' });
    const v1 = await ring.encrypt(ctx, 'Gone');
    _clearKeyCaches();
    const loading = ring.decrypt(ctx, v1); // starts the D1 read and unwrap, not yet finished
    await ring.destroyKey(owner);
    await loading.catch(() => {});
    await expect(ring.decrypt(ctx, v1)).rejects.toBeInstanceOf(KeyDestroyedError);
  });

  it('concurrent first uses each load the key and agree (no shared pending load)', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    const ctx = ctxFor(owner);
    const v1 = await ring.encrypt(ctx, 'same');
    _clearKeyCaches();
    expect(await Promise.all([ring.decrypt(ctx, v1), ring.decrypt(ctx, v1), ring.decrypt(ctx, v1)])).toEqual(['same', 'same', 'same']);
  });

  it('destroyKey on an owner without a key blocks later key creation', async () => {
    const owner: KeyOwner = { type: 'user', id: uid() };
    await ring.destroyKey(owner);
    await ring.ensureKey(owner);
    await expect(ring.encrypt(ctxFor(owner), 'x')).rejects.toBeInstanceOf(KeyDestroyedError);
  });

  it('blind index: deterministic, separate key, email normalized by trim + lowercase only', async () => {
    const a = await ring.emailIndex('  Ana.B+tag@Example.COM ');
    expect(a).toBe(await ring.emailIndex('ana.b+tag@example.com'));
    expect(a).not.toBe(await ring.emailIndex('anab@example.com'));
    expect(a).toBe(await ring.blindIndex('ana.b+tag@example.com'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const other = getKeyRing(keysEnv({ BLIND_INDEX_KEY: toBase64(new Uint8Array(32).fill(3)) }));
    expect(await other.emailIndex('ana.b+tag@example.com')).not.toBe(a);
  });
});
