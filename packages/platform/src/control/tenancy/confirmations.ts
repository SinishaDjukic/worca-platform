// Second confirmation of destructive actions by emailed link (D30, D31, D24). The link opens a
// page with a confirm button; nothing happens on GET (mail scanners prefetch links). Single use,
// 30 minutes, only for the user who started it, who must be signed in.
import { Hono, type Context } from 'hono';
import type { AppContext, Env } from '../env';
import { sha256Hex } from '../keys-api';
import { auditOrg, auditPlatform } from './audit';
import { deps } from './deps';
import { STRICT_PAGE_CSP, glyph, pageDocument, type GlyphColor, type IconName } from '../auth/pages';
import { confirmActionEmail } from '../auth/email';
import { field, memberRole, notifyUsers, orgOwner, randomToken, tenantAdminIds, userOwner, userProfile } from './util';
import { siteOf } from '../../shared/site';

export const CONFIRMATION_TTL_MS = 30 * 60 * 1000;

export interface ConfirmInput {
  userId: string;
  orgId: string | null;
  target: string;
  payload: unknown;
}

/** Hands the handler a way to finish work after the response (ExecutionContext when there is one). */
export interface ConfirmCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export type ConfirmHandler = (env: Env, ctx: ConfirmCtx, input: ConfirmInput) => Promise<void>;

export interface ConfirmActionOptions {
  /** Shown in emails and on the page, e.g. "Delete the organization". */
  label?: string;
  /** D24: defaults to true for org-scoped actions (tenant-admin destructive actions). */
  mfa?: boolean;
}

interface Registered {
  handler: ConfirmHandler;
  label: string;
  mfa: boolean | undefined;
}

const registry = new Map<string, Registered>();

export function registerConfirmAction(action: string, handler: ConfirmHandler, opts: ConfirmActionOptions = {}): void {
  registry.set(action, { handler, label: opts.label ?? action, mfa: opts.mfa });
}

const needsMfa = (r: Registered, orgId: string | null): boolean => r.mfa ?? orgId !== null;

function payloadOwner(userId: string, orgId: string | null) {
  return orgId ? orgOwner(orgId) : userOwner(userId);
}

export async function startConfirmation(
  env: Env,
  input: { userId: string; orgId: string | null; action: string; target: string; payload?: unknown; summary: string },
): Promise<{ id: string; expiresAt: number }> {
  const reg = registry.get(input.action);
  if (!reg) throw new Error(`unknown confirm action: ${input.action}`);
  const profile = await userProfile(env, input.userId);
  if (!profile?.email) throw new Error('confirming user has no readable email');

  const id = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + CONFIRMATION_TTL_MS;
  const ctx = field('confirmations', 'payload', id, payloadOwner(input.userId, input.orgId));
  const payload = await deps().keyRing(env).encrypt(ctx, JSON.stringify({ payload: input.payload ?? null, summary: input.summary }));

  // A new request replaces any earlier unused one for the same action and target.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM confirmations WHERE user_id = ? AND action = ? AND target = ? AND used_at IS NULL').bind(
      input.userId,
      input.action,
      input.target,
    ),
    env.DB.prepare(
      'INSERT INTO confirmations (id, user_id, org_id, action, target, payload, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    ).bind(id, input.userId, input.orgId, input.action, input.target, payload, await sha256Hex(token), expiresAt, now),
  ]);

  const link = `${env.APP_ORIGIN}/confirm/${id}?t=${token}`;
  await deps().sendEmail(env, { to: profile.email, ...confirmActionEmail({ label: reg.label, summary: input.summary, link, site: siteOf(env) }) });

  const event = { actorId: input.userId, action: 'confirmation.started' as const, targetType: 'confirmation' as const, targetId: id };
  if (input.orgId) await auditOrg(env, input.orgId, { ...event, actorScope: 'tenant', details: { action: input.action, target: input.target } });
  else await auditPlatform(env, { ...event, actorRole: 'user', details: { action: input.action } });
  return { id, expiresAt };
}

