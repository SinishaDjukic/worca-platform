// Conformance checks for a compute provider (docs/providers.md): what the instance Workflows rely
// on, run against a fresh test account or a fake of one. Framework-neutral: each check is a name
// and an async function that throws on failure, so any test runner can run them:
//
//   for (const check of computeProviderChecks(harness)) it(check.name, check.run);
//
// Exported as `@worca/platform/testing`. The built-in providers run them
// in test/unit/control/providers-conformance.test.ts.
import type { ComputeProvider, ComputeProviderDefinition, ComputeRef, InstanceSpec, InstanceVariables, ServiceKind, WorcaSettings } from '../control/providers/types';
import { declarationProblems, effectiveSettings } from '../control/providers/settings';
import { SERVICE_KINDS } from '../control/providers/types';

export interface ConformanceCheck {
  name: string;
  run(): Promise<void>;
}

export interface ComputeHarness {
  definition: ComputeProviderDefinition;
  /** A provider against the test account (or its fake), with the resource prefix `prefix`. */
  provider(): ComputeProvider;
  /** The resource prefix the provider was made with (serviceHost is checked against it). */
  prefix: string;
  /** Image references the account can deploy; defaults are the public ones. */
  images?: InstanceSpec['image'];
  /** A region id the provider accepts; default: info.defaultRegion. */
  region?: string;
}

const STATES = new Set(['running', 'starting', 'stopped', 'failed']);
const DEPLOYMENT_STATES = new Set(['running', 'starting', 'failed']);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`conformance: ${message}`);
}

const isNumOrNull = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

function checkRef(ref: ComputeRef, what: string): void {
  assert(ref && typeof ref.projectId === 'string' && ref.projectId, `${what}: a ref with a projectId`);
  for (const kind of SERVICE_KINDS) assert(typeof ref.services?.[kind]?.serviceId === 'string', `${what}: a serviceId for ${kind}`);
}

