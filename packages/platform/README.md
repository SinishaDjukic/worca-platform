# @worca/platform

The management platform for hosted Worca instances: the control plane, the gate and the console,
on Cloudflare Workers, with compute providers for the instances (Railway built in).

A deployment depends on this package and re-exports its Workers:

```ts
// src/control.ts
import config from '../worca.config';
import { createControl } from '@worca/platform/control';
const control = createControl(config);
export default control.worker;
export const { ControlRpc, InstanceOpsWorkflow, KeyRotationWorkflow, NewsletterSendWorkflow } = control;
```

```ts
// src/gate.ts
import config from '../worca.config';
import { createGate } from '@worca/platform/gate';
const gate = createGate(config);
export default gate.worker;
export const { GateObject, GateRpc } = gate;
```

Start one with `npm create @worca/platform my-platform` (`@worca/create-platform`). Its wrangler
configs are generated from `worca.config.ts` by the `worca-platform` command this package
installs; they point `assets.directory` at `node_modules/@worca/platform/ui` and `migrations_dir`
at `node_modules/@worca/platform/migrations`.

| Command (`npm run …` in a deployment) | What |
|---|---|
| `setup` | D1 and KV found or created, migrations, generated keys and provider credentials, deploy; re-runnable |
| `deploy` | migrations, gate, control plane; `-- --dry-run` bundles only |
| `dev` | the local stack with fake providers and the stub instance server |
| `smoke` | one instance end to end (`-- --env dev` locally) |
| `secrets`, `admin`, `upgrade`, `configure` | secrets per Worker; the first superadmin; a new version; configs only |

Guide: `docs/deploy.md` in https://github.com/SinishaDjukic/worca-platform.

| Import | What |
|---|---|
| `@worca/platform` | `defineConfig`, `definePlatform`, config types, `resourceNames`, `wranglerVars` |
| `@worca/platform/control` | `createControl` |
| `@worca/platform/gate` | `createGate` |
| `@worca/platform/providers` | provider interfaces and the built-in providers |
| `@worca/platform/testing` | the compute provider conformance checks |
| `@worca/platform/smoke` | `runSmoke`, `devCaptureInbox`, `moduleInbox`: one instance end to end |

The Worca name, logo and mark are not covered by the MIT licence (`NOTICE`).
