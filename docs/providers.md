# Compute providers

The platform runs each Worca instance as three services: `worca`, its credential `broker`, and
`cloudflared`, the tunnel that connects the instance to Cloudflare. A **compute provider** creates
and runs those services somewhere. Two are built in:

- **`railway`** creates one Railway project per instance (see [railway.md](railway.md)).
- **`fake`** drives the local stub server (`packages/platform/stub/instance.mjs`) for development and tests.

A deployment can add its own provider without forking: Kubernetes, Azure Container Apps, AWS ECS,
Fly or anything else that can run three containers on a private network.

The **edge provider** handles the tunnel and DNS. It is `cloudflare` (or `fake`) and isn't
pluggable yet. It gets the addresses it routes to from the compute provider.

What the containers expect is described in worca-cc's
[`docs/instance-contract.md`](https://github.com/SinishaDjukic/worca-cc/blob/dev/docs/instance-contract.md):
images, start commands, ports, volumes and variables. The platform renders that contract as
variables in `src/control/providers/instance-env.ts`, so every provider sets the same ones.

## Registering a provider

```ts
// src/control.ts of a deployment
import config from '../worca.config';
import { definePlatform } from '@worca/platform';
import { k8sCompute } from './k8s-provider';

definePlatform(config, { providers: { compute: { k8s: k8sCompute } } });
```

```ts
// worca.config.ts
providers: { compute: 'k8s', edge: 'cloudflare', region: 'eu-central' },
```

The config becomes the Worker's `COMPUTE_PROVIDER`, `COMPUTE_REGION` and `RESOURCE_PREFIX`
variables. `definePlatform` runs at module load, so Workflows and RPC classes see the provider too.
The names `railway` and `fake` are reserved. The registry is in `src/control/providers/index.ts`.

## The definition

A provider is a `ComputeProviderDefinition` (`src/control/providers/types.ts`):

```ts
interface ComputeProviderDefinition {
  info: ComputeProviderInfo;                       // what it is, without calling it
  create(ctx: ProviderContext): ComputeProvider;   // its API client
  missingConfig?(ctx: ProviderContext): string[];  // what's missing, for "not configured"
  usage?(ctx: ProviderContext): Promise<ProviderUsage>; // plan and usage for the system page
}

interface ProviderContext {
  env: Env;                 // the control plane's vars and secrets (put your token there)
  fetch: Fetch;             // use this, not the global fetch (tests inject it)
  resourcePrefix: string;   // e.g. "acme-": name everything you create with it
  settings: SettingValues;  // the deployment's provider settings (see Settings)
  options?: ProviderOptions;
}
```

`info` is read by the consoles, the tier editor, the egress rules and the tunnel set-up. None of
them call the provider:

| Field | Meaning |
|---|---|
| `displayName` | Shown wherever the consoles name the provider. |
| `sizes`, `defaultSize` | The compute sizes (D78): the worca service's vCPU and memory ceiling, plus `maxParallel` / `maxParallelScripts`. Ids are stored on instances and tiers, so never change what an id means. `STANDARD_SIZES` (`standard`, `large`, `xl`) is there to reuse. |
| `defaultRegion`, `regions` | Where new instances go unless `COMPUTE_REGION` says otherwise, and labels for the region ids you report. A reported id matches an entry exactly, or as `{id}-…`. `eu` flags EU regions (D6). |
| `capacity` | A per-account limit shown on the overview before it runs out (Railway: 100 services, three per instance), or `null`. |
| `egressEnforcement` | `'worca'` when the policy only reaches Worca as `WORCA_EGRESS_*` (D73), `'provider'` when your network enforces it too. |
| `serviceHost(prefix, kind)` | The host a service answers at on the instance's private network. Worca reaches the broker there, and the tunnel reaches worca (`:4317`) and the broker's key page (`:8081`). Never route the broker's private port, `:8080`. |

## Settings

A provider declares the settings it needs as data, in `info.settings`. The console renders them
for any provider, so the provider never ships any UI. The platform stores them, checks them against
the declaration on every write, and hands them to the provider on every call:

```ts
settings: {
  deployment: [   // set once by a superadmin: Operations → Provider settings
    { key: 'workspaceId', kind: 'text', label: 'Workspace ID', pattern: '[A-Za-z0-9-]{1,64}' },
    { key: 'tokenSecret', kind: 'secret', label: 'API token', default: 'RAILWAY_TOKEN', required: true },
  ],
  instance: [     // set per instance by its tenant admins: new-instance form and the instance page
    { key: 'nodePool', kind: 'select', label: 'Node pool', options: [{ value: 'std', label: 'Standard' }], default: 'std' },
  ],
}
```

`SettingField` is defined in `src/control/providers/settings.ts`:

| Property | Meaning |
|---|---|
| `key` | camelCase. Values are kept by key, so never rename one. |
| `kind` | `text`, `number`, `boolean`, `select` or `secret`. |
| `label`, `help` | What the console shows. |
| `default` | Used while nothing is saved. |
| `required` | Must have a value, either saved or defaulted. |
| `pattern`, `patternMessage`, `maxLength` | `text` only. `pattern` must match the whole value. |
| `min`, `max`, `integer` | `number` only. |
| `options` | `select` only: `{ value, label }`. |

A `secret` field holds the **name** of a Worker secret (`RAILWAY_TOKEN`), never its value.
Superadmins set the value with `wrangler secret put`. The provider reads `ctx.env[name]`. The
console shows whether a secret of that name is set, never what it holds. A value that looks like a
key rather than a name (lowercase, `sk-…`) is refused.

Where the values go:

- **Deployment values** are stored in `platform_settings` under the key `compute_settings`.
  `ProviderContext.settings` holds them: the defaults, overlaid by what a superadmin saved. Only
  operations, polls and checks started after a save use the new values.
- **Instance values** are stored in `instances.provider_settings` (migration 0032).
  `InstanceSpec.settings` (create) and `ComputeRef.settings` (every other call) hold them. The
  platform attaches them when it reads the instance and never stores them inside the compute ref.
  A tenant admin's change is stored at once and reaches the provider with the instance's next
  operation. Saving doesn't restart anything.
- **Both scopes** are stored as `{"provider": name, "values": {...}}`, so values saved for another
  provider are ignored after a switch. Keys the provider no longer declares, and values that no
  longer fit, fall back to the default.
- **Audit** records the keys that were saved, never the values (`platform.provider_settings_set`,
  `instance.provider_settings_set`).

Railway uses this mechanism like any other provider. Its deployment settings are the workspace and
the name of its token secret. Left unset, they fall back to the `RAILWAY_WORKSPACE_ID` var and the
`RAILWAY_TOKEN` secret, as before. It has no instance settings. The `fake` provider declares one
setting per scope (`stubLabel`, `note`), so the console's generic fields are exercised locally.

## The interface

`ComputeProvider` is implemented by `railway.ts` and `fake.ts`. Each method is one step of an
instance operation (`src/control/instances/ops.ts`):

| Method | Called by | Must |
|---|---|---|
| `createProject(spec)` | create | Make the instance's group (project, namespace, …) and its three services, configured but not running. Volumes go on worca and the broker. The worca service gets `spec.cpu` / `spec.memoryMb`; the others get your own ceiling. Return a `ComputeRef`. |
| `findProject(instanceId)` | delete | Find the group by its name, for a create that failed before the ref was saved. `null` if there is none. |
| `setVariables(ref, vars)` | create | Write every service's variables (`instanceEnvironment(vars, brokerHost)` plus your own). Don't deploy. |
| `deploy(ref, images, kinds?)` | create, upgrade | Set the images and deploy every service, or only `kinds`. Return the ref with new deployment ids. |
| `stop(ref)` | suspend, stop | Stop all services, keeping the volumes. Resolve only once nothing runs. Throw if that doesn't happen in time, and the step is retried. |
| `start(ref, opts)` | wake, lift | Start them again. With `worcaFromConfig` / `brokerFromConfig`, deploy from the current configuration, so variables changed while stopped apply. With `images`, run those images. |
| `setWorcaSettings(ref, s)` | reconfigure | Write `worcaSettingsVariables(s)` and the size's ceiling on worca, and remove `WORCA_EGRESS_ALLOWLIST`. Read them back and throw if they differ. Don't deploy. |
| `restartWorca(ref)` | reconfigure | Deploy worca from its current configuration. |
| `worcaDeploymentState(ref)` | reconfigure | `running`, `starting` or `failed` for the deployment `restartWorca` made. |
| `setGitSettings(ref, git)` | git settings | Upsert the given git variables on worca and the broker, and remove the managed names that aren't given (`gitDiff`). Read back and throw naming variables, never values. |
| `restartBroker(ref)` | git settings | Deploy the broker from its current configuration. |
| `setSecrets(ref, secrets)` | rotate | Write `rotatedVariables(secrets)`, read back and throw if they differ. Don't deploy. |
| `restartServices(ref)` | rotate | Deploy every service from its current configuration, cloudflared last. |
| `destroy(ref)` | delete | Delete the group and its volumes. |
| `deploymentStatuses(refs)` | cron, every 5 minutes | Each service's latest deployment by project id. Set `state` (`running`, `starting`, `stopped`, `failed`) and, if you like, your own word as `status`. Use as few requests as you can. |
| `describe(ref)` | after create and upgrade; cron | The region and each service's real cpu, memory and volume (`ComputeFacts`). One request if possible. |

### Lifecycle

1. **Create:** `createProject` → `setVariables` → `deploy`.
2. **Running:** `setWorcaSettings` → `restartWorca`; `setGitSettings` → `restartBroker`;
   `setSecrets` → `restartServices`; `deploy` for upgrades.
3. **Suspended or stopped:** `stop`, then later `start`.
4. **Delete:** `stop` if needed, then `destroy` (or `findProject` → `destroy`).

### Retries and idempotency

Every call is one step of a Cloudflare Workflow (`instances/workflow.ts`). A step that throws is
retried up to 5 times with exponential backoff, and each attempt has 5 minutes. Steps also run
again after the Worker restarts. So:

- **Make every call safe to run again.** A call may have succeeded at your end while the answer
  was lost. `createProject` must look for what an earlier attempt made (by a deterministic name
  built from `resourcePrefix` and the instance id) and finish it. Don't make a second one.
- **Treat "already gone" as done** for `destroy`, and "already stopped" as done for `stop`.
- **Only touch what is yours.** Check that a resource's name starts with `resourcePrefix` before
  changing or reading it, and refuse otherwise. The platform's account may hold other things.
- **Confirm, then return.** `stop`, `setWorcaSettings`, `setGitSettings` and `setSecrets` resolve
  only once your API confirms the change. Throw otherwise, so the step is retried and the
  operation shows as failed rather than silently half-done.
- **Keep secrets out of logs and errors.** Throw messages name variables, never values. Variables
  hold the broker secret, vault key, tunnel token, heartbeat credential and git tokens.
- **Start error messages with your provider's name** (`k8s: …`). The platform attributes a failure
  to the compute side by that name and shows tenants only a category, never your text (D15).
- **Mind the request budget.** `deploymentStatuses` runs every 5 minutes, and `describe` runs for
  a few instances per tick. Use `fetchWithRetry` (`providers/http.ts`) for 429s.

## Conformance checks

`src/testing/compute-conformance.ts` (published as `@worca/platform/testing`) checks the rules
above against a test account or a fake of one:

```ts
import { computeProviderChecks } from '@worca/platform/testing';

for (const check of computeProviderChecks({
  definition: k8sCompute,
  prefix: 'conformance-',
  provider: () => k8sCompute.create({ env: testEnv, fetch, resourcePrefix: 'conformance-' }),
})) it(check.name, check.run);
```

The checks don't depend on a test framework: each one is a name and an async function that throws.
Every check makes its own instance and deletes it again. The built-in providers run them in
`test/unit/control/providers-conformance.test.ts`: `railway` against a simulated Railway API, and
`fake` against a simulated stub.

## A skeleton

```ts
import { STANDARD_DEFAULT_SIZE, STANDARD_SIZES } from '@worca/platform/providers';
import { instanceEnvironment, rotatedVariables, worcaSettingsVariables, gitDiff } from '@worca/platform/providers';
import type { ComputeProviderDefinition, ComputeProvider } from '@worca/platform/providers';

const host = (prefix: string, kind: string) => `${prefix}${kind}.instances.svc.cluster.local`;

export const k8sCompute: ComputeProviderDefinition = {
  info: {
    displayName: 'Kubernetes',
    sizes: STANDARD_SIZES,
    defaultSize: STANDARD_DEFAULT_SIZE,
    defaultRegion: 'eu-central',
    regions: [{ id: 'eu-central', label: 'EU Central', eu: true }],
    capacity: null,
    egressEnforcement: 'worca',
    serviceHost: host,
    settings: {
      deployment: [
        { key: 'apiUrl', kind: 'text', label: 'API server', required: true, pattern: 'https://.+' },
        { key: 'tokenSecret', kind: 'secret', label: 'Service account token', default: 'K8S_TOKEN', required: true },
      ],
    },
  },
  missingConfig: ({ env, settings }) => (env[settings.tokenSecret as string] ? [] : [String(settings.tokenSecret)]),
  create({ env, fetch, resourcePrefix, settings }): ComputeProvider {
    const ns = (instanceId: string) => `${resourcePrefix}${instanceId}`;
    return {
      name: 'k8s',
      async createProject(spec) {
        // Find namespace ns(spec.instanceId), else create it; then the three Deployments
        // (replicas 0), Services and PVCs, each only if missing.
        throw new Error('k8s: not implemented');
      },
      async setVariables(ref, vars) {
        const env = instanceEnvironment(vars, host(resourcePrefix, 'broker'));
        // One Secret per service from env.worca / env.broker / env.cloudflared.
        throw new Error('k8s: not implemented');
      },
      // … the other methods as in the table above
    } as ComputeProvider;
  },
};
```

Import the types and the built-in providers from `@worca/platform/providers`, and the
conformance checks from `@worca/platform/testing` (their source is under
`packages/platform/src/control/providers/` and `packages/platform/src/testing/`).
