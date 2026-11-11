// OWNER: agent:identity. GET /authorize (architecture.md "Signing in to an instance", steps 3-4)
// and GET /.well-known/jwks.json. Rate limits are applied globally (auth/middleware.ts).
import { Hono, type Context } from 'hono';
import { GATE_PATHS } from '../../shared/contracts';
import type { AppContext, Env } from '../env';
import { createGateCode } from './codes';
import { deps, type AccessResult } from './deps';
import { getJwks } from './tokens';
import { messagePage, type GlyphColor, type IconName } from '../auth/pages';
import { siteOf } from '../../shared/site';

export const identityApp = new Hono<AppContext>();

identityApp.get('/.well-known/jwks.json', (c) => {
  // Short cache: a rotated-in key must reach worca within minutes (tokens live 5 minutes).
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(getJwks(c.env));
});

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidHost(env: Env, host: string): boolean {
  return host.length <= 253 && HOST_RE.test(host) && host.endsWith(`.${env.INSTANCE_DOMAIN}`);
}

/** A same-origin path: '/' first, not '//' or '/\' (protocol-relative), no control characters. */
export function isSafeReturnPath(path: string): boolean {
  if (path.length === 0 || path.length > 2048) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  return !/[\u0000-\u001f\u007f\\]/.test(path);
}

/** An answer page in the app's look (auth/pages.ts): no access, not found, malformed link. */
function page(c: Context<AppContext>, status: 400 | 403 | 404, title: string, text: string) {
  c.header('Cache-Control', 'no-store');
  const icon: [IconName, GlyphColor] = status === 403 ? ['lock', 'amber'] : ['alert', 'slate'];
  return c.html(messagePage(title, text, { href: '/', label: 'Go to Worca' }, { glyph: icon, site: siteOf(c.env) }), status);
}

function signInRedirect(c: Context<AppContext>, methods?: string[]) {
  const here = new URL(c.req.url);
  const q = new URLSearchParams({ next: here.pathname + here.search });
  if (methods?.length) q.set('methods', methods.join(','));
  c.header('Cache-Control', 'no-store');
  return c.redirect(`/sign-in?${q}`, 302);
}

const DENIED: Record<Exclude<Extract<AccessResult, { ok: false }>['reason'], 'not_found' | 'policy_method'>, string> = {
  not_member: 'You are not a member of the organization that owns this instance. Ask one of its admins to invite you.',
  no_team: 'None of your teams has access to this instance. Ask an admin of your organization to add you to a team that does.',
  policy_domain: "Your organization's login policy requires an email address from another domain for this instance.",
  disabled: 'Access to this instance is disabled for your account or organization.',
};

identityApp.get('/authorize', async (c) => {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) return signInRedirect(c);
  if (user.status !== 'active') return page(c, 403, 'Account not active', 'Your account is not active yet, so it cannot open instances.');

  const host = (c.req.query('host') ?? '').toLowerCase();
  const state = c.req.query('state') ?? '';
  const ret = c.req.query('return') ?? '/';
  if (!isValidHost(c.env, host) || !STATE_RE.test(state) || !isSafeReturnPath(ret)) {
    return page(c, 400, 'Invalid sign-in link', 'This sign-in link is malformed. Open the instance address again.');
  }

  const instance = await deps().findInstanceByHost(c.env, host);
  if (!instance) return page(c, 404, 'Instance not found', 'There is no instance at this address.');

  const access = await deps().checkInstanceAccess(c.env, { userId: user.id, sessionMethod: session.method, ssoOrgId: session.ssoOrgId, instanceId: instance.id });
  if (!access.ok) {
    if (access.reason === 'not_found') return page(c, 404, 'Instance not found', 'There is no instance at this address.');
    // D23: the instance demands another sign-in method than this session used.
    if (access.reason === 'policy_method') return signInRedirect(c, access.requiredMethods);
    return page(c, 403, 'No access to this instance', DENIED[access.reason]);
  }

  const code = await createGateCode(c.env, { host, userId: user.id, sessionId: session.id, instanceId: instance.id });
  const q = new URLSearchParams({ code, state, return: ret });
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer'); // keep the code out of Referer headers
  return c.redirect(`${c.env.INSTANCE_SCHEME}://${host}${c.env.INSTANCE_ORIGIN_SUFFIX}${GATE_PATHS.callback}?${q}`, 302);
});