/** The common answer of an endpoint that started a confirmation. */
export function confirmationSent(c: Context<AppContext>, started: { id: string; expiresAt: number }) {
  return c.json({ status: 'confirmation_sent', confirmationId: started.id, expiresAt: started.expiresAt }, 202);
}

// ---------------------------------------------------------------------------------------------
// The page: GET shows a form, POST acts.

interface ConfirmRow {
  id: string;
  user_id: string;
  org_id: string | null;
  action: string;
  target: string;
  payload: string | null;
  token_hash: string;
  expires_at: number;
  used_at: number | null;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

const STATUS_GLYPH: Record<number, [IconName, GlyphColor]> = {
  200: ['check', 'green'],
  400: ['alert', 'amber'],
  401: ['lock', 'slate'],
  403: ['lock', 'amber'],
  410: ['alert', 'amber'],
  500: ['alert', 'red'],
};

/**
 * The page in the app's look (auth/pages.ts), with its own strict CSP. `same-origin`, not
 * `no-referrer`: the token is in the URL, so it must not leave the site, but under `no-referrer`
 * browsers send `Origin: null` with the Confirm form and the origin check refuses it.
 */
function page(c: Context<AppContext>, status: 200 | 400 | 401 | 403 | 410 | 500, title: string, body: string, icon?: [IconName, GlyphColor]) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', STRICT_PAGE_CSP);
  const [name, color] = icon ?? STATUS_GLYPH[status] ?? ['info', 'slate'];
  return c.html(pageDocument(title, `${glyph(name, color)}<h1>${esc(title)}</h1>${body}`, { cardClass: 'center', site: siteOf(c.env) }), status);
}

const backLink = '<div class="sp-actions"><a class="btn primary" href="/">Back to Worca</a></div>';

const INVALID = 'This link is invalid, has been used, or has expired.';

async function loadValid(env: Env, id: string, token: string, now: number): Promise<ConfirmRow | null> {
  const row = await env.DB.prepare('SELECT * FROM confirmations WHERE id = ?').bind(id).first<ConfirmRow>();
  if (!row || row.used_at !== null || row.expires_at <= now || !token) return null;
  if ((await sha256Hex(token)) !== row.token_hash) return null;
  return row;
}

async function readPayload(env: Env, row: ConfirmRow): Promise<{ payload: unknown; summary: string }> {
  if (!row.payload) return { payload: null, summary: '' };
  const ctx = field('confirmations', 'payload', row.id, payloadOwner(row.user_id, row.org_id));
  return JSON.parse(await deps().keyRing(env).decrypt(ctx, row.payload));
}

function executionCtx(c: Context<AppContext>): ConfirmCtx {
  return {
    waitUntil(p) {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        p.catch((err) => console.error(JSON.stringify({ at: 'confirm.waitUntil', message: (err as Error).message })));
      }
    },
  };
}

export const confirmApp = new Hono<AppContext>();

confirmApp.get('/:id', async (c) => {
  const id = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const user = c.get('user');
  if (!user) {
    const back = `/confirm/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
    return page(c, 401, 'Sign in to continue', `<p>Sign in with the account that asked for this, then come back to this link.</p><div class="sp-actions"><a class="btn primary" href="/sign-in?next=${esc(encodeURIComponent(back))}">Sign in</a></div>`);
  }
  const row = await loadValid(c.env, id, token, Date.now());
  if (!row) return page(c, 410, 'Link not valid', `<p>${INVALID}</p>${backLink}`);
  if (row.user_id !== user.id) return page(c, 403, 'Not your link', '<p>Only the person who asked for this can confirm it.</p>');
  const reg = registry.get(row.action);
  const { summary } = await readPayload(c.env, row);
  const mfaNote =
    reg && needsMfa(reg, row.org_id) && !c.get('session')?.mfa
      ? '<div class="banner amber sp-detail"><div class="grow"><b>Sign in with a passkey or a second factor first.</b> Confirming this needs one.</div></div>'
      : '';
  return page(
    c,
    200,
    reg?.label ?? 'Confirm',
    `<p>${esc(summary)}</p><p class="sp-warn">This can't be undone.</p>${mfaNote}<form method="post" action="/confirm/${esc(id)}" class="sp-actions"><input type="hidden" name="t" value="${esc(token)}"><a class="btn" href="/">Cancel</a><button type="submit" class="btn solid-danger">Confirm</button></form>`,
    ['alert', 'red'],
  );
});

