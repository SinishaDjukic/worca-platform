// Railway compute provider (D4, D6, D33, D48): one Railway project per instance, created through
// Railway's public GraphQL API with a workspace token. Operation and input names were checked
// against the live schema (unauthenticated introspection of backboard.railway.com/graphql/v2) and
// docs.railway.com on 2026-10-06; behaviour the schema can't show is marked UNVERIFIED.
import type { Env } from '../env';
import { BROKER_GIT_VARIABLES, WORCA_GIT_VARIABLES } from '../instances/git';
import { resourcePrefix } from './prefix';
import type { SettingsDeclaration, SettingValues } from './settings';
import { STANDARD_DEFAULT_SIZE, STANDARD_SIZES } from './standard-sizes';
import { defaultSleep, fetchWithRetry, type Fetch, type ProviderOptions } from './http';
import {
  BROKER_UI_PORT,
  DATA_MOUNT_PATH,
  gitDiff,
  instanceEnvironment,
  LEGACY_EGRESS_VARIABLE,
  rotatedVariables,
  worcaSettingsVariables,
} from './instance-env';
import { SERVICE_KINDS, type ComputeFacts, type ComputeProvider, type ComputeProviderDefinition, type ComputeProviderInfo, type ComputeRef, type GitVariables, type ProviderContext, type ProviderUsage, type InstanceSpec, type InstanceVariables, type ProjectStatus, type ServiceFacts, type ServiceKind, type ServiceState, type WorcaSettings } from './types';

export const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2';



/** Railway refuses project names over 32 characters ("Project names must be between 1 and 32"). */
export const RAILWAY_PROJECT_NAME_MAX = 32;
/**
 * The resource prefix (prefix.ts, e.g. `worca-run-`) plus as many hex digits of the instance id as
 * fit (22 with a 10-character prefix: 88 bits, dashes dropped): a whole UUID would not. Only the
 * prefix matters to the ownership checks; the project is found by the id in the instance's compute
 * ref, never by name.
 */
export const railwayProjectName = (prefix: string, instanceId: string) =>
  `${prefix}${instanceId.replace(/-/g, '')}`.slice(0, RAILWAY_PROJECT_NAME_MAX);
export const railwayServiceName = (prefix: string, kind: ServiceKind) => `${prefix}${kind}`;
/** Private network DNS name of a service inside its project: `<service name>.railway.internal`. */
export const railwayPrivateHost = (prefix: string, kind: ServiceKind) => `${railwayServiceName(prefix, kind)}.railway.internal`;

/** Short region names map to Railway's deployment region ids (docs: deployment regions, "EU West Metal"). */
const REGION_IDS: Record<string, string> = { 'europe-west4': 'europe-west4-drams3a' };
export const railwayRegion = (region: string) => REGION_IDS[region] ?? region;

/** The broker's and the tunnel's ceiling on every size (what every service had before D78). */
export const SIDE_SERVICE_LIMITS = { cpu: 2, memoryMb: 4096 } as const;
/** Railway Pro's services per workspace; every instance is three (worca, broker, cloudflared). */
export const RAILWAY_SERVICE_CAP = 100;

/** Railway region ids → where they are (Railway's `regions` query: location and city). */
export const RAILWAY_REGIONS: ComputeProviderInfo['regions'] = [
  { id: 'europe-west4', label: 'EU West (Amsterdam)', eu: true },
  { id: 'us-west2', label: 'US West (California)', eu: false },
  { id: 'sfo', label: 'US West (California)', eu: false }, // what a deployment's multiRegionConfig calls us-west2
  { id: 'us-west1', label: 'US West (Oregon)', eu: false },
  { id: 'us-east4', label: 'US East (Virginia)', eu: false },
  { id: 'us-east-1', label: 'US East (Virginia)', eu: false },
  { id: 'asia-southeast1', label: 'Southeast Asia (Singapore)', eu: false },
];

/**
 * Railway's settings (docs/providers.md "Settings"): the workspace and the secret holding its
 * token. Unset, they fall back to the RAILWAY_WORKSPACE_ID var and the RAILWAY_TOKEN secret, as
 * before settings existed.
 */
export const RAILWAY_SETTINGS: SettingsDeclaration = {
  deployment: [
    {
      key: 'workspaceId',
      kind: 'text',
      label: 'Workspace ID',
      help: 'The Railway workspace instances are created in (Workspace settings → General). Empty: the RAILWAY_WORKSPACE_ID variable.',
      pattern: '[A-Za-z0-9-]{1,64}',
      patternMessage: 'a Railway workspace id: letters, digits and dashes',
      maxLength: 64,
    },
    {
      key: 'tokenSecret',
      kind: 'secret',
      label: 'API token',
      help: 'The Worker secret holding a Railway workspace token (wrangler secret put).',
      default: 'RAILWAY_TOKEN',
      required: true,
    },
  ],
};

/** The token and workspace a Railway call uses: the settings, else the RAILWAY_* vars. */
export function railwayAccount(env: Env, settings: SettingValues = {}) {
  const tokenName = typeof settings.tokenSecret === 'string' && settings.tokenSecret ? settings.tokenSecret : 'RAILWAY_TOKEN';
  const token = (env as unknown as Record<string, unknown>)[tokenName];
  const workspaceId = (typeof settings.workspaceId === 'string' && settings.workspaceId) || env.RAILWAY_WORKSPACE_ID || '';
  return { tokenName, token: typeof token === 'string' ? token : '', workspaceId };
}

/**
 * Railway has no machine types: a size is the worca service's vCPU and memory ceiling
 * (serviceInstanceLimitsUpdate) plus worca's parallelism. Railway bills what a container uses, not
 * its ceiling, so a larger size costs more only while worca actually uses it.
 */
