// Newsletter routes for signed-in people (D70): /api/me/newsletter (the account page's card) and
// /api/platform/newsletter (counts and recent issues for platform staff, 'newsletter.view').
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { requireCap, requireSignedIn } from '../tenancy/roles';
import { actor, parseBody } from '../tenancy/util';
import { myNewsletter, newsletterOverview, RELEASE_PREFS, setMyNewsletter } from './core';

export const meNewsletterApp = new Hono<AppContext>();

/** The signed-in person's subscription, by their account address. */
meNewsletterApp.get('/', requireSignedIn, async (c) => {
  const { user } = actor(c);
  return c.json(await myNewsletter(c.env, user.email));
});

/** Subscribe or change (no double opt-in: the address is the verified account address); all off unsubscribes. */
meNewsletterApp.put('/', requireSignedIn, async (c) => {
  const { user } = actor(c);
  const body = await parseBody(c, z.object({ releases: z.enum(RELEASE_PREFS), product: z.boolean() }));
  return c.json(await setMyNewsletter(c.env, user.email, body));
});

export const platformNewsletterApp = new Hono<AppContext>();

platformNewsletterApp.get('/', requireCap('newsletter.view'), async (c) => c.json(await newsletterOverview(c.env)));
