// The web UI (ui/): one HTML shell for every app route, plus its static files under /assets/.
// Registered last, so every API and server-rendered page route wins. The shell is only served
// to a signed-in person; anyone else goes to /sign-in first and comes back.
import { Hono } from 'hono';
import { esc } from './auth/email';
import { siteOf, websiteHost, type Site } from '../shared/site';
import type { AppContext } from './env';
import { enabledFeatures } from './features';

export const uiApp = new Hono<AppContext>();

/** Prefixes that belong to the API or to server-rendered pages; never answered with the shell. */
const NOT_UI = /^\/(api|auth|confirm|invite|newsletter|sign-in|sign-out|authorize|\.well-known|__dev|health)(\/|$)/;

uiApp.get('/assets/*', async (c) => {
  if (!c.env.ASSETS) return c.notFound();
  const res = await c.env.ASSETS.fetch(new Request(new URL(c.req.path, c.req.url)));
  if (!res.ok) return c.json({ error: 'not_found' }, 404);
  const out = new Response(res.body, res);
  // Fonts and images never change in place; scripts and styles revalidate (no build hashes).
  const immutable = /\.(woff2|png|svg|ico)$/.test(c.req.path);
  out.headers.set('cache-control', immutable ? 'public, max-age=604800' : 'no-cache');
  return out;
});

uiApp.get('*', async (c) => {
  const path = c.req.path;
  if (NOT_UI.test(path) || /\.[a-z0-9]+$/i.test(path)) return c.json({ error: 'not_found' }, 404);
  if (!c.get('user')) {
    const url = new URL(c.req.url);
    return c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  if (!c.env.ASSETS) return c.text('UI not built', 503);
  const res = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  // The security middleware adds the page CSP and no-store to text/html.
  return new Response(brandShell(await res.text(), siteOf(c.env), [...enabledFeatures(c.env)]), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
});

/**
 * The shell with this deployment's names in it: the title, and data- attributes on <body> that
 * the scripts read (ui/assets/js/core.mjs `brand`), so no deployment's hosts or addresses are
 * written into ui/.
 */
export function brandShell(html: string, site: Site, features: readonly string[] = []): string {
  const attrs: Record<string, string | null> = {
    product: site.productName,
    service: site.serviceName,
    operator: site.operatorName,
    website: websiteHost(site),
    'abuse-email': site.abuseEmail,
    'abuse-url': site.abuseUrl,
    'instance-domain': site.instanceDomain,
    // 2.4: the optional modules that are on, so the console shows only theirs (core.mjs `features`).
    features: features.join(' ') || null,
  };
  const data = Object.entries(attrs)
    .filter(([, v]) => v)
    .map(([k, v]) => ` data-${k}="${esc(v as string)}"`)
    .join('');
  return html.replace(/<title>[^<]*<\/title>/, `<title>${esc(site.productName)}</title>`).replace('<body>', `<body${data}>`);
}
