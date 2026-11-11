import { beforeAll, expect, it } from 'vitest';
import { getKeyRing } from '../../../packages/platform/src/control/keys';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { keysEnv } from './helpers/keys-env';
import { ensureAuthSchema, makeAuth, sentOtps } from './helpers/keys-auth';

// A real Better Auth instance on the wrapped adapter: sign-in by email code, session lookup,
// organization creation, sign-out; then the raw D1 rows hold no tenant data or live token.
const env = keysEnv();
const ring = getKeyRing(env);
type Row = Record<string, unknown>;

beforeAll(() => ensureAuthSchema(env));

it('email OTP sign-in round trip leaves no plaintext in D1', async () => {
  const auth = makeAuth(env);
  const email = `Round.Trip+${crypto.randomUUID().slice(0, 8)}@Example.com`;
  const normalized = email.toLowerCase();

  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
  const otp = sentOtps.get(normalized) ?? sentOtps.get(email);
  expect(otp).toBeTruthy();

  const res = await auth.api.signInEmailOTP({ body: { email, otp: otp! }, asResponse: true });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; user: { id: string; email: string } };
  expect(body.user.email).toBe(normalized);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;

  const headers = new Headers({ cookie });
  const session = await auth.api.getSession({ headers });
  expect(session?.user.email).toBe(normalized);
  expect(session?.session.token).toBe(body.token);

  // Signing in again finds the same user through the blind index.
  await auth.api.sendVerificationOTP({ body: { email: normalized, type: 'sign-in' } });
  const again = await auth.api.signInEmailOTP({ body: { email: normalized, otp: sentOtps.get(normalized)! } });
  expect(again.user.id).toBe(body.user.id);

  const org = await auth.api.createOrganization({ headers, body: { name: 'Round Trip Org', slug: `rt-${crypto.randomUUID().slice(0, 8)}` } });
  expect(org?.name).toBe('Round Trip Org');

  const listed = await auth.api.listSessions({ headers });
  expect(listed.length).toBe(2);
  // Listed sessions carry signed handles, never the stored hash (D49).
  expect(listed.every((s) => String(s.token).startsWith('r1.'))).toBe(true);
  const other = listed.find((s) => s.id !== session!.session.id)!;
  await auth.api.revokeSession({ headers, body: { token: other.token } });
  const left = await auth.api.listSessions({ headers });
  expect(left.map((s) => s.id)).toEqual([session!.session.id]);

  const user = (await env.DB.prepare('SELECT * FROM "user" WHERE id = ?').bind(body.user.id).first<Row>())!;
  const sessions = (await env.DB.prepare('SELECT * FROM session WHERE userId = ?').bind(body.user.id).all<Row>()).results;
  const orgRow = (await env.DB.prepare('SELECT * FROM organization WHERE id = ?').bind(org!.id).first<Row>())!;
  const member = await env.DB.prepare('SELECT * FROM member WHERE userId = ?').bind(body.user.id).first<Row>();
  const verifications = (await env.DB.prepare('SELECT * FROM verification').all<Row>()).results;

  expect(ring.isCiphertext(user.email)).toBe(true);
  expect(user.emailIndex).toBe(await ring.emailIndex(email));
  expect(ring.isCiphertext(orgRow.name)).toBe(true);
  expect(member).not.toBeNull();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.token).toBe(`h1.${await sha256Hex(body.token)}`);

  const dump = JSON.stringify({ user, sessions, orgRow, verifications });
  expect(dump).not.toContain('round.trip');
  expect(dump).not.toContain('Round Trip Org');
  expect(dump).not.toContain(body.token);

  await auth.api.signOut({ headers });
  expect(await auth.api.getSession({ headers })).toBeNull();
});
