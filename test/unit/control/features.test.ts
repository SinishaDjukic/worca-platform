// Optional modules: the config switches, the FEATURES var, the
// routes each module owns (404 while off, served while on), the access-request digest cron, and
// tiers off as one unlimited tier.
import { createExecutionContext, createScheduledController, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import worker from '../../../packages/platform/src/control/index';
import { enabledFeatures, FEATURE_NAMES, FEATURE_ROUTES, featureOfPath, featureOn } from '../../../packages/platform/src/control/features';
import { CRON_STALE, runCrons } from '../../../packages/platform/src/control/instances/crons';
import { tierFor } from '../../../packages/platform/src/control/instances/routes';
import { orgSummary } from '../../../packages/platform/src/control/instances/summary';
import { computeSizes } from '../../../packages/platform/src/control/instances/sizes';
import { parsePlatformConfig, wranglerVars } from '../../../packages/platform/src/shared/config';
import { seedOrg } from './instances-helpers';

const E = env as unknown as Env;
const ALL_OFF = { ...E, FEATURES: '' } as Env;
const ALL_ON = { ...E, FEATURES: 'newsletter,accessRequests,tiers' } as Env;

const minimal = {
  name: 'acme',
  environments: { prod: { appOrigin: 'https://app.example.com', instanceDomain: 'example.net' } },
  mail: { from: 'Acme <no-reply@example.com>' },
};

describe('config', () => {
  it('turns every module off by default and leaves FEATURES out', () => {
    const c = parsePlatformConfig(minimal);
    expect(c.features).toEqual({ newsletter: false, accessRequests: false, tiers: false });
    expect(wranglerVars(c, 'prod').control.FEATURES).toBeUndefined();
    expect(wranglerVars(c, 'prod').gate.FEATURES).toBeUndefined();
  });

  it('lists the modules that are on, in a fixed order', () => {
    const c = parsePlatformConfig({ ...minimal, features: { tiers: true, newsletter: true } });
    expect(wranglerVars(c, 'prod').control.FEATURES).toBe('newsletter,tiers');
  });

  it('refuses an unknown module', () => {
    expect(() => parsePlatformConfig({ ...minimal, features: { billing: true } })).toThrow(/invalid platform config/);
  });
});

describe('FEATURES at runtime', () => {
  it('reads the list and ignores unknown names and blanks', () => {
    expect([...enabledFeatures({ FEATURES: ' tiers , billing,,newsletter ' })]).toEqual(['newsletter', 'tiers']);
    expect(enabledFeatures({}).size).toBe(0);
    expect(featureOn({ FEATURES: 'accessRequests' }, 'accessRequests')).toBe(true);
    expect(featureOn({ FEATURES: 'accessRequests' }, 'tiers')).toBe(false);
  });

  it('knows which module owns a path, and only its own paths', () => {
    expect(featureOfPath('/api/public/newsletter/subscribe')).toBe('newsletter');
    expect(featureOfPath('/newsletter')).toBe('newsletter');
    expect(featureOfPath('/newsletters')).toBeNull();
    expect(featureOfPath('/access-request.js')).toBe('accessRequests');
    expect(featureOfPath('/api/platform/access-requests/abc/grant')).toBe('accessRequests');
    expect(featureOfPath('/api/platform/orgs/o1/tier')).toBe('tiers');
    expect(featureOfPath('/api/platform/orgs/o1')).toBeNull();
    expect(featureOfPath('/api/platform/tiers/team')).toBe('tiers');
    expect(featureOfPath('/api/platform/registration/codes')).toBeNull(); // registration codes stay
    expect(Object.keys(FEATURE_ROUTES)).toEqual([...FEATURE_NAMES]);
  });
});

const fetchAs = (e: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${E.APP_ORIGIN}${path}`, { ...init, headers: { origin: E.APP_ORIGIN, ...(init.headers ?? {}) } }), e, createExecutionContext());

const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
// Every module's routes, as a request a client would send.
const ROUTES: [string, string, RequestInit?][] = [
  ['newsletter', '/api/platform/newsletter'],
  ['newsletter', '/api/me/newsletter'],
  ['newsletter', '/api/public/newsletter/subscribe', json],
  ['newsletter', '/newsletter'],
  ['newsletter', '/api/hooks/release', json],
  ['accessRequests', '/api/public/access-requests', json],
  ['accessRequests', '/access-request'],
  ['accessRequests', '/access-request.js'],
  ['accessRequests', '/api/platform/access-requests'],
  ['tiers', '/api/platform/tiers'],
  ['tiers', '/api/platform/orgs/o1/tier', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"tier":"free"}' }],
];

describe.each(ROUTES)('%s owns %s', (name, path, init) => {
  it('is 404 while the module is off', async () => {
    const res = await fetchAs({ ...ALL_ON, FEATURES: FEATURE_NAMES.filter((f) => f !== name).join(',') } as Env, path, init);
    expect(res.status).toBe(404);
    if (path.startsWith('/api/')) expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('is served while the module is on', async () => {
    const res = await fetchAs({ ...ALL_ON, RELEASE_HOOK_SECRET: 'secret' } as Env, path, init);
    expect(res.status).not.toBe(404);
  });
});

describe('the access-request digest', () => {
  async function pendingRequest(): Promise<string> {
    const id = crypto.randomUUID();
    await E.DB.prepare(`INSERT INTO access_requests (id, source, status, created_at) VALUES (?, 'test', 'pending', ?)`).bind(id, Date.now()).run();
    return id;
  }
  const notifiedAt = (id: string) => E.DB.prepare('SELECT notified_at AS n FROM access_requests WHERE id = ?').bind(id).first<{ n: number | null }>();

  it('is not sent while access requests are off', async () => {
    const id = await pendingRequest();
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime: Date.UTC(2035, 0, 1, 10, 5) }), ALL_OFF, createExecutionContext());
    expect((await notifiedAt(id))?.n).toBeNull();
    await E.DB.prepare('DELETE FROM access_requests WHERE id = ?').bind(id).run();
  });

  it('is sent while they are on', async () => {
    const id = await pendingRequest();
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime: Date.UTC(2035, 0, 1, 12, 5) }), ALL_ON, createExecutionContext());
    expect((await notifiedAt(id))?.n).not.toBeNull();
  });
});

describe('tiers', () => {
  it('off: one unlimited tier with every size, and no member limit', async () => {
    const o = await seedOrg();
    const sizes = computeSizes(ALL_OFF);
    expect(await tierFor(ALL_OFF, o.orgId)).toEqual({ instancesPerOrg: null, volumeGb: 10, sizes: sizes.all.map((s) => s.id), defaultSize: sizes.defaultId });
    const sum = await orgSummary(ALL_OFF, o.orgId);
    expect(sum.instances.limit).toBeNull();
    expect(sum.members.limit).toBeNull();
  });

  it('on: the org gets its tier from the database', async () => {
    const o = await seedOrg();
    const t = await tierFor(ALL_ON, o.orgId);
    expect(t.instancesPerOrg).toBeTypeOf('number');
    const sum = await orgSummary(ALL_ON, o.orgId);
    expect(sum.members.limit).toBeTypeOf('number');
  });
});