export const RAILWAY_INFO: ComputeProviderInfo = {
  displayName: 'Railway',
  sizes: STANDARD_SIZES,
  defaultSize: STANDARD_DEFAULT_SIZE,
  defaultRegion: 'europe-west4', // D6: Railway EU West (Amsterdam)
  regions: RAILWAY_REGIONS,
  capacity: { unit: 'services', perInstance: SERVICE_KINDS.length, limit: RAILWAY_SERVICE_CAP },
  egressEnforcement: 'worca',
  serviceHost: railwayPrivateHost,
  settings: RAILWAY_SETTINGS,
};

// The cloudflared image's ENTRYPOINT is `cloudflared --no-autoupdate` with CMD `version`; a Railway
// start command replaces the ENTRYPOINT, so it names the binary. `tunnel run` reads TUNNEL_TOKEN.
const CLOUDFLARED_START = 'cloudflared tunnel --no-autoupdate run';
// The broker runs from worca's own image (worca-cc docs/credential-broker.md, Railway service).
const BROKER_START = 'worca-entrypoint worca broker';
// worca's own ENTRYPOINT and CMD, with tini told to report exit 143 as 0. worca exits 143 after
// SIGTERM, and Railway never marks a deployment stopped whose container exits non-zero after
// deploymentStop: it stays RUNNING with deploymentStopped=false, so stop() never confirms
// (docs/railway.md, "Stopping and waking"; verified 2026-10-07). worca images from the release after
// 1.9.0 do this in their own ENTRYPOINT (worca-cc PR #610); the start command keeps 1.9.0 stoppable.
export const WORCA_START = 'tini -s -e 143 -- worca-entrypoint worca ui';

