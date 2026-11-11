// Optional modules: which ones this deployment turned on, from the
// FEATURES var its config generates (src/shared/config.ts), and the routes each one owns. A module
// that is off answers 404 on all of them, before any of its handlers run; its crons that send mail
// don't run (instances/crons.ts), and the console hides it (core.mjs `features`, from ui.ts).
import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env } from './env';
import { FEATURE_NAMES, type FeatureName } from '../shared/config';

export { FEATURE_NAMES, type FeatureName };

/** The modules that are on: FEATURES is a comma-separated list of names; unknown names are ignored. */
export function enabledFeatures(env: Pick<Env, 'FEATURES'>): Set<FeatureName> {
  const names = (env.FEATURES ?? '').split(',').map((s) => s.trim());
  return new Set(FEATURE_NAMES.filter((f) => names.includes(f)));
}

export const featureOn = (env: Pick<Env, 'FEATURES'>, name: FeatureName): boolean => enabledFeatures(env).has(name);

/**
 * The paths each module owns: a path given here and everything below it. Kept in one table so a
 * new route of a module is switched with it by adding it here, and the test can list them.
 */
export const FEATURE_ROUTES: Record<FeatureName, readonly (string | RegExp)[]> = {
  newsletter: [
    '/api/platform/newsletter', // the console's overview (D70)
    '/api/me/newsletter', // the account page's card
    '/api/public/newsletter', // the website's subscribe form and the manage page's calls
    '/newsletter', // the manage page
    '/api/hooks/release', // worca-cc's release announcement, which queues a newsletter issue
  ],
  accessRequests: [
    '/api/public/access-requests', // the website's form and its confirmation (D69)
    '/access-request', // the confirmation page
    '/access-request.js',
    '/api/platform/access-requests', // the superadmins' review
  ],
  tiers: [
    '/api/platform/tiers', // list and edit tiers (D33, D78)
    /^\/api\/platform\/orgs\/[^/]+\/tier$/, // move an org to another tier
  ],
};

function owns(rule: string | RegExp, path: string): boolean {
  if (typeof rule !== 'string') return rule.test(path);
  return path === rule || path.startsWith(`${rule}/`);
}

/** The module that owns `path`, or null. */
export function featureOfPath(path: string): FeatureName | null {
  for (const name of FEATURE_NAMES) if (FEATURE_ROUTES[name].some((r) => owns(r, path))) return name;
  return null;
}

/** 404 for every route of a module that is off: JSON under /api, the plain not-found page elsewhere. */
export const featureGate: MiddlewareHandler<AppContext> = async (c, next) => {
  const name = featureOfPath(c.req.path);
  if (name && !featureOn(c.env, name)) {
    return c.req.path.startsWith('/api/') ? c.json({ error: 'not_found' }, 404) : c.text('Not found', 404);
  }
  await next();
};
