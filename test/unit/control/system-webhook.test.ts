import { beforeEach, describe, expect, it } from 'vitest';
import { deliveryStatusFor, recordSentMail } from '../../../packages/platform/src/control/system/mail';
import { MAX_BODY, readBounded, replayKey } from '../../../packages/platform/src/control/system/resend-webhook';
import { signSvix, verifySvix } from '../../../packages/platform/src/control/system/svix';
import { envWith, systemHarness, testEnv } from './helpers/system-harness';

const call = systemHarness();
const SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`;
const hookEnv = envWith({ RESEND_WEBHOOK_SECRET: SECRET });

const event = (type: string, emailId: string, createdAt: string) =>
  JSON.stringify({ type, created_at: createdAt, data: { email_id: emailId, to: ['someone@example.com'], subject: 'x' } });

async function post(
  body: string,
  opts: { ts?: number; secret?: string; id?: string; sig?: string; env?: typeof hookEnv; headers?: Record<string, string>; stream?: boolean } = {},
) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const sig = opts.sig ?? (await signSvix(opts.secret ?? SECRET, id, ts, body));
  // stream: no content-length, so only the byte count while reading can refuse it.
  const bytes = new TextEncoder().encode(body);
  const payload = opts.stream ? new Response(bytes).body : body;
  return call('/api/webhooks/resend', {
    method: 'POST',
    body: payload,
    headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig, 'content-type': 'application/json', ...opts.headers },
    env: opts.env ?? hookEnv,
    ...(opts.stream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM mail_messages').run();
});

describe('Svix signatures', () => {
  const body = '{"type":"email.delivered"}';
  const now = 1_760_000_000_000;
  const ts = now / 1000;

  it('accepts a valid signature, also among several', async () => {
    const sig = await signSvix(SECRET, 'msg_1', ts, body);
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: sig }, body, now)).toEqual({ ok: true });
    const other = await signSvix(`whsec_${btoa('another-secret-another-secret!!')}`, 'msg_1', ts, body);
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: `${other} ${sig}` }, body, now)).toEqual({ ok: true });
  });

  it('rejects a tampered body, id or signature', async () => {
    const sig = await signSvix(SECRET, 'msg_1', ts, body);
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: sig }, body.replace('delivered', 'bounced'), now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySvix(SECRET, { id: 'msg_2', timestamp: String(ts), signature: sig }, body, now)).toEqual({ ok: false, reason: 'bad_signature' });
    const flipped = sig.slice(0, -4) + (sig.slice(-4) === 'AAA=' ? 'BBB=' : 'AAA=');
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: flipped }, body, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: sig.replace('v1,', 'v2,') }, body, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts), signature: 'v1,!!notbase64' }, body, now)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects stale or future timestamps beyond 5 minutes, and missing headers', async () => {
    for (const t of [ts - 301, ts + 301]) {
      const sig = await signSvix(SECRET, 'msg_1', t, body);
      expect(await verifySvix(SECRET, { id: 'msg_1', timestamp: String(t), signature: sig }, body, now)).toEqual({ ok: false, reason: 'stale' });
    }
    const edge = await signSvix(SECRET, 'msg_1', ts - 299, body);
    expect((await verifySvix(SECRET, { id: 'msg_1', timestamp: String(ts - 299), signature: edge }, body, now)).ok).toBe(true);
    expect(await verifySvix(SECRET, { id: null, timestamp: String(ts), signature: edge }, body, now)).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('POST /api/webhooks/resend (S2)', () => {
  it('404 when no secret is configured', async () => {
    expect((await post(event('email.delivered', 're_1', new Date().toISOString()), { env: envWith({ RESEND_WEBHOOK_SECRET: undefined }) })).status).toBe(404);
  });

  it('401 on a bad, tampered or stale signature; nothing applied', async () => {
    await recordSentMail(testEnv, { emailId: 're_1', ref: 'invitation:i1', kind: 'invitation' });
    const body = event('email.bounced', 're_1', new Date().toISOString());
    expect((await post(body, { secret: `whsec_${btoa('wrong-secret-wrong-secret-wrong!')}` })).status).toBe(401);
    expect((await post(body, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signSvix(SECRET, 'msg_x', ts, body);
    expect((await post(body.replace('bounced', 'delivered'), { ts, id: 'msg_x', sig })).status).toBe(401);
    expect((await deliveryStatusFor(testEnv, 'invitation:i1'))?.status).toBe('accepted');
  });

  it('keeps the newest event per referenced mail and ignores unknown ids and event types', async () => {
    await recordSentMail(testEnv, { emailId: 're_1', ref: 'invitation:i1', kind: 'invitation' }, 1000);
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    expect(await (await post(event('email.sent', 're_1', at(0)))).json()).toEqual({ ok: true, applied: true });
    expect(await (await post(event('email.delivered', 're_1', at(2000)))).json()).toEqual({ ok: true, applied: true });
    // Out of order: an older event arrives late.
    expect(await (await post(event('email.delivery_delayed', 're_1', at(1000)))).json()).toEqual({ ok: true, applied: false });
    expect(await (await post(event('email.opened', 're_1', at(3000)))).json()).toEqual({ ok: true, applied: false });
    expect(await (await post(event('email.delivered', 're_unknown', at(3000)))).json()).toEqual({ ok: true, applied: false });
    expect(await deliveryStatusFor(testEnv, 'invitation:i1')).toEqual({ emailId: 're_1', kind: 'invitation', sentAt: 1000, status: 'delivered', at: t0 + 2000 });
    const row = await testEnv.DB.prepare('SELECT * FROM mail_messages').first();
    expect(JSON.stringify(row)).not.toContain('example.com');
  });

  it('a replayed svix-id is acknowledged and ignored for 10 minutes', async () => {
    await recordSentMail(testEnv, { emailId: 're_r', ref: 'invitation:ir', kind: 'invitation' }, 1000);
    const id = `msg_${crypto.randomUUID()}`;
    const delivered = event('email.delivered', 're_r', new Date(Date.now() - 1000).toISOString());
    expect(await (await post(delivered, { id })).json()).toEqual({ ok: true, applied: true });
    expect(await testEnv.KV.get(await replayKey(id))).toBe('1');
    // Same id, still validly signed (a captured request sent again): nothing happens.
    // Undo it by hand: a replay that were processed would set it again.
    await testEnv.DB.prepare('UPDATE mail_messages SET last_event = NULL, last_event_at = NULL WHERE email_id = ?').bind('re_r').run();
    const replay = await post(delivered, { id });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect((await deliveryStatusFor(testEnv, 'invitation:ir'))?.status).toBe('accepted');
    // An unsigned request never marks an id as seen.
    const fresh = `msg_${crypto.randomUUID()}`;
    expect((await post(delivered, { id: fresh, sig: 'v1,AAAA' })).status).toBe(401);
    expect(await testEnv.KV.get(await replayKey(fresh))).toBeNull();
  });

  it('refuses oversized bodies by content-length before reading, and by bytes read', async () => {
    const body = event('email.delivered', 're_big', new Date().toISOString());
    expect(await (await post(body, { headers: { 'content-length': String(MAX_BODY + 1) } })).json()).toEqual({ error: 'too_large' });
    // Multi-byte characters: under MAX_BODY in UTF-16 code units, over it in bytes.
    const big = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_big' }, pad: 'é'.repeat(MAX_BODY / 2 + 10) });
    expect(big.length).toBeLessThan(MAX_BODY + 100);
    expect(new TextEncoder().encode(big).byteLength).toBeGreaterThan(MAX_BODY);
    expect((await post(big, { stream: true })).status).toBe(413);
    // A normal body streamed is fine.
    expect((await post(body, { stream: true })).status).toBe(200);
    // The reader counts bytes, not characters, and stops at the limit.
    const bytes = new TextEncoder().encode('é'.repeat(6));
    expect(await readBounded(new Response(bytes).body, 12)).toBe('é'.repeat(6));
    expect(await readBounded(new Response(bytes).body, 11)).toBeNull();
    expect(await readBounded(null, 1)).toBe('');
  });

  it('a resent invitation reports the newest mail', async () => {
    await recordSentMail(testEnv, { emailId: 're_old', ref: 'invitation:i2', kind: 'invitation' }, 1000);
    await post(event('email.bounced', 're_old', new Date().toISOString()));
    expect((await deliveryStatusFor(testEnv, 'invitation:i2'))?.status).toBe('bounced');
    await recordSentMail(testEnv, { emailId: 're_new', ref: 'invitation:i2', kind: 'invitation' }, 2000);
    expect(await deliveryStatusFor(testEnv, 'invitation:i2')).toMatchObject({ emailId: 're_new', status: 'accepted' });
  });
});
