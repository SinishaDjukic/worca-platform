// POST /api/webhooks/resend (S2): Resend delivery events, Svix-signed with RESEND_WEBHOOK_SECRET.
// Only the last event per referenced mail is kept (mail_messages); payload addresses are dropped.
import { Hono } from 'hono';
import type { AppContext } from '../env';
import { sha256Hex } from '../keys-api';
import { applyDeliveryEvent, DELIVERY_EVENTS, type DeliveryEvent } from './mail';
import { verifySvix } from './svix';
import { suppressForMail } from '../newsletter/core';

export const webhooksApp = new Hono<AppContext>();

/** Webhook bodies are small; anything bigger isn't Resend. Bytes. */
export const MAX_BODY = 256 * 1024;

/** How long a delivered svix-id is remembered: covers Svix's 5-minute timestamp tolerance both ways. */
export const REPLAY_WINDOW_S = 10 * 60;

export const replayKey = async (svixId: string) => `svix:resend:${await sha256Hex(svixId)}`;

/** The body as text, or null once it passes `max` bytes (stops reading there). */
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    all.set(ch, at);
    at += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

webhooksApp.post('/resend', async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'not_found' }, 404);
  // Refuse by the declared size before reading anything, then count the bytes actually sent.
  const declared = c.req.header('content-length');
  if (declared !== undefined && !(/^\d+$/.test(declared) && Number(declared) <= MAX_BODY)) return c.json({ error: 'too_large' }, 413);
  const raw = await readBounded(c.req.raw.body, MAX_BODY);
  if (raw === null) return c.json({ error: 'too_large' }, 413);

  const verdict = await verifySvix(
    secret,
    { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') },
    raw,
  );
  if (!verdict.ok) {
    console.warn(JSON.stringify({ at: 'resend_webhook_rejected', reason: verdict.reason }));
    return c.json({ error: 'invalid_signature' }, 401);
  }
  // A valid signature can be replayed within the timestamp tolerance: each svix-id counts once.
  // (Svix retries reuse the id; one that was processed is acknowledged without doing it again.)
  const seenKey = await replayKey(c.req.header('svix-id') as string);
  if (await c.env.KV.get(seenKey)) return c.json({ ok: true, duplicate: true });

  let payload: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; created_at?: unknown } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const type = typeof payload.type === 'string' ? payload.type.replace(/^email\./, '') : '';
  const emailId = payload.data?.email_id;
  // Other event types (opened, clicked, scheduled, ...) are acknowledged and ignored.
  if (!(DELIVERY_EVENTS as readonly string[]).includes(type) || typeof emailId !== 'string') {
    await c.env.KV.put(seenKey, '1', { expirationTtl: REPLAY_WINDOW_S });
    return c.json({ ok: true, applied: false });
  }

  const parsed = Date.parse(typeof payload.created_at === 'string' ? payload.created_at : '');
  const at = Number.isFinite(parsed) ? parsed : Number(c.req.header('svix-timestamp')) * 1000;
  const applied = await applyDeliveryEvent(c.env, emailId, type as DeliveryEvent, at);
  // D70: a newsletter address that bounced or complained gets nothing more.
  if (type === 'bounced' || type === 'complained') await suppressForMail(c.env, emailId);
  // Remembered only once handled, so a failed attempt can still be retried by Svix.
  await c.env.KV.put(seenKey, '1', { expirationTtl: REPLAY_WINDOW_S });
  return c.json({ ok: true, applied });
});
