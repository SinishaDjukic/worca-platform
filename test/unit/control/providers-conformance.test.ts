// The compute provider conformance checks (src/testing/compute-conformance.ts) against the built-in
// providers: railway over a simulated Railway API, fake over a simulated stub server. A provider a
// deployment adds runs the same checks (docs/providers.md). Also: the registry and definePlatform.
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { computeDefinition, computeInfo, computeProviderNames, computeRegion, getProviders, serviceHost, tunnelOrigins } from '../../../packages/platform/src/control/providers';
import { createFakeCompute, fakeCompute } from '../../../packages/platform/src/control/providers/fake';
import { resourcePrefix } from '../../../packages/platform/src/control/providers/prefix';
import { createRailwayProvider, railwayCompute } from '../../../packages/platform/src/control/providers/railway';
import type { ComputeProviderDefinition } from '../../../packages/platform/src/control/providers/types';
import { problemSource } from '../../../packages/platform/src/control/instances/progress';
import { definePlatform, resetPlatform } from '../../../packages/platform/src/shared/platform';
import { computeProviderChecks } from '../../../packages/platform/src/testing/compute-conformance';
import { railwaySim, stubSim } from './fixtures/railway-sim';

const PREFIX = 'conf-';
const railwayEnv = { RAILWAY_TOKEN: 'rw-token', RAILWAY_WORKSPACE_ID: 'ws-1', RESOURCE_PREFIX: PREFIX } as unknown as Env;

describe('conformance: railway (simulated API)', () => {
  const sim = railwaySim();
  const checks = computeProviderChecks({
    definition: railwayCompute,
    prefix: PREFIX,
    provider: () => createRailwayProvider(railwayEnv, sim.fetchImpl, { sleep: async () => {}, stopPollMs: 0, resourcePrefix: PREFIX }),
  });
  for (const check of checks) it(check.name, check.run);
});

describe('conformance: fake (simulated stub)', () => {
  const stub = stubSim();
  const checks = computeProviderChecks({
    definition: fakeCompute,
    prefix: PREFIX,
    provider: () => createFakeCompute({ STUB_ADMIN_URL: 'http://stub.test' } as Env, stub.fetchImpl),
  });
  for (const check of checks) it(check.name, check.run);
});

describe('conformance checks catch a broken provider', () => {
  it('a createProject that makes a second project on retry fails its check', async () => {
    const stub = stubSim();
    const broken = () => {
      const p = createFakeCompute({ STUB_ADMIN_URL: 'http://stub.test' } as Env, stub.fetchImpl);
      let n = 0;
      return { ...p, createProject: async (spec: Parameters<typeof p.createProject>[0]) => ({ ...(await p.createProject(spec)), projectId: `${spec.instanceId}-${++n}` }) };
    };
    const check = computeProviderChecks({ definition: fakeCompute, prefix: PREFIX, provider: broken }).find((c) => c.name.startsWith('createProject is safe to retry'))!;
    await expect(check.run()).rejects.toThrow('conformance: a retried createProject returns the same project');
  });
});

describe('provider registry', () => {
  afterEach(() => resetPlatform());

  const minimal = {
    name: 'acme',
    environments: { prod: { appOrigin: 'https://app.example.com', instanceDomain: 'example.net' } },
    mail: { from: 'Acme <no-reply@example.com>' },
  };
  /** A provider a deployment brings: the fake under another name and description. */
  const custom: ComputeProviderDefinition = {
    ...fakeCompute,
    info: { ...fakeCompute.info, displayName: 'Kubernetes', defaultRegion: 'eu-central', serviceHost: (prefix, kind) => `${prefix}${kind}.ns.svc.cluster.local` },
  };

  it('built in: railway and fake; unknown names are refused', () => {
    expect(computeDefinition('railway')).toBe(railwayCompute);
    expect(computeDefinition('fake')).toBe(fakeCompute);
    expect(() => computeDefinition('k8s')).toThrow('unknown COMPUTE_PROVIDER: k8s');
    expect(computeProviderNames()).toEqual(['railway', 'fake']);
  });

  it('definePlatform registers more by name; COMPUTE_PROVIDER picks one', () => {
    definePlatform(minimal, { providers: { compute: { k8s: custom } } });
    const env = { COMPUTE_PROVIDER: 'k8s', EDGE_PROVIDER: 'fake', RESOURCE_PREFIX: 'acme-' } as unknown as Env;
    expect(computeInfo(env).displayName).toBe('Kubernetes');
    expect(computeRegion(env)).toBe('eu-central');
    expect(computeRegion({ ...env, COMPUTE_REGION: 'eu-west' })).toBe('eu-west');
    expect(serviceHost(env, 'broker')).toBe('acme-broker.ns.svc.cluster.local');
    expect(tunnelOrigins(env)).toEqual({ worca: 'http://acme-worca.ns.svc.cluster.local:4317', keyPage: 'http://acme-broker.ns.svc.cluster.local:8081' });
    expect(getProviders(env).compute.name).toBe('fake'); // it is the fake underneath
    expect(computeProviderNames()).toEqual(['railway', 'fake', 'k8s']);
    expect(problemSource('k8s: pod quota exceeded')).toBe('compute');
  });

  it('built-in names and odd names can not be registered', () => {
    expect(() => definePlatform(minimal, { providers: { compute: { railway: custom } } })).toThrow('built-in');
    expect(() => definePlatform(minimal, { providers: { compute: { 'K8S!': custom } } })).toThrow('lowercase');
  });

  it('Railway: EU region by default, its sizes, three services of a 100 per workspace', () => {
    const env = { COMPUTE_PROVIDER: 'railway', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;
    expect(computeRegion(env)).toBe('europe-west4');
    expect(computeInfo(env).sizes.map((s) => s.id)).toEqual(['standard', 'large', 'xl']);
    expect(computeInfo(env).capacity).toEqual({ unit: 'services', perInstance: 3, limit: 100 });
    expect(tunnelOrigins(env)).toEqual({ worca: 'http://worca-run-worca.railway.internal:4317', keyPage: 'http://worca-run-broker.railway.internal:8081' });
  });

  it('the resource prefix: from RESOURCE_PREFIX, checked, worca- without it', () => {
    expect(resourcePrefix({ RESOURCE_PREFIX: 'worca-run-' })).toBe('worca-run-');
    expect(resourcePrefix({})).toBe('worca-');
    expect(() => resourcePrefix({ RESOURCE_PREFIX: 'Worca' })).toThrow('RESOURCE_PREFIX');
    expect(() => resourcePrefix({ RESOURCE_PREFIX: 'a-very-long-prefix-name-' })).toThrow('at most 20');
  });
});
