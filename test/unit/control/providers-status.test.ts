// P1: read-only provider health, polled by the cron and cached in KV. Fetch is stubbed throughout.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { PROVIDER_STATUS_KEY, providerStatusFor, refreshProviderStatus } from '../../../packages/platform/src/control/instances/provider-status';
import type { Providers } from '../../../packages/platform/src/control/providers';
import { CF_API, createCloudflareEdge } from '../../../packages/platform/src/control/providers/cloudflare';
import { createFakeCompute, createFakeEdge } from '../../../packages/platform/src/control/providers/fake';
import { createRailwayProvider, RAILWAY_ENDPOINT } from '../../../packages/platform/src/control/providers/railway';
import type { ComputeRef } from '../../../packages/platform/src/control/providers/types';
import { E, installFakes, seedInstance, seedOrg } from './instances-helpers';

const ref = (projectId: string): ComputeRef => ({
  projectId, environmentId: 'env', services: { worca: { serviceId: 'w' }, broker: { serviceId: 'b' }, cloudflared: { serviceId: 'c' } },
});

describe('cloudflare tunnelStatuses', () => {
  it('lists our tunnels in pages and keeps only worca-run-* names', async () => {
    const urls: string[] = [];
    const page = (n: number, total: number, result: unknown[]) =>
      Response.json({ success: true, result, result_info: { page: n, per_page: 100, total_pages: total } });
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `worca-run-${i}`, status: 'healthy' }));
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const p = Number(new URL(url).searchParams.get('page'));
      return p === 1 ? page(1, 2, many) : page(2, 2, [
        { id: 'tx', name: 'worca-run-x', status: 'down' },
        { id: 'other', name: 'someone-else', status: 'healthy' },
        { id: 'ty', name: 'worca-run-y', status: 'weird' },
      ]);
    };
    const edge = createCloudflareEdge({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env, fetchImpl);
    const out = await edge.tunnelStatuses(['tx']);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(`${CF_API}/accounts/acct/cfd_tunnel?is_deleted=false&include_prefix=worca-run-&per_page=100&page=1`);
    expect(out.tx).toBe('down');
    expect(out.t0).toBe('healthy');
    expect(out.other).toBeUndefined();
    expect(out.ty).toBeUndefined();
  });

  it('fails on an API error', async () => {
    const edge = createCloudflareEdge({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct' } as unknown as Env, async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }));
    await expect(edge.tunnelStatuses([])).rejects.toThrow(/Authentication error/);
  });
});

describe('railway deploymentStatuses', () => {
  it('one workspace query; only worca-run-* projects; services by name', async () => {
    const bodies: any[] = [];
    const si = (serviceName: string, status: string | null, deploymentStopped = false) => ({
      node: { serviceId: serviceName, serviceName, latestDeployment: status ? { status, statusUpdatedAt: '2026-10-06T10:00:00Z', deploymentStopped } : null },
    });
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toBe(RAILWAY_ENDPOINT);
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        data: {
          workspace: {
            projects: {
              edges: [
                { node: { id: 'p1', name: 'worca-run-inst-1', environments: { edges: [{ node: { id: 'e1', serviceInstances: { edges: [
                  si('worca-run-worca', 'SUCCESS'), si('worca-run-broker', 'CRASHED'), si('worca-run-cloudflared', null), si('postgres', 'SUCCESS'),
                ] } } }] } } },
                // Stopped with deploymentStop: Railway keeps SUCCESS and sets deploymentStopped.
                { node: { id: 'p3', name: 'worca-run-inst-3', environments: { edges: [{ node: { id: 'e3', serviceInstances: { edges: [
                  si('worca-run-worca', 'SUCCESS', true), si('worca-run-broker', 'CRASHED', true), si('worca-run-cloudflared', 'DEPLOYING', true),
                ] } } }] } } },
                { node: { id: 'p2', name: 'worca-01', environments: { edges: [] } } },
              ],
            },
          },
        },
      });
    };
    const compute = createRailwayProvider({ RAILWAY_TOKEN: 'r', RAILWAY_WORKSPACE_ID: 'ws', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env, fetchImpl);
    const out = await compute.deploymentStatuses([ref('p1')]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ operationName: 'workspaceStatus', variables: { workspaceId: 'ws' } });
    const at = '2026-10-06T10:00:00Z';
    expect(out).toEqual({
      p1: {
        worca: { state: 'running', status: 'SUCCESS', statusUpdatedAt: at, stopped: false },
        broker: { state: 'failed', status: 'CRASHED', statusUpdatedAt: at, stopped: true },
        cloudflared: { state: null, status: null, statusUpdatedAt: null, stopped: null },
      },
      p3: {
        worca: { state: 'stopped', status: 'SUCCESS', statusUpdatedAt: at, stopped: true },
        broker: { state: 'failed', status: 'CRASHED', statusUpdatedAt: at, stopped: true },
        // No instance yet, so deploymentStopped is true, but it is about to run.
        cloudflared: { state: 'starting', status: 'DEPLOYING', statusUpdatedAt: at, stopped: false },
      },
    });
    expect(bodies[0].query).toContain('deploymentStopped');
  });
});