// What worca's own Railway guide (worca-cc docs/deploy-railway.md, docs/credential-broker.md) adds
// to the instance contract (instance-env.ts) on every Railway deployment: the entrypoint must start
// as root (RAILWAY_RUN_UID=0) to prepare the volume before dropping to its own user, and the
// broker's PORT tells Railway which port it serves. cloudflared reaches the services over Railway's
// private network, which is IPv6, hence the contract's `::`.
const RAILWAY_EXTRA: Record<ServiceKind, Record<string, string>> = {
  worca: { RAILWAY_RUN_UID: '0' },
  broker: { PORT: String(BROKER_UI_PORT), RAILWAY_RUN_UID: '0' },
  cloudflared: {},
};
/** Seconds Railway waits after SIGTERM before it kills worca (configureService). */
export const WORCA_DRAINING_SECONDS = 60;
/** The instance contract's variables per service (instance-env.ts) plus Railway's own (RAILWAY_EXTRA). */
export function railwayVariables(vars: InstanceVariables, prefix: string): Record<ServiceKind, Record<string, string>> {
  const contract = instanceEnvironment(vars, railwayPrivateHost(prefix, 'broker'));
  return {
    worca: { ...contract.worca, ...RAILWAY_EXTRA.worca },
    broker: { ...contract.broker, ...RAILWAY_EXTRA.broker },
    cloudflared: { ...contract.cloudflared, ...RAILWAY_EXTRA.cloudflared },
  };
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

function createClient(account: ReturnType<typeof railwayAccount>, fetchImpl: Fetch, opts: ProviderOptions) {
  return async function gql<T>(operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!account.token) throw new Error(`railway: ${account.tokenName} is not set`);
    const res = await fetchWithRetry(
      fetchImpl,
      RAILWAY_ENDPOINT,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operationName, query, variables }),
      },
      opts,
    );
    const body = (await res.json().catch(() => null)) as GqlResponse<T> | null;
    if (body?.errors?.length) {
      throw new Error(`railway ${operationName}: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!res.ok || !body?.data) throw new Error(`railway ${operationName}: HTTP ${res.status}`);
    return body.data;
  };
}

// --- Operations. Names and argument types verified against the schema unless noted. ---

const PROJECT_CREATE = `mutation projectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) { id environments { edges { node { id name } } } }
}`;
const SERVICE_CREATE = `mutation serviceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id name }
}`;
const SERVICE_INSTANCE_UPDATE = `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`;
/** A service's ceiling as serviceInstanceLimitsUpdate takes it (memory in GB, binary: 4096 MB = 4). */
function limitsInput(serviceId: string, environmentId: string, l: { cpu: number; memoryMb: number }) {
  return { serviceId, environmentId, vCPUs: l.cpu, memoryGB: l.memoryMb / 1024 };
}

/** A deployment's Railway status as the reconfigure op reads it: SUCCESS runs; these never will. */
const DEPLOYMENT_FAILED = new Set(['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED']);
export function deploymentState(status: string | null): 'running' | 'starting' | 'failed' {
  if (status === 'SUCCESS') return 'running';
  return !status || DEPLOYMENT_FAILED.has(status) ? 'failed' : 'starting';
}

const LIMITS_UPDATE = `mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) {
  serviceInstanceLimitsUpdate(input: $input)
}`;
const VOLUME_CREATE = `mutation volumeCreate($input: VolumeCreateInput!) {
  volumeCreate(input: $input) { id }
}`;
const VARIABLES_UPSERT = `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`;
// Verified in the live schema on 2026-10-08: VariableDeleteInput { projectId!, environmentId!, name!,
// serviceId }; variables(projectId!, environmentId!, serviceId) answers the service's variables as
// one JSON map; deployment(id!) { status }. variableDelete has no skipDeploys; whether it starts a
// deployment by itself is UNVERIFIED, so it runs only after the upsert has written the new values.
const VARIABLE_DELETE = `mutation variableDelete($input: VariableDeleteInput!) {
  variableDelete(input: $input)
}`;
const VARIABLES_READ = `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
}`;
const DEPLOYMENT_STATUS = `query deploymentStatus($id: String!) {
  deployment(id: $id) { id status }
}`;
const DEPLOY = `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`;
// deployments(first: 1) is the newest deployment (verified 2026-10-06, the same one as the service
// instance's latestDeployment). `deploymentStopped` is the only sign a stop took: see stop().
const LATEST_DEPLOYMENT = `query latestDeployment($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) { edges { node { id status deploymentStopped } } }
}`;
const DEPLOYMENT_STOP = `mutation deploymentStop($id: String!) {
  deploymentStop(id: $id)
}`;
const DEPLOYMENT_REDEPLOY = `mutation deploymentRedeploy($id: String!, $usePreviousImageTag: Boolean) {
  deploymentRedeploy(id: $id, usePreviousImageTag: $usePreviousImageTag) { id status }
}`;
// One request for every service's latest deployment, to confirm a stop.
const DEPLOYMENT_STATES = `query deploymentStates($id: String!) {
  project(id: $id) { environments { edges { node { id
    serviceInstances { edges { node { serviceId latestDeployment { id status deploymentStopped } } } }
  } } } }
}`;
const PROJECT_NAME = `query projectName($id: String!) {
  project(id: $id) { name }
}`;

// P1: every project of the workspace with each service's latest deployment, in one request.
// Field names checked against the live schema on 2026-10-06 (Service has no serviceInstances;
// they hang off Environment).
const WORKSPACE_STATUS = `query workspaceStatus($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) {
    projects(first: 100) { edges { node { id name
      environments(first: 5) { edges { node { id
        serviceInstances(first: 10) { edges { node { serviceId serviceName latestDeployment { status statusUpdatedAt deploymentStopped } } } }
      } } }
    } } }
  }
}`;

interface WorkspaceStatusData {
  workspace: {
    projects: {
      edges: {
        node: {
          id: string;
          name: string;
          environments: {
            edges: {
              node: {
                id: string;
                serviceInstances: {
                  edges: {
                    node: {
                      serviceId: string;
                      serviceName: string;
                      latestDeployment: { status: string; statusUpdatedAt: string | null; deploymentStopped?: boolean | null } | null;
                    };
                  }[];
                };
              };
            }[];
          };
        };
      }[];
    };
  } | null;
}

// Retry safety: what an earlier attempt of the same step may already have made. Projects are
// found by their deterministic name, services by name, volumes by service and mount path.
const WORKSPACE_PROJECTS = `query workspaceProjects($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) { projects(first: 100) { edges { node { id name deletedAt } } } }
}`;
const PROJECT_LAYOUT = `query projectLayout($id: String!) {
  project(id: $id) { id name
    environments { edges { node { id volumeInstances { edges { node { serviceId mountPath } } } } } }
    services { edges { node { id name } } }
  }
}`;

interface ProjectLayout {
  project: {
    id: string;
    name: string;
    environments: { edges: { node: { id: string; volumeInstances: { edges: { node: { serviceId: string | null; mountPath: string } }[] } } }[] };
    services: { edges: { node: { id: string; name: string } }[] };
  } | null;
}

/**
 * How Railway reports a stop (verified against the live API with a throwaway project, 2026-10-06):
 * `deploymentStop` answers true, the deployment's `status` STAYS `SUCCESS` (it is still the
 * service's latest and "active" deployment), and about 15 s later `deploymentStopped` turns true
 * and its instance shows EXITED. So `status` alone never says whether a service still runs.
 * `deploymentStopped` is also true while a deployment has no instance yet (DEPLOYING, INITIALIZING),
 * so it only counts once the deployment has settled. docs/railway.md "Stopping and waking".
 *
 * NOT_RUNNING: statuses with nothing left to stop (deploymentStop on CRASHED fails with
 * "Deployment is not stoppable").
 */
const NOT_RUNNING = new Set(['REMOVED', 'REMOVING', 'FAILED', 'CRASHED', 'SKIPPED']);
/**
 * Not settled yet: an instance may still appear, whatever `deploymentStopped` says, and
 * deploymentStop refuses it ("Deployment is not stoppable"; verified on INITIALIZING).
 */
const IN_PROGRESS = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']);

export interface DeploymentState {
  id: string;
  status: string | null;
  deploymentStopped: boolean | null;
}

/** True when nothing of this deployment runs, or can start running by itself. */
export function deploymentIsStopped(d: Pick<DeploymentState, 'status' | 'deploymentStopped'> | null | undefined): boolean {
  if (!d) return true;
  if (d.status && NOT_RUNNING.has(d.status)) return true;
  return d.deploymentStopped === true && !(d.status && IN_PROGRESS.has(d.status));
}

/** A latest deployment's status as the consoles show it (ServiceStatus.state). */
export function serviceState(status: string | null, stopped: boolean | null): ServiceState | null {
  if (!status) return stopped ? 'stopped' : null;
  if (status === 'FAILED' || status === 'CRASHED') return 'failed';
  if (stopped || status === 'REMOVED' || status === 'REMOVING' || status === 'SKIPPED' || status === 'SLEEPING') return 'stopped';
  if (status === 'SUCCESS') return 'running';
  return 'starting';
}

/**
 * How long stop() waits for Railway to confirm, and how often it looks: one request per look
 * (Hobby: 1,000 requests an hour). A stop took about 15 s in the probe, and up to Railway's
 * draining time for worca (WORCA_DRAINING_SECONDS); the Workflow step's own timeout is 5 minutes,
 * and a step that throws is retried. Sparse on purpose: a worca that never stopped once ran the
 * retried step into the Workers limit on subrequests per invocation at a 5 s interval.
 */
export const STOP_CONFIRM_POLL_MS = 15_000;
export const STOP_CONFIRM_TIMEOUT_MS = 90_000;

// Compute facts (describe): the project's volumes and each service's latest deployment, plus the
// three services' limits through aliases, in ONE request. Verified against the live API on
// 2026-10-07: serviceInstanceLimits answers JSON `{"containers":{"cpu":2,"memoryBytes":4000000000,
// "pidLimit":1000}}`; VolumeInstance has sizeMB (Int, 50000 on Pro) and currentSizeMB (Float);
// Deployment.meta.serviceManifest.deploy.multiRegionConfig is `{"sfo":{"numReplicas":1}}` for a
// deployment in US West (its `region` is null), and ServiceInstance.region is null as well.
const COMPUTE_FACTS = `query computeFacts($id: String!, $environmentId: String!, $worca: String!, $broker: String!, $cloudflared: String!) {
  project(id: $id) { name
    environments { edges { node { id
      volumeInstances { edges { node { serviceId mountPath region sizeMB currentSizeMB } } }
      serviceInstances { edges { node { serviceId latestDeployment { meta } } } }
    } } }
  }
  worca: serviceInstanceLimits(serviceId: $worca, environmentId: $environmentId)
  broker: serviceInstanceLimits(serviceId: $broker, environmentId: $environmentId)
  cloudflared: serviceInstanceLimits(serviceId: $cloudflared, environmentId: $environmentId)
}`;

interface ComputeFactsData {
  project: {
    name: string;
    environments: {
      edges: {
        node: {
          id: string;
          volumeInstances: { edges: { node: { serviceId: string | null; mountPath: string; region: string | null; sizeMB: number | null; currentSizeMB: number | null } }[] };
          serviceInstances: { edges: { node: { serviceId: string; latestDeployment: { meta: unknown } | null } }[] };
        };
      }[];
    };
  } | null;
  worca?: unknown;
  broker?: unknown;
  cloudflared?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** serviceInstanceLimits' JSON → vCPUs and memory in decimal MB (Railway counts GB as 10^9 bytes). */
export function parseLimits(raw: unknown): Pick<ServiceFacts, 'cpu' | 'memoryMb'> {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  const c = (value as { containers?: { cpu?: unknown; memoryBytes?: unknown } } | null)?.containers;
  const bytes = num(c?.memoryBytes);
  return { cpu: num(c?.cpu), memoryMb: bytes === null ? null : Math.round(bytes / 1_000_000) };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * The region a deployment was placed in, from its meta: the multiRegionConfig entry with replicas
 * (what Railway really uses), else the legacy `region` field. Null when the meta says neither.
 */
export function deploymentRegion(meta: unknown): string | null {
  const m = typeof meta === 'string' ? safeJson(meta) : meta;
  const deploy = (m as { serviceManifest?: { deploy?: { multiRegionConfig?: unknown; region?: unknown } } } | null)?.serviceManifest?.deploy;
  const multi = deploy?.multiRegionConfig;
  if (multi && typeof multi === 'object') {
    const entries = Object.entries(multi as Record<string, { numReplicas?: unknown } | null>);
    const placed = entries.find(([, v]) => (num(v?.numReplicas) ?? 1) > 0) ?? entries[0];
    if (placed) return placed[0];
  }
  return typeof deploy?.region === 'string' && deploy.region ? deploy.region : null;
}

const PROJECT_DELETE = `mutation projectDelete($id: String!) {
  projectDelete(id: $id)
}`;

export function createRailwayProvider(
  env: Env,
  fetchImpl: Fetch = fetch,
  opts: ProviderOptions & { resourcePrefix?: string; settings?: SettingValues } = {},
): ComputeProvider {
  const account = railwayAccount(env, opts.settings);
  const workspace = () => {
    if (!account.workspaceId) throw new Error('railway: RAILWAY_WORKSPACE_ID is not set (or the workspaceId setting)');
    return account.workspaceId;
  };
  const prefix = opts.resourcePrefix ?? resourcePrefix(env);
  const notOurs = (what: string) => `not one of ours (${prefix}*)${what}`;
  // Wrapped so the global fetch is never called with a foreign `this`.
  const gql = createClient(account, (url, init) => fetchImpl(url, init), opts);

  const envId = (ref: ComputeRef) => {
    if (!ref.environmentId) throw new Error('railway: ComputeRef has no environmentId');
    return ref.environmentId;
  };

  async function configureService(projectId: string, environmentId: string, kind: ServiceKind, spec: InstanceSpec, existingId?: string) {
    // An earlier attempt's service is reused; the updates below are idempotent.
    const serviceId =
      existingId ??
      (
        await gql<{ serviceCreate: { id: string } }>('serviceCreate', SERVICE_CREATE, {
          // No source yet: deploy() sets the image, so nothing runs before setVariables.
          input: { projectId, environmentId, name: railwayServiceName(prefix, kind) },
        })
      ).serviceCreate.id;
    // `multiRegionConfig`, not `region`: Railway ignores `region` and deploys to its default
    // (US West, `sfo`) — verified 2026-10-07; with multiRegionConfig the deployment and its
    // volume land in Amsterdam (D6).
    const input: Record<string, unknown> = { multiRegionConfig: { [railwayRegion(spec.region)]: { numReplicas: 1 } } };
    if (kind === 'cloudflared') input.startCommand = CLOUDFLARED_START;
    if (kind === 'broker') input.startCommand = BROKER_START;
    if (kind === 'worca') input.startCommand = WORCA_START;
    // worca drains on SIGTERM (worca backlog B2: pauses its runs with a resume point, up to 20 s);
    // Railway must wait for that before it kills the container. worca's Railway guide uses 60.
    if (kind === 'worca') input.drainingSeconds = WORCA_DRAINING_SECONDS;
    await gql('serviceInstanceUpdate', SERVICE_INSTANCE_UPDATE, { serviceId, environmentId, input });
    // D78: worca gets the instance's compute size; the broker and the tunnel a fixed ceiling.
    const limits = kind === 'worca' ? { cpu: spec.cpu, memoryMb: spec.memoryMb } : SIDE_SERVICE_LIMITS;
    await gql('serviceInstanceLimitsUpdate', LIMITS_UPDATE, { input: limitsInput(serviceId, environmentId, limits) });
    return serviceId;
  }

  /**
   * The workspace token also reaches projects that aren't ours (the team's own worca instance
   * shares the Hobby workspace). Every call that changes an existing project first checks that
   * it is one of ours by its name prefix, so a wrong id in our database can never touch another.
   */
  async function assertOwnedProject(projectId: string): Promise<'ok' | 'gone'> {
    let name: string | undefined;
    try {
      const data = await gql<{ project: { name: string } | null }>('projectName', PROJECT_NAME, { id: projectId });
      name = data.project?.name;
    } catch (err) {
      if (/not found|does not exist/i.test(String(err))) return 'gone';
      throw err;
    }
    if (name === undefined) return 'gone';
    if (!name.startsWith(prefix)) throw new Error(`railway: refusing to touch project ${projectId} (${name}): ${notOurs('')}`);
    return 'ok';
  }

  async function latestDeployment(ref: ComputeRef, kind: ServiceKind): Promise<DeploymentState | undefined> {
    const data = await gql<{ deployments: { edges: { node: { id: string; status: string; deploymentStopped?: boolean | null } }[] } }>(
      'latestDeployment',
      LATEST_DEPLOYMENT,
      { input: { projectId: ref.projectId, environmentId: envId(ref), serviceId: ref.services[kind].serviceId } },
    );
    const node = data.deployments.edges[0]?.node;
    if (node) return { id: node.id, status: node.status ?? null, deploymentStopped: node.deploymentStopped ?? null };
    const known = ref.services[kind].deploymentId;
    return known ? { id: known, status: null, deploymentStopped: null } : undefined;
  }

  /** Every service's latest deployment in one request, by kind (undefined: no deployment). */
  async function deploymentStates(ref: ComputeRef): Promise<Partial<Record<ServiceKind, DeploymentState>>> {
    type Data = {
      project: {
        environments: {
          edges: { node: { id: string; serviceInstances: { edges: { node: { serviceId: string; latestDeployment: DeploymentState | null } }[] } } }[];
        };
      } | null;
    };
    const data = await gql<Data>('deploymentStates', DEPLOYMENT_STATES, { id: ref.projectId });
    const environment = data.project?.environments.edges.find((e) => e.node.id === envId(ref))?.node;
    const out: Partial<Record<ServiceKind, DeploymentState>> = {};
    for (const kind of SERVICE_KINDS) {
      const d = environment?.serviceInstances.edges.find((e) => e.node.serviceId === ref.services[kind].serviceId)?.node.latestDeployment;
      if (d) out[kind] = { id: d.id, status: d.status ?? null, deploymentStopped: d.deploymentStopped ?? null };
    }
    return out;
  }

  async function latestDeploymentId(ref: ComputeRef, kind: ServiceKind): Promise<string | undefined> {
    return (await latestDeployment(ref, kind))?.id;
  }

  /**
   * A new deployment of one service from its current configuration: the image source deploy() set
   * last and the current variables. UNVERIFIED, as in deploy(): serviceInstanceDeployV2 without
   * commitSha for an image-sourced service.
   */
  async function deployFromConfig(ref: ComputeRef, kind: ServiceKind): Promise<{ serviceId: string; deploymentId: string }> {
    const { serviceId } = ref.services[kind];
    const data = await gql<{ serviceInstanceDeployV2: string }>('serviceInstanceDeployV2', DEPLOY, { serviceId, environmentId: envId(ref) });
    return { serviceId, deploymentId: data.serviceInstanceDeployV2 };
  }

  /** Our live project for this instance, found by its name (never another workspace project). */
  async function findProjectId(instanceId: string): Promise<string | null> {
    const workspaceId = workspace();
    const name = railwayProjectName(prefix, instanceId);
    const data = await gql<{ workspace: { projects: { edges: { node: { id: string; name: string; deletedAt: string | null } }[] } } | null }>(
      'workspaceProjects',
      WORKSPACE_PROJECTS,
      { workspaceId },
    );
    return data.workspace?.projects.edges.find((e) => e.node.name === name && !e.node.deletedAt)?.node.id ?? null;
  }

  return {
    name: 'railway',

    async createProject(spec) {
      const workspaceId = workspace();
      // Safe to run again after an attempt that failed half-way, or that succeeded at Railway but
      // whose answer was lost: everything is looked up before it is created, so a retry finishes
      // the same project instead of starting a second one (Railway also allows only one new
      // project per 30 seconds). A project left half-built by a create that finally fails is
      // found by name when the instance is deleted (findProject).
      let projectId = await findProjectId(spec.instanceId);
      if (!projectId) {
        const data = await gql<{ projectCreate: { id: string } }>('projectCreate', PROJECT_CREATE, {
          input: {
            name: railwayProjectName(prefix, spec.instanceId),
            workspaceId,
            defaultEnvironmentName: 'production',
            isPublic: false,
          },
        });
        projectId = data.projectCreate.id;
      }
      const layout = (await gql<ProjectLayout>('projectLayout', PROJECT_LAYOUT, { id: projectId })).project;
      if (!layout) throw new Error(`railway: project ${projectId} not found after creating it`);
      if (!layout.name.startsWith(prefix)) throw new Error(`railway: refusing to touch project ${projectId} (${layout.name}): ${notOurs('')}`);
      const environment = layout.environments.edges[0]?.node;
      if (!environment) throw new Error('railway projectCreate: project has no environment');
      const environmentId = environment.id;
      const existing = new Map(layout.services.edges.map((e) => [e.node.name, e.node.id]));
      const services = {} as ComputeRef['services'];
      for (const kind of SERVICE_KINDS) {
        services[kind] = { serviceId: await configureService(projectId, environmentId, kind, spec, existing.get(railwayServiceName(prefix, kind))) };
      }
      // UNVERIFIED: VolumeCreateInput has no size field; the volume gets the plan's default
      // size and spec.volumeGb is not applied (only templateVolumeUpdate takes sizeMB).
      // worca's data, and the broker's own volume for its encrypted key store (a Railway volume
      // belongs to one service). A volume already mounted for the service is kept.
      const mounted = environment.volumeInstances.edges.map((e) => e.node);
      for (const kind of ['worca', 'broker'] as const) {
        const { serviceId } = services[kind];
        if (mounted.some((v) => v.serviceId === serviceId && v.mountPath === DATA_MOUNT_PATH)) continue;
        await gql('volumeCreate', VOLUME_CREATE, {
          input: { projectId, environmentId, serviceId, mountPath: DATA_MOUNT_PATH, region: railwayRegion(spec.region) },
        });
      }
      return { projectId, environmentId, services };
    },

    async findProject(instanceId) {
      const projectId = await findProjectId(instanceId);
      return projectId ? { projectId } : null;
    },

    async setVariables(ref, vars) {
      await assertOwnedProject(ref.projectId);
      const perService = railwayVariables(vars, prefix);
      for (const kind of SERVICE_KINDS) {
        await gql('variableCollectionUpsert', VARIABLES_UPSERT, {
          input: {
            projectId: ref.projectId,
            environmentId: envId(ref),
            serviceId: ref.services[kind].serviceId,
            variables: perService[kind],
            skipDeploys: true, // deploy() follows
          },
        });
      }
    },

    async setWorcaSettings(ref, settings: WorcaSettings) {
      await assertOwnedProject(ref.projectId);
      const target = { projectId: ref.projectId, environmentId: envId(ref), serviceId: ref.services.worca.serviceId };
      const want = worcaSettingsVariables(settings);
      // One upsert, all values together (it merges: the other variables stay as they are). It fails
      // as a whole, and then the step fails and the settings stay pending.
      await gql('variableCollectionUpsert', VARIABLES_UPSERT, { input: { ...target, variables: want, skipDeploys: true } });
      // D78: the compute size's ceiling; the next worca deployment (restart, wake, upgrade) runs with it.
      await gql('serviceInstanceLimitsUpdate', LIMITS_UPDATE, { input: limitsInput(target.serviceId, target.environmentId, settings.size) });
      // Then the pre-D73 allowlist goes. Already gone (every apply after the first) is an error we
      // expect; whether it is really gone is checked below.
      try {
        await gql('variableDelete', VARIABLE_DELETE, { input: { ...target, name: LEGACY_EGRESS_VARIABLE } });
      } catch (err) {
        console.log(JSON.stringify({ at: 'railway.setWorcaSettings', note: 'legacy variable not deleted', message: (err as Error).message.slice(0, 200) }));
      }
      // Read back: the next deploy runs with what Railway holds, so confirm it is exactly what was
      // meant, or fail (the settings stay pending, the operation shows as failed). Only names are
      // logged or thrown, never values; the map (secrets among it) is dropped here.
      const data = await gql<{ variables: Record<string, string> | null }>('variables', VARIABLES_READ, target);
      const held = data.variables ?? {};
      const wrong = Object.keys(want).filter((k) => held[k] !== want[k]);
      if (LEGACY_EGRESS_VARIABLE in held) wrong.push(`${LEGACY_EGRESS_VARIABLE} (still set)`);
      if (wrong.length) throw new Error(`railway setWorcaSettings: not confirmed on the worca service: ${wrong.join(', ')}`);
    },

    async worcaDeploymentState(ref) {
      const id = ref.services.worca.deploymentId;
      if (!id) return 'failed';
      const data = await gql<{ deployment: { status: string } | null }>('deploymentStatus', DEPLOYMENT_STATUS, { id });
      return deploymentState(data.deployment?.status ?? null);
    },

    async restartWorca(ref) {
      await assertOwnedProject(ref.projectId);
      return { ...ref, services: { ...structuredClone(ref.services), worca: await deployFromConfig(ref, 'worca') } };
    },

    async setGitSettings(ref, git: GitVariables) {
      await assertOwnedProject(ref.projectId);
      const envIdOf = envId(ref);
      const read = async (kind: 'worca' | 'broker') =>
        (await gql<{ variables: Record<string, string> | null }>('variables', VARIABLES_READ, { projectId: ref.projectId, environmentId: envIdOf, serviceId: ref.services[kind].serviceId }))
          .variables ?? {};
      const managed = { worca: WORCA_GIT_VARIABLES, broker: BROKER_GIT_VARIABLES } as const;
      for (const kind of ['worca', 'broker'] as const) {
        const target = { projectId: ref.projectId, environmentId: envIdOf, serviceId: ref.services[kind].serviceId };
        const { upsert, remove } = gitDiff(await read(kind), git[kind], managed[kind]);
        // New values first, in one upsert (it merges); then the names no longer wanted go, one by
        // one (variableDelete has no skipDeploys, see above). Already gone is fine: the read below decides.
        if (Object.keys(upsert).length) await gql('variableCollectionUpsert', VARIABLES_UPSERT, { input: { ...target, variables: upsert, skipDeploys: true } });
        for (const name of remove) {
          try {
            await gql('variableDelete', VARIABLE_DELETE, { input: { ...target, name } });
          } catch (err) {
            console.log(JSON.stringify({ at: 'railway.setGitSettings', note: 'variable not deleted', name, message: (err as Error).message.slice(0, 200) }));
          }
        }
      }
      // Read back both services: the next deploy runs with what Railway holds. Names only, never values.
      const wrong: string[] = [];
      for (const kind of ['worca', 'broker'] as const) {
        const held = await read(kind);
        for (const [name, value] of Object.entries(git[kind])) if (held[name] !== value) wrong.push(`${kind} ${name}`);
        for (const name of managed[kind]) if (name in held && !(name in git[kind])) wrong.push(`${kind} ${name} (still set)`);
      }
      if (wrong.length) throw new Error(`railway setGitSettings: not confirmed: ${wrong.join(', ')}`);
    },

    async restartBroker(ref) {
      await assertOwnedProject(ref.projectId);
      return { ...ref, services: { ...structuredClone(ref.services), broker: await deployFromConfig(ref, 'broker') } };
    },

    async setSecrets(ref, secrets) {
      await assertOwnedProject(ref.projectId);
      const perService = rotatedVariables(secrets);
      for (const kind of SERVICE_KINDS) {
        await gql('variableCollectionUpsert', VARIABLES_UPSERT, {
          input: { projectId: ref.projectId, environmentId: envId(ref), serviceId: ref.services[kind].serviceId, variables: perService[kind], skipDeploys: true },
        });
      }
      // Read back, as setWorcaSettings does: the restart that follows runs with what Railway holds.
      // Only names are thrown, never values; the maps are dropped here.
      const wrong: string[] = [];
      for (const kind of SERVICE_KINDS) {
        const data = await gql<{ variables: Record<string, string> | null }>('variables', VARIABLES_READ, {
          projectId: ref.projectId, environmentId: envId(ref), serviceId: ref.services[kind].serviceId,
        });
        const held = data.variables ?? {};
        for (const [name, value] of Object.entries(perService[kind])) if (held[name] !== value) wrong.push(`${kind} ${name}`);
      }
      if (wrong.length) throw new Error(`railway setSecrets: not confirmed: ${wrong.join(', ')}`);
    },

    async restartServices(ref) {
      await assertOwnedProject(ref.projectId);
      // From the current configuration, not a redeploy of the running deployment, so the variables
      // setSecrets just wrote surely apply. cloudflared last, as in deploy().
      const services = structuredClone(ref.services);
      for (const kind of SERVICE_KINDS) services[kind] = await deployFromConfig(ref, kind);
      return { ...ref, services };
    },

    async deploy(ref, image, kinds) {
      await assertOwnedProject(ref.projectId);
      const services = structuredClone(ref.services);
      for (const kind of SERVICE_KINDS.filter((k) => !kinds || kinds.includes(k))) {
        const { serviceId } = ref.services[kind];
        await gql('serviceInstanceUpdate', SERVICE_INSTANCE_UPDATE, {
          serviceId,
          environmentId: envId(ref),
          // worca's start command again: an upgrade also brings it to an instance created before it.
          input: { source: { image: image[kind] }, ...(kind === 'worca' ? { startCommand: WORCA_START } : {}) },
        });
        // UNVERIFIED: that serviceInstanceDeployV2 without commitSha deploys an image-sourced
        // service; it returns the new deployment's id.
        const data = await gql<{ serviceInstanceDeployV2: string }>('serviceInstanceDeployV2', DEPLOY, {
          serviceId,
          environmentId: envId(ref),
        });
        services[kind] = { serviceId, deploymentId: data.serviceInstanceDeployV2 };
      }
      return { ...ref, services };
    },

    async stop(ref) {
      await assertOwnedProject(ref.projectId);
      // D48: stop the latest deployment of each service; the volume stays. Then wait until
      // Railway says it no longer runs (see NOT_RUNNING above): deploymentStop's `true` only means
      // the request was taken. Railway refuses to stop a deployment that is still starting
      // ("Deployment is not stoppable", and it goes on to run), so one is stopped once it has
      // settled. Not confirmed in time: throw, so the step is retried (and stops again, which
      // Railway answers true for a deployment that is already stopped).
      const sleep = opts.sleep ?? defaultSleep;
      const pollMs = opts.stopPollMs ?? STOP_CONFIRM_POLL_MS;
      const deadline = Date.now() + (opts.stopTimeoutMs ?? STOP_CONFIRM_TIMEOUT_MS);
      const asked = new Set<string>();
      for (;;) {
        const states = await deploymentStates(ref);
        const running: ServiceKind[] = [];
        for (const kind of SERVICE_KINDS) {
          const d = states[kind];
          if (!d || deploymentIsStopped(d)) continue;
          running.push(kind);
          if ((d.status && IN_PROGRESS.has(d.status)) || asked.has(d.id)) continue;
          asked.add(d.id);
          try {
            await gql('deploymentStop', DEPLOYMENT_STOP, { id: d.id });
          } catch (err) {
            // Crashed or replaced since the read: the next read shows what it is now.
            if (!/not stoppable/i.test(String(err))) throw err;
            asked.delete(d.id);
          }
        }
        if (!running.length) return;
        if (Date.now() >= deadline) {
          const what = running.map((k) => `${k} ${states[k]!.id} ${states[k]!.status} deploymentStopped=${states[k]!.deploymentStopped}`);
          throw new Error(`railway: not stopped yet: ${what.join(', ')}`);
        }
        await sleep(pollMs);
      }
    },

    async start(ref, startOpts) {
      await assertOwnedProject(ref.projectId);
      const services = structuredClone(ref.services);
      for (const kind of SERVICE_KINDS) {
        // Variables changed while it was down (D72): a deployment from the service's current
        // configuration, not a redeploy of the stopped deployment, so they surely apply.
        if ((kind === 'worca' && startOpts?.worcaFromConfig) || (kind === 'broker' && startOpts?.brokerFromConfig)) {
          // A newer image pinned meanwhile (D76) is set first, so the deployment brings it too.
          const pinned = startOpts?.images?.[kind];
          if (pinned) await gql('serviceInstanceUpdate', SERVICE_INSTANCE_UPDATE, { serviceId: ref.services[kind].serviceId, environmentId: envId(ref), input: { source: { image: pinned } } });
          services[kind] = await deployFromConfig(ref, kind);
          continue;
        }
        // A newer image than the stopped deployment's (D76): set it, then deploy from the configuration.
        const image = startOpts?.images?.[kind];
        if (image) {
          await gql('serviceInstanceUpdate', SERVICE_INSTANCE_UPDATE, { serviceId: ref.services[kind].serviceId, environmentId: envId(ref), input: { source: { image } } });
          services[kind] = await deployFromConfig(ref, kind);
          continue;
        }
        const id = await latestDeploymentId(ref, kind);
        if (!id) throw new Error(`railway: no deployment to redeploy for ${kind}`);
        // UNVERIFIED: usePreviousImageTag reuses the image already pulled (faster wake, same version).
        const data = await gql<{ deploymentRedeploy: { id: string } }>('deploymentRedeploy', DEPLOYMENT_REDEPLOY, {
          id,
          usePreviousImageTag: true,
        });
        services[kind] = { serviceId: ref.services[kind].serviceId, deploymentId: data.deploymentRedeploy.id };
      }
      return { ...ref, services };
    },

    async deploymentStatuses(_refs) {
      const data = await gql<WorkspaceStatusData>('workspaceStatus', WORKSPACE_STATUS, { workspaceId: workspace() });
      const out: Record<string, ProjectStatus> = {};
      for (const { node: project } of data.workspace?.projects.edges ?? []) {
        // The workspace also holds the team's own projects: only ours are reported.
        if (!project.name.startsWith(prefix)) continue;
        const services: ProjectStatus = {};
        for (const { node: environment } of project.environments.edges) {
          for (const { node: si } of environment.serviceInstances.edges) {
            const kind = SERVICE_KINDS.find((k) => railwayServiceName(prefix, k) === si.serviceName);
            if (!kind) continue;
            const d = si.latestDeployment;
            // SUCCESS stays SUCCESS after deploymentStop; `stopped` is what tells them apart.
            const stopped = d ? deploymentIsStopped({ status: d.status, deploymentStopped: d.deploymentStopped ?? null }) : null;
            services[kind] = {
              state: d ? serviceState(d.status ?? null, stopped) : null,
              status: d?.status ?? null,
              statusUpdatedAt: d?.statusUpdatedAt ?? null,
              stopped,
            };
          }
        }
        out[project.id] = services;
      }
      return out;
    },

    async describe(ref) {
      // Read-only, one request. The ownership check comes from the same answer: a project that
      // isn't ours is refused before anything of it is returned.
      const environmentId = envId(ref);
      const data = await gql<ComputeFactsData>('computeFacts', COMPUTE_FACTS, {
        id: ref.projectId,
        environmentId,
        worca: ref.services.worca.serviceId,
        broker: ref.services.broker.serviceId,
        cloudflared: ref.services.cloudflared.serviceId,
      });
      const project = data.project;
      if (!project) throw new Error(`railway: project ${ref.projectId} not found`);
      if (!project.name.startsWith(prefix)) throw new Error(`railway: refusing to read project ${ref.projectId} (${project.name}): ${notOurs('')}`);
      const environment = project.environments.edges.find((e) => e.node.id === environmentId)?.node;
      const volumes = environment?.volumeInstances.edges.map((e) => e.node) ?? [];
      const services = {} as ComputeFacts['services'];
      for (const kind of SERVICE_KINDS) {
        const { serviceId } = ref.services[kind];
        const mine = volumes.filter((v) => v.serviceId === serviceId);
        const volume = mine.find((v) => v.mountPath === DATA_MOUNT_PATH) ?? mine[0];
        const used = num(volume?.currentSizeMB);
        services[kind] = {
          ...parseLimits(data[kind]),
          volumeMb: num(volume?.sizeMB),
          volumeUsedMb: used === null ? null : Math.round(used),
        };
      }
      const worca = environment?.serviceInstances.edges.find((e) => e.node.serviceId === ref.services.worca.serviceId)?.node;
      // A volume sits in the region its service was first placed in: the fallback before a deploy.
      const worcaVolume = volumes.find((v) => v.serviceId === ref.services.worca.serviceId);
      const region = deploymentRegion(worca?.latestDeployment?.meta) ?? worcaVolume?.region ?? null;
      return { region, services };
    },

    async destroy(ref) {
      // Deletes the project with its services and volume. A retried step finds it gone.
      if ((await assertOwnedProject(ref.projectId)) === 'gone') return;
      try {
        await gql('projectDelete', PROJECT_DELETE, { id: ref.projectId });
      } catch (err) {
        // UNVERIFIED: the exact error text for an already deleted project.
        if (!/not found|does not exist/i.test(String(err))) throw err;
      }
    },
  };
}

// P12, the system page: the workspace's plan and project count against its limit. Read-only.
const WORKSPACE_USAGE = 'query systemWorkspace($workspaceId: String!) { workspace(workspaceId: $workspaceId) { plan projectCount subscriptionPlanLimit } }';

async function railwayUsage(ctx: ProviderContext): Promise<ProviderUsage> {
  const account = railwayAccount(ctx.env, ctx.settings);
  const res = await ctx.fetch(RAILWAY_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: 'systemWorkspace', query: WORKSPACE_USAGE, variables: { workspaceId: account.workspaceId } }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { workspace?: { plan?: string; projectCount?: number; subscriptionPlanLimit?: unknown } };
    errors?: { message: string }[];
  } | null;
  if (body?.errors?.length) throw new Error(`railway: ${body.errors.map((e) => e.message).join('; ')}`);
  const ws = body?.data?.workspace;
  if (!res.ok || !ws) throw new Error(`railway: HTTP ${res.status}`);
  const limits = ws.subscriptionPlanLimit as { projects?: unknown } | null | undefined;
  return {
    plan: ws.plan ?? null,
    items: [{ label: 'projects', used: typeof ws.projectCount === 'number' ? ws.projectCount : null, limit: typeof limits?.projects === 'number' ? limits.projects : null }],
    details: ws.subscriptionPlanLimit ?? null,
  };
}

/** The built-in `railway` compute provider (providers/index.ts). */
export const railwayCompute: ComputeProviderDefinition = {
  info: RAILWAY_INFO,
  create: (ctx) => createRailwayProvider(ctx.env, ctx.fetch, { ...ctx.options, resourcePrefix: ctx.resourcePrefix, settings: ctx.settings }),
  missingConfig: (ctx) => {
    const a = railwayAccount(ctx.env, ctx.settings);
    return [...(a.token ? [] : [a.tokenName]), ...(a.workspaceId ? [] : ['RAILWAY_WORKSPACE_ID'])];
  },
  usage: railwayUsage,
};