/** The checks; each makes its own instance (a fresh id), so they run in any order. */
export function computeProviderChecks(h: ComputeHarness): ConformanceCheck[] {
  const info = h.definition.info;
  let seq = 0;
  const newSpec = (): InstanceSpec => {
    const instanceId = `${crypto.randomUUID().slice(0, 8)}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    const size = info.sizes.find((s) => s.id === info.defaultSize) ?? info.sizes[0]!;
    return {
      instanceId,
      orgId: 'conformance-org',
      host: `c${seq}.example.test`,
      keyHost: `k${seq}.example.test`,
      region: h.region ?? info.defaultRegion,
      cpu: size.vcpu,
      memoryMb: size.memoryMb,
      volumeGb: 10,
      image: h.images ?? { worca: 'ghcr.io/sinishadjukic/worca:1.19.0', broker: 'ghcr.io/sinishadjukic/worca:1.19.0', cloudflared: 'cloudflare/cloudflared:2026.10.3' },
      // What the platform hands over for an instance whose admins saved nothing: the declared defaults.
      settings: effectiveSettings(info.settings?.instance, null),
    };
  };
  const varsFor = (spec: InstanceSpec): InstanceVariables => ({
    tunnelToken: 'conformance-tunnel-token',
    allowedHosts: spec.host,
    identityIssuer: 'https://app.example.test',
    identityAudience: spec.host,
    keyPageAudience: spec.keyHost,
    heartbeatUrl: 'https://app.example.test/api/heartbeat',
    heartbeatCredential: 'conformance-heartbeat',
    egress: { mode: 'open', allow: 'app.example.test', deny: '.invalid' },
    brokerSecret: 's'.repeat(43),
    brokerVaultKey: btoa('v'.repeat(32)),
    instanceUrl: `https://${spec.host}`,
    keyPageUrl: `https://${spec.keyHost}`,
    terminalRemote: false,
    actionsRemote: false,
    size: { cpu: spec.cpu, memoryMb: spec.memoryMb, maxParallel: 4, maxParallelScripts: 2 },
  });
  const settingsFor = (spec: InstanceSpec): WorcaSettings => ({
    terminalRemote: true,
    actionsRemote: false,
    egress: { mode: 'allow', allow: 'app.example.test,registry.npmjs.org', deny: '.invalid' },
    size: { cpu: spec.cpu, memoryMb: spec.memoryMb, maxParallel: 4, maxParallelScripts: 2 },
  });
  /** create → setVariables → deploy, as the create op does. */
  async function deployed(p: ComputeProvider, spec = newSpec()) {
    const created = await p.createProject(spec);
    checkRef(created, 'createProject');
    await p.setVariables(created, varsFor(spec));
    const ref = await p.deploy(created, spec.image);
    checkRef(ref, 'deploy');
    return { spec, ref };
  }

  return [
    {
      name: 'describes itself: sizes, default size, region, capacity, service hosts',
      async run() {
        assert(info.displayName.trim(), 'a display name');
        assert(info.sizes.length > 0, 'at least one size');
        const ids = new Set(info.sizes.map((s) => s.id));
        assert(ids.size === info.sizes.length, 'unique size ids');
        for (const s of info.sizes) {
          assert(/^[a-z][a-z0-9-]*$/.test(s.id), `size id ${s.id}: lowercase`);
          for (const k of ['vcpu', 'memoryMb', 'maxParallel', 'maxParallelScripts'] as const) assert(Number.isInteger(s[k]) || (k === 'vcpu' && s[k] > 0), `size ${s.id}: ${k}`);
          assert(s.vcpu > 0 && s.memoryMb > 0 && s.maxParallel > 0 && s.maxParallelScripts > 0, `size ${s.id}: positive`);
        }
        assert(ids.has(info.defaultSize), 'defaultSize is one of the sizes');
        assert(info.defaultRegion.trim(), 'a default region');
        for (const r of info.regions) assert(r.id && r.label && typeof r.eu === 'boolean', `region ${r.id}`);
        if (info.capacity) assert(info.capacity.perInstance > 0 && info.capacity.limit > 0 && info.capacity.unit, 'capacity: unit, perInstance and limit');
        assert(info.egressEnforcement === 'worca' || info.egressEnforcement === 'provider', 'egressEnforcement');
        const hosts = SERVICE_KINDS.map((k) => info.serviceHost(h.prefix, k));
        for (const host of hosts) assert(/^[a-z0-9.-]+$/i.test(host), `service host ${host}: a host name`);
        assert(new Set(hosts).size === hosts.length, 'a different host per service');
      },
    },
    {
      name: 'declares its settings as data: valid keys, kinds, options and defaults; secrets by name only',
      async run() {
        const problems = declarationProblems(info.settings);
        assert(problems.length === 0, `settings declaration: ${problems.join('; ')}`);
      },
    },
    {
      name: 'createProject is safe to retry: the same project, three services',
      async run() {
        const p = h.provider();
        const spec = newSpec();
        const a = await p.createProject(spec);
        const b = await p.createProject(spec);
        checkRef(a, 'createProject');
        assert(a.projectId === b.projectId, 'a retried createProject returns the same project');
        for (const kind of SERVICE_KINDS) assert(a.services[kind].serviceId === b.services[kind].serviceId, `the same ${kind} service on retry`);
        await p.destroy(a);
      },
    },
    {
      name: 'findProject finds a project by instance id, and nothing for an unknown one',
      async run() {
        const p = h.provider();
        const spec = newSpec();
        const ref = await p.createProject(spec);
        assert((await p.findProject(spec.instanceId))?.projectId === ref.projectId, 'findProject returns the created project');
        assert((await p.findProject(newSpec().instanceId)) === null, 'findProject: null for an instance never created');
        await p.destroy(ref);
      },
    },
    {
      name: 'deploy (all services, then only some) keeps every service in the ref',
      async run() {
        const p = h.provider();
        const { spec, ref } = await deployed(p);
        const some = await p.deploy(ref, spec.image, ['cloudflared'] as ServiceKind[]);
        checkRef(some, 'deploy of one service');
        for (const kind of ['worca', 'broker'] as const) assert(some.services[kind].serviceId === ref.services[kind].serviceId, `${kind} unchanged by a deploy of cloudflared`);
        await p.destroy(ref);
      },
    },
    {
      name: 'deploymentStatuses and describe answer read-only, in the documented shapes',
      async run() {
        const p = h.provider();
        const { ref } = await deployed(p);
        const statuses = await p.deploymentStatuses([ref]);
        const mine = statuses[ref.projectId];
        assert(mine, 'deploymentStatuses has the project');
        for (const [kind, s] of Object.entries(mine)) {
          assert((SERVICE_KINDS as readonly string[]).includes(kind), `status for a known service (${kind})`);
          assert(s.state === undefined || s.state === null || STATES.has(s.state), `${kind}: state is running, starting, stopped or failed`);
          assert(s.status === null || typeof s.status === 'string', `${kind}: status`);
        }
        const facts = await p.describe(ref);
        assert(facts.region === null || typeof facts.region === 'string', 'describe: region');
        for (const kind of SERVICE_KINDS) {
          const f = facts.services[kind];
          assert(f && isNumOrNull(f.cpu) && isNumOrNull(f.memoryMb) && isNumOrNull(f.volumeMb), `describe: ${kind} facts`);
        }
        await p.destroy(ref);
      },
    },
    {
      name: 'settings, git and secrets apply without deploying; the restarts return refs',
      async run() {
        const p = h.provider();
        const { spec, ref } = await deployed(p);
        await p.setWorcaSettings(ref, settingsFor(spec));
        const restarted = await p.restartWorca(ref);
        checkRef(restarted, 'restartWorca');
        assert(DEPLOYMENT_STATES.has(await p.worcaDeploymentState(restarted)), 'worcaDeploymentState: running, starting or failed');
        await p.setGitSettings(restarted, { worca: { GH_TOKEN: 'conformance-token' }, broker: {} });
        await p.setGitSettings(restarted, { worca: {}, broker: {} }); // and removed again
        checkRef(await p.restartBroker(restarted), 'restartBroker');
        await p.setSecrets(restarted, { tunnelToken: 'conformance-tunnel-2', brokerSecret: 't'.repeat(43), heartbeatCredential: 'conformance-heartbeat-2' });
        checkRef(await p.restartServices(restarted), 'restartServices');
        await p.destroy(ref);
      },
    },
    {
      name: 'stop is idempotent and start brings the services back',
      async run() {
        const p = h.provider();
        const { ref } = await deployed(p);
        await p.stop(ref);
        await p.stop(ref); // a retried step
        const started = await p.start(ref);
        checkRef(started, 'start');
        await p.stop(started);
        checkRef(await p.start(started, { worcaFromConfig: true }), 'start from configuration');
        await p.destroy(ref);
      },
    },
    {
      name: 'destroy is idempotent; the project is gone afterwards',
      async run() {
        const p = h.provider();
        const { spec, ref } = await deployed(p);
        await p.destroy(ref);
        await p.destroy(ref); // a retried step finds it gone
        assert((await p.findProject(spec.instanceId)) === null, 'findProject: null after destroy');
      },
    },
  ];
}