describe('fake providers', () => {
  it('map the stub state and call every tunnel healthy', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const id = String(input).split('/').at(-1);
      if (id === 'gone') return new Response('', { status: 404 });
      return Response.json({ state: id === 'a' ? 'running' : 'stopped' });
    }) as typeof fetch;
    const compute = createFakeCompute(E, fetchImpl);
    expect(await compute.deploymentStatuses([ref('a'), ref('b'), ref('gone')])).toEqual({
      a: { worca: { state: 'running', status: 'SUCCESS', statusUpdatedAt: null, stopped: false }, broker: { state: 'running', status: 'SUCCESS', statusUpdatedAt: null, stopped: false }, cloudflared: { state: 'running', status: 'SUCCESS', statusUpdatedAt: null, stopped: false } },
      b: { worca: { state: 'stopped', status: 'REMOVED', statusUpdatedAt: null, stopped: true }, broker: { state: 'stopped', status: 'REMOVED', statusUpdatedAt: null, stopped: true }, cloudflared: { state: 'stopped', status: 'REMOVED', statusUpdatedAt: null, stopped: true } },
    });
    expect(await createFakeEdge(E).tunnelStatuses(['t1'])).toEqual({ t1: 'healthy' });
  });
});

describe('provider status cache', () => {
  beforeEach(async () => {
    installFakes();
    await E.KV.delete(PROVIDER_STATUS_KEY);
  });

  it('caches one poll and answers per instance; a failing provider keeps its last answer', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const seen: { refs: number; tunnels: string[] }[] = [];
    let computeDown = false;
    const providers = {
      compute: {
        async deploymentStatuses(refs: ComputeRef[]) {
          if (computeDown) throw new Error('railway workspaceStatus: rate limited');
          seen.push({ refs: refs.length, tunnels: [] });
          return Object.fromEntries(refs.map((r) => [r.projectId, { worca: { status: 'SUCCESS', statusUpdatedAt: null } }]));
        },
      },
      edge: {
        async tunnelStatuses(ids: string[]) {
          seen.push({ refs: 0, tunnels: ids });
          return Object.fromEntries(ids.map((t) => [t, 'degraded' as const]));
        },
      },
    } as unknown as Providers;

    expect(await providerStatusFor(E, i.id)).toMatchObject({ checkedAt: null, tunnel: null, services: null });
    await refreshProviderStatus(E, providers, 1000);
    expect(seen.some((s) => s.tunnels.includes(`t-${i.id}`))).toBe(true);
    expect(await providerStatusFor(E, i.id)).toEqual({
      checkedAt: 1000, tunnel: 'degraded', tunnelCheckedAt: 1000,
      services: { worca: { status: 'SUCCESS', statusUpdatedAt: null } }, servicesCheckedAt: 1000, errors: {},
    });

    computeDown = true;
    await refreshProviderStatus(E, providers, 2000);
    expect(await providerStatusFor(E, i.id)).toMatchObject({
      checkedAt: 2000, servicesCheckedAt: 1000, tunnelCheckedAt: 2000,
      services: { worca: { status: 'SUCCESS', statusUpdatedAt: null } }, errors: { compute: 'railway workspaceStatus: rate limited' },
    });
    expect(await providerStatusFor(E, 'nope')).toBeNull();
  });
});
