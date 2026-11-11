// System page API (P12, P13), mounted at /api/platform/system. Read-only; platform.view.
import { Hono } from 'hono';
import type { AppContext } from '../env';
import { requireCap } from '../tenancy/roles';
import { mailOverview } from './mail';
import { providersReport } from './providers';

export const systemApp = new Hono<AppContext>();

systemApp.get('/mail', requireCap('platform.view'), async (c) => c.json(await mailOverview(c.env)));

systemApp.get('/providers', requireCap('platform.view'), async (c) => c.json(await providersReport(c.env)));
