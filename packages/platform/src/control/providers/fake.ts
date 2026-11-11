// Fake providers for local development and tests. Compute drives the stub instance server's admin
// API (docs/internal-apis.md "Stub instance server"); edge returns synthetic ids, no network.
// The fake compute describes itself like Railway (sizes, regions, capacity, private host names), so
// the local stack shows what a hosted deployment shows; only its name says it is fake.
import type { Env } from '../env';
import { RAILWAY_INFO } from './railway';
import type { SettingsDeclaration, SettingValues } from './settings';
import type { ComputeFacts, ComputeProvider, ComputeProviderDefinition, ComputeProviderInfo, ComputeRef, EdgeProvider, GitVariables, InstanceSpec, InstanceVariables, ProjectStatus, RotatedSecrets, ServiceStatus, TunnelOrigins, WorcaSettings } from './types';

type FetchImpl = typeof fetch;

/** The stub keys instances by our instance id, so the compute ref carries it as the project id. */
export function createFakeCompute(env: Env, fetchImpl: FetchImpl = fetch, settings: SettingValues = {}): ComputeProvider {
  const base = (env.STUB_ADMIN_URL ?? 'http://127.0.0.1:9100').replace(/\/$/, '');
  const label: Record<string, string> = typeof settings.stubLabel === 'string' && settings.stubLabel ? { 'x-stub-label': settings.stubLabel } : {};

  async function call(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<unknown> {
    const res = await fetchImpl(`${base}/__admin/instances${path}`, {
      method,
      headers: body === undefined ? label : { 'content-type': 'application/json', ...label },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`fake compute: ${method} ${path} -> ${res.status}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const id = (ref: ComputeRef) => encodeURIComponent(ref.projectId);

  return {
    name: 'fake',
    async createProject(spec: InstanceSpec): Promise<ComputeRef> {
      // 409: already created by an earlier attempt of the same step.
      await call('POST', '', { instanceId: spec.instanceId, host: spec.host, keyHost: spec.keyHost, ...(spec.settings?.note ? { note: spec.settings.note } : {}) }, [409]);
      return {
        projectId: spec.instanceId,
        services: {
          worca: { serviceId: `${spec.instanceId}:worca` },
          broker: { serviceId: `${spec.instanceId}:broker` },
          cloudflared: { serviceId: `${spec.instanceId}:cloudflared` },
        },
      };
    },
    async setVariables(ref: ComputeRef, vars: InstanceVariables): Promise<void> {
      await call('POST', `/${id(ref)}/variables`, { variables: vars });
    },
    async deploy(ref: ComputeRef, image: InstanceSpec['image'], kinds?: readonly (keyof ComputeRef['services'])[]): Promise<ComputeRef> {
      // The stub is worca alone: a deploy of the other services leaves it running.
      if (kinds && !kinds.includes('worca')) return ref;
      // The stub reports the version from the worca image's tag in its heartbeats.
      await call('POST', `/${id(ref)}/deploy`, { image: image.worca, images: image });
      return ref;
    },
    async stop(ref: ComputeRef): Promise<void> {
      await call('POST', `/${id(ref)}/stop`, {});
    },
    async start(ref: ComputeRef, _opts?: { worcaFromConfig?: boolean; brokerFromConfig?: boolean; images?: Partial<InstanceSpec['image']> }): Promise<ComputeRef> {
      await call('POST', `/${id(ref)}/start`, {});
      return ref;
    },
    async setWorcaSettings(ref: ComputeRef, settings: WorcaSettings): Promise<void> {
      // The stub merges variables, like Railway's upsert.
      await call('POST', `/${id(ref)}/variables`, {
        variables: { terminalRemote: settings.terminalRemote, actionsRemote: settings.actionsRemote, egress: settings.egress, size: settings.size, ...(settings.ghAsPerson ? { ghAsPerson: settings.ghAsPerson } : {}) },
      });
    },
    async worcaDeploymentState(ref: ComputeRef): Promise<'running' | 'starting' | 'failed'> {
      // The stub serves again right after a deploy: its state says whether worca runs.
      const res = await fetchImpl(`${base}/__admin/instances/${id(ref)}`, { method: 'GET' });
      if (!res.ok) return 'failed';
      const state = ((await res.json().catch(() => null)) as { state?: string } | null)?.state;
      return state === 'running' ? 'running' : 'starting';
    },
    async restartWorca(ref: ComputeRef): Promise<ComputeRef> {
      // No image: the stub keeps the one it runs and starts serving again.
      await call('POST', `/${id(ref)}/deploy`, {});
      return ref;
    },
    async setGitSettings(ref: ComputeRef, git: GitVariables): Promise<void> {
      // The stub keeps the names only (replaced, not merged: names no longer set are gone), never a value.
      await call('POST', `/${id(ref)}/variables`, { variables: { git: { worca: Object.keys(git.worca).sort(), broker: Object.keys(git.broker).sort() } } });
    },
    async restartBroker(ref: ComputeRef): Promise<ComputeRef> {
      return ref; // the stub is worca alone
    },
    async setSecrets(ref: ComputeRef, secrets: RotatedSecrets): Promise<void> {
      // The stub merges variables and reads the heartbeat credential on every beat.
      await call('POST', `/${id(ref)}/variables`, {
        variables: { tunnelToken: secrets.tunnelToken, brokerSecret: secrets.brokerSecret, heartbeatCredential: secrets.heartbeatCredential },
      });
    },
    async restartServices(ref: ComputeRef): Promise<ComputeRef> {
      await call('POST', `/${id(ref)}/deploy`, {});
      return ref;
    },
    async destroy(ref: Pick<ComputeRef, 'projectId'>): Promise<void> {
      await call('DELETE', `/${encodeURIComponent(ref.projectId)}`, undefined, [404]);
    },
    async findProject(instanceId: string) {
      // The stub keys instances by our id, like a Railway project found by its name.
      const res = await fetchImpl(`${base}/__admin/instances/${encodeURIComponent(instanceId)}`, { method: 'GET' });
      return res.ok ? { projectId: instanceId } : null;
    },
    async deploymentStatuses(refs: ComputeRef[]): Promise<Record<string, ProjectStatus>> {
      // The stub's states mapped onto Railway's deployment statuses.
      const out: Record<string, ProjectStatus> = {};
      for (const ref of refs) {
        const res = await fetchImpl(`${base}/__admin/instances/${id(ref)}`, { method: 'GET' });
        if (!res.ok) continue;
        const state = ((await res.json().catch(() => null)) as { state?: string } | null)?.state;
        const status = state === 'running' ? 'SUCCESS' : state === 'stopped' ? 'REMOVED' : state === 'created' ? null : 'FAILED';
        const s: ServiceStatus = {
          state: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : state === 'created' ? null : 'failed',
          status,
          statusUpdatedAt: null,
          stopped: status === null ? null : status !== 'SUCCESS',
        };
        out[ref.projectId] = { worca: s, broker: s, cloudflared: s };
      }
      return out;
    },
    async describe(_ref: ComputeRef): Promise<ComputeFacts> {
      // No network: the stub has no resources to report. What a new Railway instance shows: the
      // EU region, the tier's ceilings on every service, a plan-default volume for worca and the broker.
      return {
        region: FAKE_REGION,
        services: {
          worca: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 800 },
          broker: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 800 },
          cloudflared: { cpu: 2, memoryMb: 4000, volumeMb: null, volumeUsedMb: null },
        },
      };
    },
  };
}

export const FAKE_REGION = 'europe-west4-drams3a';

/**
 * Its settings exercise the console's generic fields locally (docs/providers.md "Settings"); the
 * stub ignores them. The deployment's label goes to the stub with every call, so the stub's log shows it.
 */
export const FAKE_SETTINGS: SettingsDeclaration = {
  deployment: [
    { key: 'stubLabel', kind: 'text', label: 'Stub label', help: 'Fake provider only: sent to the stub with every call, for its log.', maxLength: 40 },
  ],
  instance: [
    { key: 'note', kind: 'text', label: 'Note for the stub', help: 'Fake provider only: kept with the instance and sent to the stub when it is created.', maxLength: 60 },
  ],
};

export const FAKE_COMPUTE_INFO: ComputeProviderInfo = { ...RAILWAY_INFO, displayName: 'Fake compute', settings: FAKE_SETTINGS };

/** The built-in `fake` compute provider (providers/index.ts): no account, nothing to report. */
export const fakeCompute: ComputeProviderDefinition = {
  info: FAKE_COMPUTE_INFO,
  create: (ctx) => createFakeCompute(ctx.env, ctx.fetch as typeof fetch, ctx.settings),
  usage: async () => ({ plan: 'FAKE', items: [{ label: 'projects', used: 0, limit: null }], details: null }),
};

/** No tunnels or DNS locally: the gate forwards to HostEntry.upstream instead. */
export function createFakeEdge(_env: Env): EdgeProvider {
  return {
    name: 'fake',
    async createTunnel(spec: InstanceSpec, _origins: TunnelOrigins) {
      return { tunnelId: `fake-tunnel-${spec.instanceId}`, tunnelToken: `fake-tunnel-token-${spec.instanceId}` };
    },
    async addDns(spec: InstanceSpec, _tunnelId: string) {
      return [`fake-dns-${spec.host}`, `fake-dns-${spec.keyHost}`];
    },
    async deleteDns(_recordIds: string[]) {},
    async deleteTunnel(_tunnelId: string) {},
    async rotateTunnelSecret(tunnelId: string) {
      return `fake-tunnel-token-${tunnelId}-${crypto.randomUUID()}`;
    },
    async findEdge() {
      return null; // nothing exists locally that a ref could miss
    },
    async connectorVersions(_tunnelId: string) {
      return null; // no cloudflared locally
    },
    async tunnelStatuses(tunnelIds: string[]) {
      return Object.fromEntries(tunnelIds.map((t) => [t, 'healthy' as const]));
    },
  };
}
