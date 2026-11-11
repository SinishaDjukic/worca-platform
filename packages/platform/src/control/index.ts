import { Hono } from 'hono';
import { withRequestScope } from './auth';
import type { AppContext, Env } from './env';
import { globalMiddleware } from './auth/middleware';
import { authApp } from './auth/routes';
import { tenantApp } from './tenancy/routes';
import { platformApp } from './tenancy/platform-routes';
import { meApp } from './tenancy/me-routes';
import { confirmApp } from './tenancy/confirmations';
import { instancesApp, heartbeatApp } from './instances/routes';
import { identityApp } from './identity/routes';
import { runCrons } from './instances/crons';
import { platformOpsApp } from './instances/platform-ops-routes';
import { systemApp } from './system/routes';
import { webhooksApp } from './system/resend-webhook';
import { keysPlatformApp } from './keys-routes';
import { publicApp } from './public';
import { accessRequestPageApp } from './public/access-requests';
import { newsletterPageApp } from './public/newsletter';
import { hooksApp } from './newsletter/hooks';
import { platformNewsletterApp } from './newsletter/routes';
import { uiApp } from './ui';

export { ControlRpc } from './rpc';

/**
 * A 4xx answer for an error thrown by a route, or null for a server error. Hono's HTTPException
 * has a numeric `status` and the code as its message; Better Auth's APIError (server-side auth.api
 * calls) has a string `status`, the number in `statusCode` and its code in `body.code`.
 */
export function clientError(err: Error): { status: number; code: string } | null {
  const e = err as { status?: unknown; statusCode?: unknown; body?: { code?: unknown } };
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (!status || status < 400 || status >= 500) return null;
  if (typeof e.status === 'number') return { status, code: err.message };
  return { status, code: typeof e.body?.code === 'string' ? e.body.code.toLowerCase() : 'request_refused' };
}
export { InstanceOpsWorkflow } from './instances/workflow';
export { KeyRotationWorkflow } from './keys-workflow';
export { NewsletterSendWorkflow } from './newsletter/workflow';

const app = new Hono<AppContext>();

for (const mw of globalMiddleware) app.use('*', mw);

app.get('/health', async (c) => {
  await c.env.DB.prepare('select 1').first();
  return c.json({ ok: true, environment: c.env.ENVIRONMENT });
});

app.route('/', authApp); // /api/auth/*, /sign-in, /api/setup, registration
app.route('/', identityApp); // /authorize, /.well-known/jwks.json
app.route('/api/heartbeat', heartbeatApp);
app.route('/api/me', meApp);
app.route('/api/platform/system', systemApp); // P12, P13
app.route('/api/platform/newsletter', platformNewsletterApp); // D70
app.route('/api/platform', platformOpsApp); // /api/platform/ops (P2, P6)
app.route('/api/platform', platformApp);
app.route('/api/platform', keysPlatformApp); // /api/platform/keys/* (D37 master rotation)
app.route('/api/webhooks', webhooksApp); // /api/webhooks/resend (S2)
app.route('/api/orgs', tenantApp);
app.route('/api/orgs', instancesApp); // /api/orgs/:orgId/instances...
app.route('/confirm', confirmApp); // D30 emailed links
app.route('/api/public', publicApp); // website forms: access requests, newsletter
app.route('/', accessRequestPageApp); // /access-request: the access-request confirmation page (D69)
app.route('/api/hooks', hooksApp); // /api/hooks/release (D70)
app.route('/newsletter', newsletterPageApp); // the newsletter's manage page (D70)
app.route('/', uiApp); // the web UI: /assets/* and the app shell for every other GET (last)

app.onError((err, c) => {
  console.error(JSON.stringify({ at: 'onError', path: c.req.path, message: err.message, stack: err.stack }));
  const refused = clientError(err);
  if (refused) return c.json({ error: refused.code }, refused.status as 400);
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return withRequestScope(() => app.fetch(req, env, ctx));
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCrons(controller, env, ctx));
  },
} satisfies ExportedHandler<Env>;
