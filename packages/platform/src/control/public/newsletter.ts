// Newsletter subscriptions, public side (D70), under /api/public/newsletter: the website's
// subscribe form (cross-site, CORS in public/index.ts), and the /newsletter page on the app origin
// that confirms, manages and unsubscribes with the token from a mail. Tokens travel in the URL
// fragment and are posted by the page's script: nothing changes on a GET (mail scanners prefetch
// links). The one exception is RFC 8058 one-click unsubscribe, a POST from the mail provider.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { FEEDBACK_JS, glyph, pageDocument } from '../auth/pages';
import { esc } from '../auth/email';
import {
  confirmSubscription,
  prefsView,
  RELEASE_PREFS,
  requestManageLink,
  subscribe,
  subscriberForToken,
  unsubscribe,
  updatePrefs,
} from '../newsletter/core';
import { PREF_TEXT } from '../newsletter/mails';
import { siteOf, type Site } from '../../shared/site';

export const newsletterPublicApp = new Hono<AppContext>();

const invalid = (c: Context<AppContext>) => c.json({ error: 'invalid_input' }, 400);
const badToken = (c: Context<AppContext>) => c.json({ error: 'invalid_token' }, 410);

async function json<S extends z.ZodType>(c: Context<AppContext>, schema: S): Promise<z.infer<S> | null> {
  try {
    const r = schema.safeParse(await c.req.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const prefsShape = { releases: z.enum(RELEASE_PREFS), product: z.boolean() };
/** Something must be chosen: no release mail and no product news is no subscription. */
const somethingChosen = (b: { releases: string; product: boolean }) => b.releases !== 'none' || b.product;

const subscribeSchema = z
  .object({
    email: z.email().max(254),
    ...prefsShape,
    source: z.string().regex(/^[A-Za-z0-9_.:\/-]{1,64}$/).optional(),
  })
  .refine(somethingChosen);
const tokenSchema = z.object({ token: z.string().min(1).max(200) });

/** Always 202 once the input is valid: the answer never says whether the address is known. */
newsletterPublicApp.post('/subscribe', async (c) => {
  const body = await json(c, subscribeSchema);
  if (!body) return invalid(c);
  try {
    await subscribe(c.env, { email: body.email, releases: body.releases, product: body.product, source: body.source ?? 'website' });
  } catch (err) {
    // A failed mail must not answer differently either; the log says what happened.
    console.error(JSON.stringify({ at: 'newsletter.subscribe', message: (err as Error).message }));
  }
  return c.json({ ok: true }, 202);
});

/** The double opt-in link's page posts its token here; answers with a manage token. */
newsletterPublicApp.post('/confirm', async (c) => {
  const body = await json(c, tokenSchema);
  if (!body) return invalid(c);
  const token = await confirmSubscription(c.env, body.token);
  if (!token) return badToken(c);
  return c.json({ ok: true, token });
});

newsletterPublicApp.post('/prefs', async (c) => {
  const body = await json(c, tokenSchema);
  if (!body) return invalid(c);
  const row = await subscriberForToken(c.env, body.token);
  if (!row) return badToken(c);
  return c.json(await prefsView(c.env, row));
});

newsletterPublicApp.post('/prefs/update', async (c) => {
  const body = await json(c, z.object({ ...tokenSchema.shape, ...prefsShape }).refine(somethingChosen));
  if (!body) return invalid(c);
  const row = await subscriberForToken(c.env, body.token);
  if (!row) return badToken(c);
  const updated = await updatePrefs(c.env, row, body);
  if (!updated) return c.json({ error: 'suppressed' }, 409);
  return c.json(await prefsView(c.env, updated));
});

/** Unsubscribes and revokes every link sent so far (token_version + 1). */
newsletterPublicApp.post('/unsubscribe-all', async (c) => {
  const body = await json(c, tokenSchema);
  if (!body) return invalid(c);
  const row = await subscriberForToken(c.env, body.token);
  if (!row) return badToken(c);
  await unsubscribe(c.env, row.id, { revokeLinks: true });
  return c.json({ ok: true, status: row.status === 'suppressed' ? 'suppressed' : 'unsubscribed' });
});

/** "Email me a manage link": 202 whatever the address; only active subscribers get one, once an hour. */
newsletterPublicApp.post('/link', async (c) => {
  const body = await json(c, z.object({ email: z.email().max(254) }));
  if (!body) return invalid(c);
  try {
    await requestManageLink(c.env, body.email);
  } catch (err) {
    console.error(JSON.stringify({ at: 'newsletter.link', message: (err as Error).message }));
  }
  return c.json({ ok: true }, 202);
});

/**
 * RFC 8058 one-click: the List-Unsubscribe URL. Mail providers POST `List-Unsubscribe=One-Click`
 * (form-encoded, no Origin). Idempotent: links stay valid, so a repeat still gets 200.
 */
newsletterPublicApp.post('/unsubscribe', async (c) => {
  const row = await subscriberForToken(c.env, c.req.query('t'));
  if (!row) return badToken(c);
  await unsubscribe(c.env, row.id);
  return c.json({ ok: true });
});

/** A person following the URL by hand: the manage page, on its unsubscribe step. Changes nothing. */
newsletterPublicApp.get('/unsubscribe', (c) => {
  const t = c.req.query('t') ?? '';
  return c.redirect(t ? `/newsletter#t=${encodeURIComponent(t)}&u=1` : '/newsletter', 302);
});

// ---- the /newsletter page ---------------------------------------------------------------------

export const NEWSLETTER_JS_PATH = '/newsletter/page.js';

export const newsletterPageApp = new Hono<AppContext>();

const RELEASE_CHOICES: [string, string, string][] = [
  ['major', 'Major releases', 'Only the big ones'],
  ['minor', 'Major and minor releases', 'New features; the usual choice'],
  ['micro', 'Every stable release', 'Patches and fixes too'],
  ['rc', 'Everything', 'Release candidates too, for testing ahead'],
  ['none', 'No release mail', ''],
];

export function newsletterPage(site: Site, turnstileSiteKey?: string): string {
  const radios = RELEASE_CHOICES.map(
    ([v, label, sub]) =>
      `<label class="check"><input type="radio" name="releases" value="${v}"><span class="t"><b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></label>`,
  ).join('');
  const turnstile = turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(turnstileSiteKey)}"></div>` : '';
  const body = `${glyph('mail', 'blue')}
<div class="sp-head"><h1 id="nl-title">Worca newsletter</h1><p class="sp-lead" id="nl-lead">Release mail and product news from Worca.</p></div>
<div id="nl" class="stack sp-detail">
<p id="nl-status" role="status" aria-live="polite" class="sp-status"></p>
<div id="nl-confirm" class="stack" hidden>
<p class="sp-lead">Confirm that you want release mail and news at this address.</p>
<button type="button" class="btn primary block" id="nl-confirm-go">Confirm subscription</button>
</div>
<form id="nl-prefs" class="form" hidden novalidate>
<p class="sp-lead" id="nl-who"></p>
<div class="field"><span class="label" id="nl-rel-label">Release mail</span><div class="checks" role="radiogroup" aria-labelledby="nl-rel-label">${radios}</div></div>
<div class="checks"><label class="check"><input type="checkbox" id="nl-product"><span class="t"><b>Product news</b><span>Now and then: what's new in Worca and Worca hosted</span></span></label></div>
<button type="submit" class="btn primary block" id="nl-save">Save preferences</button>
<button type="button" class="linkbtn sp-link" id="nl-unsub-open">Unsubscribe from everything</button>
</form>
<div id="nl-unsub" class="stack" hidden>
<p class="sp-lead">Stop all newsletter mail from Worca? Links in mails you already have stop working.</p>
<div class="sp-actions"><button type="button" class="btn" id="nl-unsub-cancel">Keep my subscription</button><button type="button" class="btn solid-danger" id="nl-unsub-go">Unsubscribe</button></div>
</div>
<form id="nl-link" class="form" hidden novalidate>
<p class="sp-lead">Enter the address you subscribed with, and we'll email you a link to your preferences.</p>
<div class="field"><label for="nl-email">Email</label><input class="inp" id="nl-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required></div>
${turnstile}
<button type="submit" class="btn primary block">Email me a manage link</button>
</form>
</div>`;
  return pageDocument('Newsletter', body, { scriptSrc: NEWSLETTER_JS_PATH, turnstileSiteKey, site });
}

newsletterPageApp.get('/', (c) => {
  c.header('Referrer-Policy', 'same-origin'); // the token stays on the site; no-referrer would send Origin: null with the page's POSTs
  return c.html(newsletterPage(siteOf(c.env), c.env.TURNSTILE_SECRET ? c.env.TURNSTILE_SITE_KEY : undefined));
});

newsletterPageApp.get('/page.js', (c) =>
  c.body(NEWSLETTER_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }),
);

const PREF_LABELS = JSON.stringify(PREF_TEXT);

// Same-origin, dependency-free. The token comes from the fragment (#c= confirm, #t= manage,
// &u=1 opens the unsubscribe step) and is only ever sent in POST bodies.
export const NEWSLETTER_JS = `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const root = $('nl');
  if (!root) return;
  const PREFS = ${PREF_LABELS};
  const status = $('nl-status');
  const website = document.body.dataset.website || ''; // the operator's site, where the form is (auth/pages.ts)
${FEEDBACK_JS}
  const say = (msg, kind) => showStatus(status, msg || '', kind === 'err');
  const show = (...ids) => { for (const id of ['nl-confirm', 'nl-prefs', 'nl-unsub', 'nl-link']) $(id).hidden = !ids.includes(id); };
  const hash = new URLSearchParams(location.hash.slice(1));
  let token = hash.get('t');
  async function call(path, body, extra) {
    const res = await fetch('/api/public/newsletter' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: Object.assign({ 'content-type': 'application/json' }, extra || {}),
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }
  const dead = () => {
    token = null;
    show('nl-link');
    say('This link no longer works. Ask for a new one below.', 'err');
  };
  function fill(p) {
    for (const r of document.querySelectorAll('input[name="releases"]')) r.checked = r.value === p.releases;
    $('nl-product').checked = !!p.product;
    $('nl-who').textContent = 'Preferences for ' + p.email + '.';
    if (p.status === 'unsubscribed') say('You are unsubscribed. Save your preferences to subscribe again.');
    else if (p.status === 'suppressed') say('Mail to this address bounced or was reported as spam, so Worca sends it nothing.', 'err');
    else if (p.status === 'active') say(p.releases === 'none' ? 'You get product news only.' : 'You get ' + PREFS[p.releases] + (p.product ? ', and product news.' : '.'));
    else say('');
  }
  async function loadPrefs() {
    const r = await call('/prefs', { token });
    if (!r.ok) return dead();
    fill(r.data);
    show('nl-prefs');
    if (hash.get('u') === '1') openUnsub();
  }
  function openUnsub() { show('nl-unsub'); $('nl-unsub-go').focus(); }
  $('nl-unsub-open').addEventListener('click', openUnsub);
  $('nl-unsub-cancel').addEventListener('click', () => { hash.delete('u'); show('nl-prefs'); });
  $('nl-unsub-go').addEventListener('click', async () => {
    const go = $('nl-unsub-go');
    go.disabled = true;
    const r = await call('/unsubscribe-all', { token });
    go.disabled = false;
    if (!r.ok) return dead();
    token = null;
    history.replaceState(null, '', location.pathname);
    show();
    $('nl-title').textContent = 'You are unsubscribed';
    $('nl-lead').textContent = 'Worca sends you no more newsletter mail.' + (website ? ' To subscribe again, use the form on ' + website + '.' : '');
    say('');
  });
  $('nl-prefs').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const picked = document.querySelector('input[name="releases"]:checked');
    const releases = picked ? picked.value : 'none';
    const product = $('nl-product').checked;
    if (releases === 'none' && !product) { say(''); return fieldError([...document.querySelectorAll('input[name="releases"]'), $('nl-product')], 'Choose something to receive, or unsubscribe from everything.'); }
    $('nl-save').disabled = true;
    const r = await call('/prefs/update', { token, releases, product });
    $('nl-save').disabled = false;
    if (r.status === 409) return say('Mail to this address bounced or was reported as spam, so it cannot be turned back on here.', 'err');
    if (!r.ok) return r.status === 410 ? dead() : say('Something went wrong. Try again.', 'err');
    fill(r.data);
    say('Saved. ' + status.textContent);
  });
  $('nl-link').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('nl-email').value.trim();
    if (!email || !$('nl-email').checkValidity()) { say(''); return fieldError($('nl-email'), 'Enter your email address.'); }
    const extra = {};
    const t = document.querySelector('[name="cf-turnstile-response"]');
    if (t && t.value) extra['x-turnstile-token'] = t.value;
    const r = await call('/link', { email }, extra);
    if (window.turnstile) window.turnstile.reset();
    if (r.status === 429) return say('Too many requests. Wait a few minutes and try again.', 'err');
    if (r.status === 403) return say('Complete the verification, then try again.', 'err');
    if (!r.ok) return say('Something went wrong. Try again.', 'err');
    say('If ' + email + ' is subscribed, a link to its preferences is on its way.');
  });
  (async () => {
    const c = hash.get('c');
    if (c) {
      // A click, not page load, confirms: mail scanners open links too.
      show('nl-confirm');
      $('nl-confirm-go').focus();
      $('nl-confirm-go').addEventListener('click', async () => {
        $('nl-confirm-go').disabled = true;
        say('Confirming your subscription…');
        const r = await call('/confirm', { token: c });
        if (!r.ok) {
          $('nl-confirm-go').disabled = false;
          show('nl-link');
          return say('This confirmation link has expired. ' + (website ? 'Subscribe again on ' + website + ', or ask' : 'Ask') + ' for a link to your preferences below.', 'err');
        }
        token = r.data.token;
        history.replaceState(null, '', location.pathname + '#t=' + encodeURIComponent(token));
        $('nl-title').textContent = 'You are subscribed';
        await loadPrefs();
      });
      return;
    }
    if (token) return loadPrefs();
    show('nl-link');
  })().catch(() => say('Something went wrong. Reload the page and try again.', 'err'));
})();
`;