async function tokenFromBody(c: Context<AppContext>): Promise<string> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const b = (await c.req.json()) as { t?: unknown };
      return typeof b.t === 'string' ? b.t : '';
    }
    const form = await c.req.parseBody();
    return typeof form.t === 'string' ? form.t : '';
  } catch {
    return '';
  }
}

confirmApp.post('/:id', async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== c.env.APP_ORIGIN) return page(c, 403, 'Not allowed', '<p>Cross-site request refused.</p>');
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) return page(c, 401, 'Sign in to continue', '<p>Sign in, then open the link from your email again.</p>');

  const id = c.req.param('id');
  const token = await tokenFromBody(c);
  const now = Date.now();
  const row = await loadValid(c.env, id, token, now);
  if (!row) return page(c, 410, 'Link not valid', `<p>${INVALID}</p>${backLink}`);
  if (row.user_id !== user.id) return page(c, 403, 'Not your link', '<p>Only the person who asked for this can confirm it.</p>');
  const reg = registry.get(row.action);
  if (!reg) return page(c, 400, 'Unknown action', '<p>This action is no longer available.</p>');
  // Org-scoped confirmations are tenant-admin actions; the role may have changed since the start.
  if (row.org_id && (await memberRole(c.env, row.org_id, user.id)) !== 'tenant_admin') {
    return page(c, 403, 'Not allowed', '<p>You are no longer a tenant admin of this organization.</p>');
  }
  if (needsMfa(reg, row.org_id) && !session.mfa) {
    return page(c, 403, 'Second factor needed', '<p>Sign in with a passkey or a second factor, then open the link again.</p>');
  }

  // Single use: the claim is atomic, so a double submit runs the handler once.
  const claimed = await c.env.DB.prepare(
    'UPDATE confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? AND token_hash = ? AND user_id = ? RETURNING id',
  )
    .bind(now, row.id, now, row.token_hash, user.id)
    .first();
  if (!claimed) return page(c, 410, 'Link not valid', `<p>${INVALID}</p>${backLink}`);

  // Collected before the handler runs: org deletion removes the memberships (D30 notification).
  const others = row.org_id ? (await tenantAdminIds(c.env, row.org_id)).filter((u) => u !== user.id) : [];
  const { payload, summary } = await readPayload(c.env, row);
  await reg.handler(c.env, executionCtx(c), { userId: user.id, orgId: row.org_id, target: row.target, payload });

  await auditPlatform(c.env, { actorId: user.id, actorRole: 'user', action: 'confirmation.completed', targetType: 'confirmation', targetId: row.id, details: { action: row.action } });
  if (row.org_id) {
    const orgStillThere = await c.env.DB.prepare('SELECT 1 FROM org_settings WHERE org_id = ?').bind(row.org_id).first();
    if (orgStillThere) {
      await auditOrg(c.env, row.org_id, { actorId: user.id, actorScope: 'tenant', action: 'confirmation.completed', targetType: 'confirmation', targetId: row.id, details: { action: row.action, target: row.target } });
    }
  }
  if (others.length > 0) {
    await notifyUsers(c.env, others, `${reg.label}: confirmed`, `A tenant admin of your organization confirmed this action:\n\n${summary}`);
  }
  return page(c, 200, 'Done', `<p>${esc(reg.label)}: confirmed.</p>${backLink}`);
});
