import { describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import {
  RAILWAY_ENDPOINT,
  createRailwayProvider,
  deploymentIsStopped,
  deploymentRegion,
  parseLimits,
  railwayPrivateHost,
  railwayVariables,
  STOP_CONFIRM_POLL_MS,
} from '../../../packages/platform/src/control/providers/railway';
import { rotatedVariables } from '../../../packages/platform/src/control/providers/instance-env';
import type { ComputeRef, InstanceSpec, InstanceVariables } from '../../../packages/platform/src/control/providers/types';
import responses from './fixtures/providers/railway-responses.json';
import errorBody from './fixtures/providers/railway-error.json';

const env = { RAILWAY_TOKEN: 'rw-token', RAILWAY_WORKSPACE_ID: 'ws-1', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;

const spec: InstanceSpec = {
  instanceId: 'inst-1',
  orgId: 'org-1',
  host: 'k7m2qz9xwp.worca.run',
  keyHost: 'p3n8vt6rcd.worca.run',
  region: 'europe-west4',
  cpu: 2,
  memoryMb: 4096,
  volumeGb: 10,
  image: { worca: 'ghcr.io/worca/worca:1.8.0', broker: 'ghcr.io/worca/broker:1.8.0', cloudflared: 'cloudflare/cloudflared:2026.9.0' },
};

const vars: InstanceVariables = {
  tunnelToken: 'tun-tok',
  allowedHosts: spec.host,
  identityIssuer: 'https://app.worca.dev',
  identityAudience: spec.host,
  keyPageAudience: spec.keyHost,
  heartbeatUrl: 'https://app.worca.dev/api/heartbeat',
  heartbeatCredential: 'hb-secret',
  egress: { mode: 'block', allow: 'app.worca.dev', deny: '.pastebin.com,evil.example' },
  brokerSecret: 'b'.repeat(43),
  brokerVaultKey: 'dmF1bHQta2V5LTMyLWJ5dGVzLWxvbmctZXhhY3RseSE=',
  instanceUrl: 'https://k7m2qz9xwp.worca.run',
  keyPageUrl: 'https://p3n8vt6rcd.worca.run',
  size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 },
  terminalRemote: false,
  actionsRemote: false,
};

const ref: ComputeRef = {
  projectId: 'proj-1',
  environmentId: 'env-1',
  services: { worca: { serviceId: 'svc-worca' }, broker: { serviceId: 'svc-broker' }, cloudflared: { serviceId: 'svc-cloudflared' } },
};

interface Call {
  url: string;
  init: RequestInit;
  op: string;
  query: string;
  variables: Record<string, any>;
}

/**
 * Fake Railway: answers by GraphQL operation name from the fixtures; overrides win. It keeps what
 * was created (projects, services, volumes), so the lookups that make createProject safe to retry
 * see it. An override gets `answer()`, the default answer, to fake "done at Railway, then failed".
 */
function fakeRailway(overrides: Record<string, (call: Call, answer: () => Response) => Response> = {}) {
  const calls: Call[] = [];
  const guards: Call[] = []; // read-only lookups (ownership, existing resources), kept apart from the mutations
  const world = {
    projects: [] as { id: string; name: string; deletedAt: string | null }[],
    services: [] as { id: string; name: string }[],
    volumes: [] as { serviceId: string; mountPath: string }[],
  };
  let serviceCount = 0;
  const LOOKUPS = new Set(['projectName', 'workspaceProjects', 'projectLayout']);
  const answer = (call: Call): Response => {
    const input = call.variables.input;
    switch (call.op) {
      case 'workspaceProjects':
        return Response.json({ data: { workspace: { projects: { edges: world.projects.map((node) => ({ node })) } } } });
      case 'projectCreate':
        world.projects.push({ id: 'proj-1', name: input.name, deletedAt: null });
        return Response.json(responses.projectCreate);
      case 'projectLayout': {
        const p = world.projects.find((x) => x.id === call.variables.id);
        if (!p) return Response.json({ data: { project: null } });
        return Response.json({
          data: {
            project: {
              id: p.id,
              name: p.name,
              environments: { edges: [{ node: { id: 'env-1', volumeInstances: { edges: world.volumes.map((node) => ({ node })) } } }] },
              services: { edges: world.services.map((node) => ({ node })) },
            },
          },
        });
      }
      case 'serviceCreate': {
        serviceCount++;
        world.services.push({ id: `svc-${serviceCount}`, name: input.name });
        return Response.json({ data: { serviceCreate: { id: `svc-${serviceCount}`, name: input.name } } });
      }
      case 'volumeCreate':
        world.volumes.push({ serviceId: input.serviceId, mountPath: input.mountPath });
        return Response.json(responses.volumeCreate);
      case 'deploymentStates': // everything already stopped, unless a test says otherwise
        return Response.json(projectStates(Object.fromEntries(Object.values(ref.services).map((s) => [s.serviceId, { id: 'dep-latest', status: 'SUCCESS', deploymentStopped: true }]))));
    }
    const fixture = (responses as Record<string, unknown>)[call.op];
    if (!fixture) throw new Error(`unexpected operation ${call.op}`);
    return Response.json(fixture);
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const call: Call = { url, init, op: body.operationName, query: body.query, variables: body.variables };
    (LOOKUPS.has(call.op) ? guards : calls).push(call);
    if (overrides[call.op]) return overrides[call.op]!(call, () => answer(call));
    return answer(call);
  };
  return { calls, guards, world, fetchImpl, ops: () => calls.map((c) => c.op) };
}

const noSleep = { sleep: async () => {} };

/** The deploymentStates answer: one environment, each service's latest deployment. */
function projectStates(latest: Record<string, { id: string; status: string; deploymentStopped: boolean } | null>) {
  return {
    data: {
      project: {
        environments: {
          edges: [
            { node: { id: 'env-other', serviceInstances: { edges: [] } } },
            { node: { id: 'env-1', serviceInstances: { edges: Object.entries(latest).map(([serviceId, d]) => ({ node: { serviceId, latestDeployment: d } })) } } },
          ],
        },
      },
    },
  };
}

type Kind = keyof ComputeRef['services'];
interface LiveDeployment {
  id: string;
  serviceId: string;
  status: string;
  deploymentStopped: boolean;
  stopsAfterPolls: number | null;
  settlesAfterPolls: number | null; // INITIALIZING/DEPLOYING -> SUCCESS (running)
}

/**
 * Railway's deployments as they behaved against the live API (throwaway project, 2026-10-06;
 * docs/railway.md "Stopping and waking"):
 * - deploymentStop answers true at once; the deployment's status STAYS SUCCESS and, some seconds
 *   later (here: after `stopTakesPolls` deploymentStates reads), deploymentStopped turns true;
 * - deploymentStop again on a stopped deployment answers true again;
 * - deploymentStop on a CRASHED or still INITIALIZING one fails with "Deployment is not stoppable"
 *   (and the starting one goes on to run: here after `settlesAfterPolls` reads);
 * - deploymentStopped is already true while a deployment is DEPLOYING or CRASHED (no instance);
 * - deploymentRedeploy makes a new deployment (the newest, INITIALIZING) and the old one REMOVED.
 */
const IN_PROGRESS = ['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'];
function liveRailway(
  initial: Record<Kind, { status: string; deploymentStopped?: boolean }>,
  opts: { stopTakesPolls?: number; settlesAfterPolls?: number; neverStops?: Kind[] } = {},
) {
  const deployments: LiveDeployment[] = [];
  let seq = 0;
  for (const [kind, d] of Object.entries(initial) as [Kind, { status: string; deploymentStopped?: boolean }][]) {
    deployments.push({
      id: `dep-${kind}-${++seq}`, serviceId: ref.services[kind].serviceId, status: d.status,
      deploymentStopped: d.deploymentStopped ?? d.status !== 'SUCCESS', stopsAfterPolls: null,
      settlesAfterPolls: IN_PROGRESS.includes(d.status) ? (opts.settlesAfterPolls ?? 2) : null,
    });
  }
  const latest = (serviceId: string) => deployments.filter((d) => d.serviceId === serviceId).at(-1);
  const view = (d: LiveDeployment | undefined) => (d ? { id: d.id, status: d.status, deploymentStopped: d.deploymentStopped } : null);
  const neverStops = new Set((opts.neverStops ?? []).map((k) => ref.services[k].serviceId));
  const fake = fakeRailway({
    latestDeployment: (call) => {
      const d = latest(call.variables.input.serviceId);
      return Response.json({ data: { deployments: { edges: d ? [{ node: view(d) }] : [] } } });
    },
    deploymentStop: (call) => {
      const d = deployments.find((x) => x.id === call.variables.id)!;
      if (['CRASHED', 'REMOVED', 'FAILED', 'SKIPPED', ...IN_PROGRESS].includes(d.status)) return Response.json({ data: null, errors: [{ message: 'Deployment is not stoppable' }] });
      if (!d.deploymentStopped && !neverStops.has(d.serviceId)) d.stopsAfterPolls ??= opts.stopTakesPolls ?? 2;
      return Response.json({ data: { deploymentStop: true } });
    },
    deploymentStates: () => {
      for (const d of deployments) {
        if (d.settlesAfterPolls !== null && --d.settlesAfterPolls <= 0) Object.assign(d, { status: 'SUCCESS', deploymentStopped: false, settlesAfterPolls: null });
        if (d.stopsAfterPolls === null) continue;
        d.stopsAfterPolls -= 1;
        if (d.stopsAfterPolls <= 0) Object.assign(d, { deploymentStopped: true, stopsAfterPolls: null }); // status stays as it was
      }
      return Response.json(projectStates(Object.fromEntries(Object.values(ref.services).map((s) => [s.serviceId, view(latest(s.serviceId))]))));
    },
    deploymentRedeploy: (call) => {
      const old = deployments.find((x) => x.id === call.variables.id)!;
      const next: LiveDeployment = {
        id: `dep-redeployed-${++seq}`, serviceId: old.serviceId, status: 'INITIALIZING', deploymentStopped: true, stopsAfterPolls: null, settlesAfterPolls: 2,
      };
      Object.assign(old, { status: 'REMOVED', deploymentStopped: true });
      deployments.push(next);
      return Response.json({ data: { deploymentRedeploy: { id: next.id, status: next.status } } });
    },
  });
  return { ...fake, deployments, latest: (kind: Kind) => view(latest(ref.services[kind].serviceId)) };
}

describe('railway provider', () => {
  it('sends authenticated GraphQL POSTs with the operation name in the query', async () => {
    const fake = fakeRailway();
    await createRailwayProvider(env, fake.fetchImpl, noSleep).destroy(ref);
    const [call] = fake.calls;
    expect(call!.url).toBe(RAILWAY_ENDPOINT);
    expect(call!.init.method).toBe('POST');
    expect((call!.init.headers as Record<string, string>).authorization).toBe('Bearer rw-token');
    expect((call!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(call!.query).toContain('projectDelete(id: $id)');
    expect(call!.variables).toEqual({ id: 'proj-1' });
  });

  it('createProject builds a prefixed project with three services, EU region, limits and a volume', async () => {
    const fake = fakeRailway();
    const out = await createRailwayProvider(env, fake.fetchImpl, noSleep).createProject(spec);

    expect(out).toEqual({
      projectId: 'proj-1',
      environmentId: 'env-1',
      services: { worca: { serviceId: 'svc-1' }, broker: { serviceId: 'svc-2' }, cloudflared: { serviceId: 'svc-3' } },
    });
    const project = fake.calls[0]!;
    expect(project.op).toBe('projectCreate');
    expect(project.variables.input).toMatchObject({ name: 'worca-run-inst1', workspaceId: 'ws-1' });

    const creates = fake.calls.filter((c) => c.op === 'serviceCreate');
    expect(creates.map((c) => c.variables.input.name)).toEqual(['worca-run-worca', 'worca-run-broker', 'worca-run-cloudflared']);
    for (const c of creates) {
      expect(c.variables.input).toMatchObject({ projectId: 'proj-1', environmentId: 'env-1' });
      expect(c.variables.input.source).toBeUndefined(); // nothing deploys before the variables are set
    }

    const updates = fake.calls.filter((c) => c.op === 'serviceInstanceUpdate');
    // `region` is ignored by Railway (services landed in US West); multiRegionConfig places them.
    expect(updates.map((c) => c.variables.input.multiRegionConfig)).toEqual(Array(3).fill({ 'europe-west4-drams3a': { numReplicas: 1 } }));
    expect(updates.every((c) => c.variables.input.region === undefined)).toBe(true);
    expect(updates[2]!.variables.input.startCommand).toBe('cloudflared tunnel --no-autoupdate run');
    // worca's own entrypoint, with a stop's exit 143 reported as 0: Railway leaves a deployment
    // that exits non-zero after deploymentStop running for good.
    expect(updates[0]!.variables.input.startCommand).toBe('tini -s -e 143 -- worca-entrypoint worca ui');
    expect(updates[1]!.variables.input.startCommand).toBe('worca-entrypoint worca broker');
    // worca gets time to drain on SIGTERM (worca backlog B2); the others stop at once.
    expect(updates.map((c) => c.variables.input.drainingSeconds)).toEqual([60, undefined, undefined]);

    const limits = fake.calls.filter((c) => c.op === 'serviceInstanceLimitsUpdate');
    expect(limits).toHaveLength(3);
    expect(limits[0]!.variables.input).toEqual({ serviceId: 'svc-1', environmentId: 'env-1', vCPUs: 2, memoryGB: 4 });
  });

  it('createProject: worca gets the compute size, the broker and the tunnel a fixed ceiling (D78)', async () => {
    const fake = fakeRailway();
    await createRailwayProvider(env, fake.fetchImpl, noSleep).createProject({ ...spec, cpu: 8, memoryMb: 16384 });
    const limits = fake.calls.filter((c) => c.op === 'serviceInstanceLimitsUpdate').map((c) => c.variables.input);
    expect(limits.map((l) => [l.serviceId, l.vCPUs, l.memoryGB])).toEqual([
      ['svc-1', 8, 16],
      ['svc-2', 2, 4],
      ['svc-3', 2, 4],
    ]);

    // worca's data volume, and the broker's own for its encrypted key store.
    const volumes = fake.calls.filter((c) => c.op === 'volumeCreate').map((c) => c.variables.input);
    expect(volumes).toEqual(
      ['svc-1', 'svc-2'].map((serviceId) => ({ projectId: 'proj-1', environmentId: 'env-1', serviceId, mountPath: '/data', region: 'europe-west4-drams3a' })),
    );
  });

  it('keeps project names within Railway\'s 32 characters for real instance ids', async () => {
    const fake = fakeRailway();
    const instanceId = 'e958a7d8-07a0-40d0-9fe2-da6d7a5dc4da';
    await createRailwayProvider(env, fake.fetchImpl, noSleep).createProject({ ...spec, instanceId });
    const name = fake.calls[0]!.variables.input.name as string;
    expect(name).toBe('worca-run-e958a7d807a040d09fe2da');
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.startsWith('worca-run-')).toBe(true);
  });

  it('never creates a public domain', async () => {
    const fake = fakeRailway();
    const p = createRailwayProvider(env, fake.fetchImpl, noSleep);
    const created = await p.createProject(spec);
    await p.setVariables(created, vars);
    await p.deploy(created, spec.image);
    for (const c of fake.calls) expect(c.query).not.toMatch(/domain/i);
  });

  it('a retry after a half-way failure finishes the same project instead of starting another', async () => {
    let failed = false;
    const fake = fakeRailway({ volumeCreate: (_c, answer) => (failed ? answer() : ((failed = true), Response.json({ data: null, errors: [{ message: 'volume quota' }] }))) });
    const p = createRailwayProvider(env, fake.fetchImpl, noSleep);
    await expect(p.createProject(spec)).rejects.toThrow('railway volumeCreate: volume quota');
    expect(fake.ops()).not.toContain('projectDelete'); // kept for the retry (and found by name on delete)
    const out = await p.createProject(spec);
    expect(out.services).toEqual({ worca: { serviceId: 'svc-1' }, broker: { serviceId: 'svc-2' }, cloudflared: { serviceId: 'svc-3' } });
    expect(fake.ops().filter((o) => o === 'projectCreate')).toHaveLength(1);
    expect(fake.ops().filter((o) => o === 'serviceCreate')).toHaveLength(3);
    expect(fake.world.volumes.map((v) => v.serviceId)).toEqual(['svc-1', 'svc-2']);
  });

  it('projectCreate done at Railway but its answer lost: the retry finds the project by name', async () => {
    const fake = fakeRailway({ projectCreate: (_c, answer) => (answer(), new Response('gateway timeout', { status: 504 })) });
    const p = createRailwayProvider(env, fake.fetchImpl, noSleep);
    await expect(p.createProject(spec)).rejects.toThrow('railway projectCreate: HTTP 504');
    expect(fake.world.projects).toHaveLength(1);
    const out = await p.createProject(spec);
    expect(out.projectId).toBe('proj-1');
    expect(fake.world.projects).toHaveLength(1);
    expect(fake.ops().filter((o) => o === 'projectCreate')).toHaveLength(1); // only the lost one
  });

  it('serviceCreate and volumeCreate done but their answers lost: nothing is made twice', async () => {
    let svcLost = false;
    let volLost = false;
    const fake = fakeRailway({
      serviceCreate: (_c, answer) => (svcLost ? answer() : (answer(), (svcLost = true), new Response('', { status: 502 }))),
      volumeCreate: (_c, answer) => (volLost ? answer() : (answer(), (volLost = true), new Response('', { status: 502 }))),
    });
    const p = createRailwayProvider(env, fake.fetchImpl, noSleep);
    await expect(p.createProject(spec)).rejects.toThrow('HTTP 502'); // the first service
    await expect(p.createProject(spec)).rejects.toThrow('HTTP 502'); // the first volume
    const out = await p.createProject(spec);
    expect(fake.world.services.map((x) => x.name)).toEqual(['worca-run-worca', 'worca-run-broker', 'worca-run-cloudflared']);
    expect(fake.world.volumes).toEqual([{ serviceId: 'svc-1', mountPath: '/data' }, { serviceId: 'svc-2', mountPath: '/data' }]);
    expect(out.services.worca.serviceId).toBe('svc-1');
  });

  it('ignores deleted projects and other workspace projects when looking one up', async () => {
    const fake = fakeRailway();
    fake.world.projects.push({ id: 'old', name: 'worca-run-inst1', deletedAt: '2026-10-06T00:00:00Z' }, { id: 'team', name: 'worca-01', deletedAt: null });
    const p = createRailwayProvider(env, fake.fetchImpl, noSleep);
    expect(await p.findProject('inst-1')).toBeNull();
    const out = await p.createProject(spec);
    expect(out.projectId).toBe('proj-1');
    expect(await p.findProject('inst-1')).toEqual({ projectId: 'proj-1' });
  });

  it('setVariables upserts the mapped variables per service without deploying', async () => {
    const fake = fakeRailway();
    await createRailwayProvider(env, fake.fetchImpl, noSleep).setVariables(ref, vars);
    expect(fake.ops()).toEqual(Array(3).fill('variableCollectionUpsert'));
    const byService = Object.fromEntries(fake.calls.map((c) => [c.variables.input.serviceId, c.variables.input]));
    expect(byService['svc-worca']).toMatchObject({ projectId: 'proj-1', environmentId: 'env-1', skipDeploys: true });
    expect(byService['svc-worca'].variables).toEqual({
      // worca's Railway guide: listen on the IPv6 private network, keep data on the volume.
      WORCA_HOST: '::',
      PORT: '4317',
      WORCA_DATA_DIR: '/data',
      RAILWAY_RUN_UID: '0',
      // worca backlog B3, B4: opt-ins for a shared, suspendable instance.
      WORCA_AUTO_RESUME: '1',
      WORCA_AWAY_PER_PERSON: '1',
      WORCA_ALLOWED_HOSTS: 'k7m2qz9xwp.worca.run',
      WORCA_IDENTITY_ISSUER: 'https://app.worca.dev',
      WORCA_IDENTITY_AUDIENCE: 'k7m2qz9xwp.worca.run',
      WORCA_IDENTITY_JWKS_URL: 'https://app.worca.dev/.well-known/jwks.json',
      WORCA_HEARTBEAT_URL: 'https://app.worca.dev/api/heartbeat',
      WORCA_HEARTBEAT_TOKEN: 'hb-secret',
      // D73: the outbound network policy, always all three.
      WORCA_EGRESS_MODE: 'block',
      WORCA_EGRESS_ALLOW: 'app.worca.dev',
      WORCA_EGRESS_DENY: '.pastebin.com,evil.example',
      // D68: the broker in multi mode, reached over the private network, required at start.
      WORCA_BROKER_URL: 'http://worca-run-broker.railway.internal:8080',
      WORCA_BROKER_SECRET: 'b'.repeat(43),
      WORCA_BROKER_REQUIRED: '1',
      // D72: remote mode keeps the terminal and actions off; '0' is off for worca.
      WORCA_TERMINAL_REMOTE: '0',
      WORCA_ACTIONS_REMOTE: '0',
      // D78: worca's parallelism for the compute size.
      WORCA_MAX_PARALLEL: '4',
      WORCA_MAX_PARALLEL_SCRIPTS: '2',
    });
    expect(byService['svc-broker'].variables).toEqual({
      WORCA_BROKER_MODE: 'multi',
      WORCA_BROKER_HOST: '::',
      WORCA_BROKER_PORT: '8080',
      WORCA_BROKER_UI_PORT: '8081',
      WORCA_BROKER_DATA_DIR: '/data',
      PORT: '8081',
      RAILWAY_RUN_UID: '0',
      WORCA_BROKER_SECRET: 'b'.repeat(43), // the same secret worca has
      WORCA_BROKER_VAULT_KEY: 'dmF1bHQta2V5LTMyLWJ5dGVzLWxvbmctZXhhY3RseSE=',
      WORCA_BROKER_PUBLIC_URL: 'https://p3n8vt6rcd.worca.run',
      WORCA_BROKER_RETURN_URL: 'https://k7m2qz9xwp.worca.run',
      WORCA_ALLOWED_HOSTS: 'p3n8vt6rcd.worca.run',
      WORCA_IDENTITY_ISSUER: 'https://app.worca.dev',
      WORCA_IDENTITY_AUDIENCE: 'p3n8vt6rcd.worca.run',
      WORCA_IDENTITY_JWKS_URL: 'https://app.worca.dev/.well-known/jwks.json',
    });
    expect(byService['svc-cloudflared'].variables).toEqual({ TUNNEL_TOKEN: 'tun-tok' });
  });

  it('builds the JWKS URL without a double slash', () => {
    expect(railwayVariables({ ...vars, identityIssuer: 'https://app.worca.dev/' }, 'worca-run-').worca.WORCA_IDENTITY_JWKS_URL).toBe(
      'https://app.worca.dev/.well-known/jwks.json',
    );
  });

  it('deploy sets each image and returns the new deployment ids', async () => {
    const fake = fakeRailway();
    const out = await createRailwayProvider(env, fake.fetchImpl, noSleep).deploy(ref, spec.image);
    expect(fake.ops()).toEqual(Array(3).fill(['serviceInstanceUpdate', 'serviceInstanceDeployV2']).flat());
    expect(fake.calls[0]!.variables).toEqual({
      serviceId: 'svc-worca',
      environmentId: 'env-1',
      input: { source: { image: 'ghcr.io/worca/worca:1.8.0' }, startCommand: 'tini -s -e 143 -- worca-entrypoint worca ui' },
    });
    expect(fake.calls[2]!.variables.input).toEqual({ source: { image: 'ghcr.io/worca/broker:1.8.0' } }); // the broker keeps its own
    expect(fake.calls[5]!.variables).toEqual({ serviceId: 'svc-cloudflared', environmentId: 'env-1' });
    expect(out.services.broker).toEqual({ serviceId: 'svc-broker', deploymentId: 'dep-new' });
    expect(ref.services.broker.deploymentId).toBeUndefined(); // input not mutated
  });

  it('stop stops the latest deployment of every service and waits until Railway confirms (D48)', async () => {
    const live = liveRailway({ worca: { status: 'SUCCESS' }, broker: { status: 'SUCCESS' }, cloudflared: { status: 'SUCCESS' } }, { stopTakesPolls: 3 });
    const slept: number[] = [];
    await createRailwayProvider(env, live.fetchImpl, { sleep: async (ms) => void slept.push(ms) }).stop(ref);
    expect(live.ops()).toEqual([
      'deploymentStates', 'deploymentStop', 'deploymentStop', 'deploymentStop',
      'deploymentStates', 'deploymentStates', 'deploymentStates', // until deploymentStopped flips
    ]);
    expect(slept).toEqual([STOP_CONFIRM_POLL_MS, STOP_CONFIRM_POLL_MS, STOP_CONFIRM_POLL_MS]);
    expect(live.calls[0]!.query).toContain('deploymentStopped');
    expect(live.calls[0]!.variables).toEqual({ id: 'proj-1' });
    expect(live.calls.filter((c) => c.op === 'deploymentStop').map((c) => c.variables)).toEqual([
      { id: 'dep-worca-1' }, { id: 'dep-broker-2' }, { id: 'dep-cloudflared-3' },
    ]);
    // What Railway really reports afterwards: still SUCCESS, but stopped.
    expect(live.latest('cloudflared')).toEqual({ id: 'dep-cloudflared-3', status: 'SUCCESS', deploymentStopped: true });
  });

  it('stop with worca and the broker crashed (worca 1.8.0 in production) still stops cloudflared', async () => {
    const live = liveRailway({ worca: { status: 'CRASHED' }, broker: { status: 'CRASHED' }, cloudflared: { status: 'SUCCESS' } });
    await createRailwayProvider(env, live.fetchImpl, noSleep).stop(ref);
    expect(live.calls.filter((c) => c.op === 'deploymentStop').map((c) => c.variables.id)).toEqual(['dep-cloudflared-3']);
    expect(live.latest('cloudflared')?.deploymentStopped).toBe(true);
  });

  it('stop waits for a deployment that is still starting (Railway refuses to stop it), then stops it', async () => {
    const live = liveRailway({ worca: { status: 'SUCCESS' }, broker: { status: 'SUCCESS' }, cloudflared: { status: 'INITIALIZING' } }, { settlesAfterPolls: 3, stopTakesPolls: 1 });
    await createRailwayProvider(env, live.fetchImpl, noSleep).stop(ref);
    const stops = live.calls.filter((c) => c.op === 'deploymentStop').map((c) => c.variables.id);
    expect(stops).toEqual(['dep-worca-1', 'dep-broker-2', 'dep-cloudflared-3']); // cloudflared only once it ran
    expect(live.ops().indexOf('deploymentStop', 2)).toBeLessThan(live.ops().lastIndexOf('deploymentStates'));
    expect(live.latest('cloudflared')).toEqual({ id: 'dep-cloudflared-3', status: 'SUCCESS', deploymentStopped: true });
  });

  it('stop: a deployment that crashed between the read and the stop ("not stoppable") is fine', async () => {
    const live = liveRailway({ worca: { status: 'SUCCESS' }, broker: { status: 'SUCCESS' }, cloudflared: { status: 'SUCCESS' } }, { stopTakesPolls: 1 });
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.operationName === 'deploymentStop' && body.variables.id === 'dep-worca-1') live.deployments[0]!.status = 'CRASHED';
      return live.fetchImpl(url, init);
    };
    await expect(createRailwayProvider(env, fetchImpl, noSleep).stop(ref)).resolves.toBeUndefined();
    expect(live.latest('worca')?.status).toBe('CRASHED');
  });

  it('stop of services that are already stopped (a retried step) only reads', async () => {
    const live = liveRailway({ worca: { status: 'SUCCESS', deploymentStopped: true }, broker: { status: 'REMOVED' }, cloudflared: { status: 'SUCCESS', deploymentStopped: true } });
    await createRailwayProvider(env, live.fetchImpl, noSleep).stop(ref);
    expect(live.ops()).toEqual(['deploymentStates']);
  });

  it('stop throws when Railway never confirms, naming what still runs, so the step is retried', async () => {
    const live = liveRailway({ worca: { status: 'CRASHED' }, broker: { status: 'CRASHED' }, cloudflared: { status: 'SUCCESS' } }, { neverStops: ['cloudflared'] });
    const p = createRailwayProvider(env, live.fetchImpl, { ...noSleep, stopTimeoutMs: 0 });
    await expect(p.stop(ref)).rejects.toThrow('railway: not stopped yet: cloudflared dep-cloudflared-3 SUCCESS deploymentStopped=false');
    expect(live.ops()).toEqual(['deploymentStates', 'deploymentStop']);
  });

  it('stop refuses a project that is not ours before reading anything', async () => {
    const live = liveRailway({ worca: { status: 'SUCCESS' }, broker: { status: 'SUCCESS' }, cloudflared: { status: 'SUCCESS' } });
    const fetchImpl = async (url: string, init: RequestInit) =>
      JSON.parse(String(init.body)).operationName === 'projectName' ? Response.json({ data: { project: { name: 'worca-01' } } }) : live.fetchImpl(url, init);
    await expect(createRailwayProvider(env, fetchImpl, noSleep).stop(ref)).rejects.toThrow(/refusing to touch/);
    expect(live.ops()).toEqual([]);
  });

  it('stop does not take a deployment that is still starting for stopped, although deploymentStopped is true', async () => {
    expect(deploymentIsStopped({ status: 'DEPLOYING', deploymentStopped: true })).toBe(false);
    expect(deploymentIsStopped({ status: 'INITIALIZING', deploymentStopped: true })).toBe(false);
    expect(deploymentIsStopped({ status: 'SUCCESS', deploymentStopped: false })).toBe(false);
    expect(deploymentIsStopped({ status: 'SUCCESS', deploymentStopped: null })).toBe(false);
    expect(deploymentIsStopped({ status: 'SUCCESS', deploymentStopped: true })).toBe(true);
    expect(deploymentIsStopped({ status: 'CRASHED', deploymentStopped: true })).toBe(true);
    expect(deploymentIsStopped({ status: 'REMOVED', deploymentStopped: null })).toBe(true);
    expect(deploymentIsStopped(undefined)).toBe(true);
  });

  it('start redeploys the latest deployment of every service, crashed ones too (D48)', async () => {
    const live = liveRailway({ worca: { status: 'CRASHED' }, broker: { status: 'CRASHED' }, cloudflared: { status: 'SUCCESS', deploymentStopped: true } });
    const out = await createRailwayProvider(env, live.fetchImpl, noSleep).start(ref);
    expect(live.ops()).toEqual(Array(3).fill(['latestDeployment', 'deploymentRedeploy']).flat());
    expect(live.calls[1]!.variables).toEqual({ id: 'dep-worca-1', usePreviousImageTag: true });
    expect(out.services.cloudflared.deploymentId).toBe('dep-redeployed-6');
    // The new deployment is the newest: deployments(first: 1) returns it; the old one is REMOVED.
    expect(live.latest('cloudflared')).toMatchObject({ id: 'dep-redeployed-6', status: 'INITIALIZING' });
    expect(live.deployments.find((d) => d.id === 'dep-cloudflared-3')!.status).toBe('REMOVED');
  });

  it('destroy treats an already deleted project as done', async () => {
    const fake = fakeRailway({ projectDelete: () => Response.json({ data: null, errors: [{ message: 'Project not found' }] }) });
    await expect(createRailwayProvider(env, fake.fetchImpl, noSleep).destroy(ref)).resolves.toBeUndefined();
  });

  it('throws GraphQL error messages', async () => {
    const fake = fakeRailway({ projectCreate: () => Response.json(errorBody) });
    await expect(createRailwayProvider(env, fake.fetchImpl, noSleep).createProject(spec)).rejects.toThrow(
      'railway projectCreate: Not Authorized',
    );
  });

  it('throws on a non-JSON HTTP error', async () => {
    const fake = fakeRailway({ deploymentStates: () => new Response('bad gateway', { status: 502 }) });
    await expect(createRailwayProvider(env, fake.fetchImpl, noSleep).stop(ref)).rejects.toThrow('railway deploymentStates: HTTP 502');
  });

  it('retries on 429 with backoff, honouring Retry-After', async () => {
    let n = 0;
    const waits: number[] = [];
    const fake = fakeRailway({
      projectDelete: () =>
        ++n < 3
          ? new Response('slow down', { status: 429, headers: n === 1 ? { 'retry-after': '2' } : {} })
          : Response.json(responses.projectDelete),
    });
    await createRailwayProvider(env, fake.fetchImpl, { sleep: async (ms) => void waits.push(ms) }).destroy(ref);
    expect(fake.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('gives up after the retry budget', async () => {
    const fake = fakeRailway({ projectDelete: () => new Response('slow down', { status: 429 }) });
    await expect(createRailwayProvider(env, fake.fetchImpl, { ...noSleep, maxRetries: 2 }).destroy(ref)).rejects.toThrow('HTTP 429');
    expect(fake.calls).toHaveLength(3);
  });

  it('refuses to run without credentials', async () => {
    const fake = fakeRailway();
    await expect(createRailwayProvider({} as Env, fake.fetchImpl).destroy(ref)).rejects.toThrow('RAILWAY_TOKEN');
    expect(fake.calls).toHaveLength(0);
  });

  it('private hostnames follow the prefixed service names', () => {
    expect(railwayPrivateHost('worca-run-', 'worca')).toBe('worca-run-worca.railway.internal');
  });

  it('refuses to change or delete a project that is not a worca-run project', async () => {
    const foreign = () => Response.json({ data: { project: { name: 'worca-01' } } });
    const provider = (f: ReturnType<typeof fakeRailway>) => createRailwayProvider(env, f.fetchImpl, noSleep);
    for (const act of [
      (p: ReturnType<typeof provider>) => p.destroy(ref),
      (p: ReturnType<typeof provider>) => p.stop(ref),
      (p: ReturnType<typeof provider>) => p.start(ref),
      (p: ReturnType<typeof provider>) => p.setVariables(ref, vars),
      (p: ReturnType<typeof provider>) => p.deploy(ref, spec.image),
    ]) {
      const fake = fakeRailway({ projectName: foreign });
      await expect(act(provider(fake))).rejects.toThrow(/not one of ours \(worca-run-\*\)/);
      expect(fake.calls).toEqual([]); // nothing but the ownership check went out
    }
  });
});

describe('railway describe (compute facts)', () => {
  // Shaped like the live answer of 2026-10-07 for an instance created before the EU placement fix.
  const meta = (multiRegionConfig: unknown) => ({
    image: 'ghcr.io/sinishadjukic/worca:1.9.0',
    runtime: 'V2',
    volumeMounts: ['/data'],
    serviceManifest: { deploy: { multiRegionConfig, region: null, limitOverride: { containers: { cpu: 2, memoryBytes: 4_000_000_000 } } } },
  });
  const limits = { containers: { cpu: 2, memoryBytes: 4_000_000_000, pidLimit: 1000 } };
  const factsAnswer = (over: { name?: string; meta?: unknown; volumes?: unknown[]; limits?: Record<string, unknown> } = {}) =>
    Response.json({
      data: {
        project: {
          name: over.name ?? 'worca-run-1a23b4c38c8045bd8746cb',
          environments: {
            edges: [
              { node: { id: 'env-other', volumeInstances: { edges: [] }, serviceInstances: { edges: [] } } },
              {
                node: {
                  id: 'env-1',
                  volumeInstances: {
                    edges: (over.volumes ?? [
                      { serviceId: 'svc-worca', mountPath: '/data', region: 'sfo', sizeMB: 50000, currentSizeMB: 791.47 },
                      { serviceId: 'svc-broker', mountPath: '/data', region: 'sfo', sizeMB: 50000, currentSizeMB: 871.62 },
                    ]).map((node) => ({ node })),
                  },
                  serviceInstances: {
                    edges: [
                      { node: { serviceId: 'svc-cloudflared', latestDeployment: { meta: meta({ 'europe-west4-drams3a': { numReplicas: 1 } }) } } },
                      { node: { serviceId: 'svc-worca', latestDeployment: over.meta === undefined ? { meta: meta({ sfo: { numReplicas: 1 } }) } : over.meta } },
                    ],
                  },
                },
              },
            ],
          },
        },
        worca: limits,
        broker: limits,
        cloudflared: limits,
        ...over.limits,
      },
    });
  const describeWith = (answer: () => Response) => {
    const fake = fakeRailway({ computeFacts: answer });
    return { fake, facts: createRailwayProvider(env, fake.fetchImpl, noSleep).describe(ref) };
  };

  it('reads region, limits and volumes for all three services in one request', async () => {
    const { fake, facts } = describeWith(() => factsAnswer());
    expect(await facts).toEqual({
      region: 'sfo', // the worca service's deployment, not cloudflared's
      services: {
        worca: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 791 },
        broker: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 872 },
        cloudflared: { cpu: 2, memoryMb: 4000, volumeMb: null, volumeUsedMb: null },
      },
    });
    expect(fake.ops()).toEqual(['computeFacts']);
    expect(fake.guards).toEqual([]);
    const call = fake.calls[0]!;
    expect(call.variables).toEqual({ id: 'proj-1', environmentId: 'env-1', worca: 'svc-worca', broker: 'svc-broker', cloudflared: 'svc-cloudflared' });
    expect(call.query).not.toMatch(/mutation/);
    expect(call.query).toMatch(/worca: serviceInstanceLimits\(/);
  });

  it('a new instance reports the EU region from multiRegionConfig', async () => {
    const { facts } = describeWith(() => factsAnswer({ meta: { meta: meta({ 'europe-west4-drams3a': { numReplicas: 1 } }) } }));
    expect((await facts).region).toBe('europe-west4-drams3a');
  });

  it('missing pieces become nulls: no deployment falls back to the volume region; no volumes, no limits', async () => {
    expect((await describeWith(() => factsAnswer({ meta: null })).facts).region).toBe('sfo');
    const { facts } = describeWith(() =>
      factsAnswer({ meta: null, volumes: [], limits: { worca: null, broker: {}, cloudflared: { containers: { cpu: 1 } } } }),
    );
    expect(await facts).toEqual({
      region: null,
      services: {
        worca: { cpu: null, memoryMb: null, volumeMb: null, volumeUsedMb: null },
        broker: { cpu: null, memoryMb: null, volumeMb: null, volumeUsedMb: null },
        cloudflared: { cpu: 1, memoryMb: null, volumeMb: null, volumeUsedMb: null },
      },
    });
  });

  it('refuses a project that is not a worca-run project, and fails for a project that is gone', async () => {
    await expect(describeWith(() => factsAnswer({ name: 'worca-01' })).facts).rejects.toThrow(/not one of ours \(worca-run-\*\)/);
    await expect(describeWith(() => Response.json({ data: { project: null } })).facts).rejects.toThrow(/not found/);
    await expect(describeWith(() => Response.json({ errors: [{ message: 'Project not found' }] })).facts).rejects.toThrow(/Project not found/);
  });

  it('parses limits and regions defensively', () => {
    expect(parseLimits('{"containers":{"cpu":8,"memoryBytes":8000000000}}')).toEqual({ cpu: 8, memoryMb: 8000 });
    expect(parseLimits('not json')).toEqual({ cpu: null, memoryMb: null });
    expect(deploymentRegion(JSON.stringify(meta({ sfo: { numReplicas: 0 }, 'us-east4-eqdc4a': { numReplicas: 1 } })))).toBe('us-east4-eqdc4a');
    expect(deploymentRegion({ serviceManifest: { deploy: { region: 'us-west2' } } })).toBe('us-west2');
    expect(deploymentRegion(null)).toBeNull();
  });
});

describe('railway rotation (D74)', () => {
  const secrets = { tunnelToken: 'tun-new', brokerSecret: 'broker-new', heartbeatCredential: 'hb-new' };
  // What Railway holds per service: upserts merge into it, the read-back answers from it.
  let held: Record<string, Record<string, string>> = {};
  const store = (c: Call, answer: () => Response) => {
    const { serviceId, variables } = c.variables.input;
    held[serviceId] = { ...held[serviceId], ...variables };
    return answer();
  };
  const readHeld = (c: Call) => Response.json({ data: { variables: held[c.variables.serviceId] ?? {} } });

  it('setSecrets upserts only the renewed variables per service, without deploying, and reads them back', async () => {
    held = { 'svc-broker': { WORCA_BROKER_VAULT_KEY: 'vault' } };
    const fake = fakeRailway({ variableCollectionUpsert: store, variables: readHeld });
    await createRailwayProvider(env, fake.fetchImpl, noSleep).setSecrets(ref, secrets);
    expect(fake.ops()).toEqual([...Array(3).fill('variableCollectionUpsert'), ...Array(3).fill('variables')]);
    const inputs = fake.calls.filter((c) => c.op === 'variableCollectionUpsert').map((c) => c.variables.input);
    expect(inputs.every((i) => i.skipDeploys === true && i.projectId === 'proj-1' && i.environmentId === 'env-1')).toBe(true);
    expect(Object.fromEntries(inputs.map((i) => [i.serviceId, i.variables]))).toEqual({
      'svc-worca': { WORCA_HEARTBEAT_TOKEN: 'hb-new', WORCA_BROKER_SECRET: 'broker-new' },
      'svc-broker': { WORCA_BROKER_SECRET: 'broker-new' },
      'svc-cloudflared': { TUNNEL_TOKEN: 'tun-new' },
    });
    // The vault key is never part of a rotation.
    expect(held['svc-broker']!.WORCA_BROKER_VAULT_KEY).toBe('vault');
  });

  it('setSecrets throws the names of variables Railway does not hold as written, never their values', async () => {
    held = {};
    const fake = fakeRailway({
      variableCollectionUpsert: (c, answer) => (c.variables.input.serviceId === 'svc-cloudflared' ? answer() : store(c, answer)),
      variables: readHeld,
    });
    const err = await createRailwayProvider(env, fake.fetchImpl, noSleep).setSecrets(ref, secrets).catch((e: Error) => e);
    expect(String(err)).toContain('not confirmed: cloudflared TUNNEL_TOKEN');
    expect(String(err)).not.toContain('tun-new');
  });

  it('the renewed variables are the ones create sets', () => {
    const created = railwayVariables({ ...vars, ...secrets }, 'worca-run-');
    for (const [kind, renewed] of Object.entries(rotatedVariables(secrets)) as [keyof typeof created, Record<string, string>][]) {
      for (const [name, value] of Object.entries(renewed)) expect(created[kind][name]).toBe(value);
    }
  });

  it('restartServices deploys every service from its current configuration, cloudflared last', async () => {
    const fake = fakeRailway();
    const out = await createRailwayProvider(env, fake.fetchImpl, noSleep).restartServices(ref);
    expect(fake.ops()).toEqual(Array(3).fill('serviceInstanceDeployV2'));
    expect(fake.calls.map((c) => c.variables.serviceId)).toEqual(['svc-worca', 'svc-broker', 'svc-cloudflared']);
    expect(Object.values(out.services).every((s) => !!s.deploymentId)).toBe(true);
  });

  it('refuses to rotate or restart a project that is not a worca-run project', async () => {
    const foreign = () => Response.json({ data: { project: { name: 'worca-01' } } });
    for (const act of [(p: ReturnType<typeof createRailwayProvider>) => p.setSecrets(ref, secrets), (p: ReturnType<typeof createRailwayProvider>) => p.restartServices(ref)]) {
      const fake = fakeRailway({ projectName: foreign });
      await expect(act(createRailwayProvider(env, fake.fetchImpl, noSleep))).rejects.toThrow(/not one of ours \(worca-run-\*\)/);
      expect(fake.calls).toEqual([]);
    }
  });
});
