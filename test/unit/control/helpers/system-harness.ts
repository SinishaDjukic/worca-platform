// Harness for the system page and webhook tests: a signed-in user comes from a test header.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import type { AppContext, Env } from '../../../../packages/platform/src/control/env';
import { systemApp } from '../../../../packages/platform/src/control/system/routes';
import { webhooksApp } from '../../../../packages/platform/src/control/system/resend-webhook';

export const testEnv = env as unknown as Env;

/** testEnv with some vars replaced; bindings are kept. */
export const envWith = (over: Partial<Env>): Env => ({ ...testEnv, ...over }) as Env;

export async function staffUser(role: 'support' | 'admin' | 'superadmin' | null): Promise<string> {
  const id = crypto.randomUUID();
  if (role) await testEnv.DB.prepare('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, NULL, ?)').bind(id, role, Date.now()).run();
  return id;
}

export function systemHarness() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user');
    c.set('requestId', 'test');
    c.set('user', id ? { id, email: 'x@example.com', name: 'x', status: 'active' } : null);
    c.set(
      'session',
      id ? { id: 's', userId: id, method: 'passkey', mfa: c.req.header('x-test-mfa') !== '0', ssoOrgId: null, expiresAt: Date.now() + 3_600_000, activeOrganizationId: null } : null,
    );
    await next();
  });
  app.route('/api/platform/system', systemApp);
  app.route('/api/webhooks', webhooksApp);
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: err.message }, status as 400);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });
  return (path: string, init: RequestInit & { user?: string; mfa?: boolean; env?: Env } = {}) => {
    const headers = new Headers(init.headers);
    if (init.user) headers.set('x-test-user', init.user);
    if (init.mfa === false) headers.set('x-test-mfa', '0');
    return app.request(path, { ...init, headers }, init.env ?? testEnv);
  };
}
