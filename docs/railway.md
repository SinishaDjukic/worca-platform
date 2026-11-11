# Railway

Checked against Railway's pricing page and docs on 2026-10-06.

## What we use

- **Public API:** GraphQL at `backboard.railway.com/graphql/v2`. Manages projects, environments,
  services, variables, deployments (with rollbacks and logs), volumes, domains and templates.
- **Workspace token** for the provisioner, stored as a Worker secret. Not a personal account
  token, which reaches every workspace.
- **A template** containing worca, the broker, cloudflared and the volume, deployed once per
  instance, after which the provisioner sets that instance's variables.
- **Per-service CPU and memory limits**, set from the org's tier (D33).
- **EU region** (D6).
- **No public Railway domains.** Traffic arrives only through the instance's tunnel.
- **Stopping and redeploying** to suspend and wake an instance: `deploymentStop` on the latest
  deployment of each service, then `deploymentRedeploy` (D48). A stopped deployment keeps the
  status `SUCCESS`; see [Stopping and waking](#stopping-and-waking).

## Plan limits

| | Hobby ($5/month) | Pro ($20/month per workspace) | Enterprise |
|---|---|---|---|
| Projects | 50 | **100** | custom |
| Services | 50 | 100 | custom |
| Max per service | 48 vCPU / 48 GB | 1,000 vCPU / 1 TB | custom |
| Replicas | 6 | 42 | custom |
| Volume size | 5 GB | 1,000 GB | custom |
| API rate | 1,000/hour, 10/s | 10,000/hour, 50/s | custom |
| Log history | 7 days | 30 days | custom |

New accounts may also create only **25 services per day** (observed 2026-10-06: `serviceCreate`
answers "You've hit the service creation limit for new accounts (25 services per day)"). Each
instance is 3 services, so a new account creates at most 8 instances a day, smoke runs included;
the limit is raised through Railway support. Upgrading to Pro does not lift it (checked
2026-10-07, minutes after the upgrade).

Usage (CPU, memory, storage, outbound traffic) is billed per minute on top; the plan fee counts as
included usage. A vCPU is about one hardware thread of compute time. The limits are ceilings, not
allocations.

## What the limits mean for us

- **At most 100 instances per Pro workspace**, since every instance is its own project (D4).
  Railway says it raises limits within a tier on request. Beyond that: Enterprise, or several
  workspaces with one token each.
- **Railway's spending cap covers the whole workspace** and shuts everything down when reached.
  Keep it as a final safety net only; per-tenant limits are ours.
- **App sleeping and serverless mode don't work for us.** Railway sleeps a service only after
  5–10 minutes with no outbound traffic, and cloudflared and the heartbeat are always outbound.
- **No scaling to zero.** The API refuses 0 replicas ("must be greater than or equal to 1").
  We suspend instances ourselves by stopping their deployments (see
  [Instance lifecycle](instance-lifecycle.md#suspend-and-wake)).
- **Per-tenant cost** comes from Railway's per-project usage figures.

## Terms of service

Railway's Acceptable Use Policy forbids "reselling compute resources". Whether a hosting platform
built on this package is allowed is between you and Railway: see the caveat in
[Deploying your own platform](deploy.md#two-things-to-know-before-you-open-it-to-others), and ask
Railway support before you charge for instances.

## Other findings

- **Project cap:** 100 on Pro per the pricing page; a Railway employee wrote in 2025-11 that
  projects are "uncapped as of right now". Limits are raised by support request; new accounts
  can create at most 25 services per 24 hours, and support won't raise that.
- **Webhooks:** per project, for deployment status changes and volume and CPU/RAM alerts. Created
  through the API with `notificationRuleCreate`. Not signed; Railway lets you add up to 20 custom
  headers, so we send a secret header and check it.
- **Stopping:** `deploymentStop(id)`, `deploymentRedeploy(id, usePreviousImageTag)` and
  `serviceInstanceRedeploy(serviceId, environmentId)` all exist; how the first two behave is in
  [Stopping and waking](#stopping-and-waking). Forum reports say a stopped service keeps its volume
  and pays only for storage ($0.15/GB-month); still to be tested.
- **Start time** from an already built image: reported at about 1 second on a warm host and 7 on
  a cold one. Nothing official.
- **Usage per project** is available through the API (`usage`, `estimatedUsage`,
  `projectServiceUsage`), so per-tenant cost can be computed.
- **Volume backups** exist (manual or scheduled); not used, per D32.

Sources: [pricing](https://railway.com/pricing), [public API](https://docs.railway.com/reference/public-api),
[app sleeping](https://docs.railway.com/reference/app-sleeping), [cost control](https://docs.railway.com/pricing/cost-control),
[manage deployments](https://docs.railway.com/guides/manage-deployments),
[0 replicas refused](https://station.railway.com/questions/how-to-change-the-number-of-replicas-via-5004dcb8),
[webhooks](https://docs.railway.com/guides/webhooks), [volumes](https://docs.railway.com/reference/volumes),
[project limit thread](https://station.railway.com/questions/is-there-a-limit-on-number-of-projects-p-f7c93058),
[start times thread](https://station.railway.com/questions/highly-variable-cold-start-time-on-serve-87f07805).

## Stopping and waking

Verified against the live API on 2026-10-06 with two throwaway projects (`<prefix>-probe-*`,
deleted afterwards): one `nginx:alpine` service, which runs, and one `cloudflare/cloudflared` with
`tunnel run` and no token, which crashes the way worca 1.8.0 does. The queries were the ones
`railway.ts` uses.

| What we did | What Railway answered and reported |
|---|---|
| `deploymentStop` on a running `SUCCESS` deployment | `true` at once. The deployment's `status` **stays `SUCCESS`**; it is still the service's `latestDeployment`, `deployments(first: 1)` and in `activeDeployments`. About 15 s later its `deploymentStopped` turns `true` and its instance shows `EXITED`. Nothing else changed in the following 4 minutes. |
| `deploymentStop` again on that stopped deployment | `true` again (safe to repeat). |
| `deploymentStop` on a `CRASHED` deployment | Error `Deployment is not stoppable`. |
| `deploymentStop` 2 s after deploying (`INITIALIZING`) | Error `Deployment is not stoppable`; the deployment went on to `SUCCESS` and ran. A second `deploymentStop` once it was `SUCCESS` stopped it as above. |
| `deploymentStopped` while a deployment is `INITIALIZING` or `DEPLOYING`, or `CRASHED` | Already `true`: it means "no instance runs right now", not "was stopped". |
| `deploymentRedeploy(id, usePreviousImageTag: true)` on the stopped `SUCCESS` deployment and on the `CRASHED` one | A new deployment each (`INITIALIZING`, `SUCCESS` about 13 s later for nginx). It is the newest: `deployments(first: 1)` and `latestDeployment` return it. The old one becomes `REMOVED`. |
| `deployments(input, first: 1)` | Always the same deployment as the service instance's `latestDeployment`, the newest. |
| `deploymentStop` on a service whose process **exits non-zero** on SIGTERM (2026-10-07, `node:22-alpine` exiting 143, `drainingSeconds` 60) | The process gets SIGTERM and exits, but the deployment stays `SUCCESS` with `deploymentStopped: false` and its instance `RUNNING`, for as long as we watched (13 minutes for worca). The same with restart policy `ON_FAILURE` and `NEVER`. Repeating `deploymentStop` changes nothing. The same service exiting 0 was `EXITED`, `deploymentStopped: true` within 15 s. |

What follows for us:

- **`status` alone can't tell a stopped service from a running one.** A service counts as stopped
  when its latest deployment is `REMOVED`, `REMOVING`, `FAILED`, `CRASHED` or `SKIPPED`, or has
  `deploymentStopped` and isn't still starting (`BUILDING`, `DEPLOYING`, `INITIALIZING`, `QUEUED`,
  `WAITING`, `NEEDS_APPROVAL`). `deploymentIsStopped` in `railway.ts` is that rule; the provider
  status (P1) reports it as `stopped` next to `status`, and the platform console shows
  "SUCCESS · stopped".
- **`stop()` confirms.** It reads every service's latest deployment in one query, stops the
  running ones, waits for a starting one to settle and then stops it, and polls every 5 s until
  all count as stopped. Not within 2 minutes: it throws, and the Workflow step is retried.
- **The production smoke run of 2026-10-06** saw cloudflared at `SUCCESS` for 10 minutes after a
  stop that had finished: that was a stopped deployment (worca and the broker were `CRASHED`, so
  `deploymentStop` was rightly skipped for them). The smoke test now reads `deploymentStopped`.
- **A service must exit 0 on SIGTERM**, or a stop never takes (row above). worca 1.9.0 drains and
  exits 143, so its stop hung (production smoke run of 2026-10-07; worca logged
  `[worca-ui] stopping (SIGTERM)` and exited, the deployment stayed `RUNNING`). The provider starts
  worca with `tini -s -e 143 -- worca-entrypoint worca ui` (`WORCA_START` in `railway.ts`): the
  image's own entrypoint, with tini reporting 143 as 0. Verified on Railway with the 1.9.0 image:
  stopped in 11 s, against still `RUNNING` after 2 minutes with the image's entrypoint. worca's
  image does the same from the release after 1.9.0 (worca-cc PR #610). cloudflared and the broker
  already exit 0. The start command is set on create and on every deploy (upgrade, rollback), so
  instances created before it get it with their next upgrade.
- Crashed services can't be stopped and don't need to be. The crashed probe service stayed
  `CRASHED` for the 4.5 minutes we watched; whether Railway's restart policy can ever bring a
  `CRASHED` deployment back by itself was not seen.

## Provisioning API calls

Used by `src/control/providers/railway.ts`. Names, arguments and input fields were checked against
the live schema (introspection of `backboard.railway.com/graphql/v2`, which works without a token)
and the docs on 2026-10-06; behaviour that the schema can't show has not been tried against the
real API.

| Step | Call | Status |
|---|---|---|
| create | Lookups first, so a retried step finishes the same project (instance-lifecycle.md, "Retries are safe"): `workspace(workspaceId) { projects(first: 100) { id name deletedAt } }` by name, then `project(id) { environments { volumeInstances { serviceId mountPath } } services { id name } }` | field names checked against the live schema 2026-10-06 |
| create | `projectCreate(input: { name: "<prefix><first 22 hex digits of the instance id>", workspaceId, defaultEnvironmentName })`, environment id from `environments.edges`. Names are limited to 32 characters | verified in production 2026-10-06 |
| create | `serviceCreate(input: { projectId, environmentId, name: "<prefix><service>" })`, no source yet | verified |
| create | `serviceInstanceUpdate(serviceId, environmentId, input: { region: "europe-west4-drams3a", startCommand })` | verified; whether `region` or `multiRegionConfig` is preferred: unverified |
| create | `serviceInstanceLimitsUpdate(input: { serviceId, environmentId, vCPUs, memoryGB })` (D33) | verified |
| create | `volumeCreate(input: { projectId, environmentId, serviceId, mountPath: "/data", region })`, once for worca and once for the broker (its encrypted key store; a volume belongs to one service) | verified; **no size field**, so the tier's volume size can't be set at creation |
| variables | `variableCollectionUpsert(input: { projectId, environmentId, serviceId, variables, skipDeploys: true })`; the per-service list is in `railwayVariables` (railway.ts), including the broker in multi mode (D68) | verified |
| rotate (D74) | `variableCollectionUpsert` of the renewed variables per service (`rotatedVariables`, railway.ts), read back with `variables`; then `serviceInstanceDeployV2` per service for a running instance (`restartServices`) | upsert verified; that a new deployment picks up changed variables: verified by hand on 2026-10-23 (the incident rotation); `serviceInstanceDeployV2` for image sources: unverified, as for deploy |
| deploy | `serviceInstanceUpdate(input: { source: { image } })`, then `serviceInstanceDeployV2(serviceId, environmentId)` → deployment id | names verified; deploying an image source without `commitSha`: unverified |
| refresh (D76) | The same as deploy, for cloudflared only; on a wake, `serviceInstanceUpdate(input: { source: { image } })` then `serviceInstanceDeployV2` for an out-of-date cloudflared instead of `deploymentRedeploy` | as for deploy; confirmed by the connector version Cloudflare reports |
| suspend | `project(id) { environments { serviceInstances { serviceId latestDeployment { id status deploymentStopped } } } }`, then `deploymentStop(id)` for each running one, then the same query every 5 s until all are stopped (D48) | verified 2026-10-06, see [Stopping and waking](#stopping-and-waking) |
| wake | `deployments(input: { projectId, environmentId, serviceId }, first: 1)`, then `deploymentRedeploy(id, usePreviousImageTag: true)` (D48) | verified 2026-10-06 on a stopped and a crashed deployment; what `usePreviousImageTag` changes for image sources: unverified |
| delete | `projectDelete(id)` | verified; afterwards `project(id)` fails with `Project not found` (2026-10-06); the error text of a repeated delete: unverified |

Not used: `serviceDomainCreate` (no public domains). Services reach each other at
`<prefix><service>.railway.internal`; the tunnel's ingress points there.

## Region

`serviceInstanceUpdate` takes the region as `multiRegionConfig: { "europe-west4-drams3a": { numReplicas: 1 } }`.
The older `region` field is accepted but ignored: every instance created before 2026-10-07 runs in US
West (`sfo`), whatever it asked for. The volume follows the region given to `volumeCreate`. A
volume's default size on the Pro plan is 50 GB (`sizeMB: 50000`); `volumeCreate` takes no size.

## Compute facts

`describe()` (providers/railway.ts) reads what an instance really has, in one GraphQL request
(verified 2026-10-07 on live projects):

- `project(id) { name environments { edges { node { id volumeInstances { edges { node { serviceId mountPath region sizeMB currentSizeMB } } } serviceInstances { edges { node { serviceId latestDeployment { meta } } } } } } } }`
- `worca: serviceInstanceLimits(serviceId, environmentId)`, and the same aliased as `broker` and
  `cloudflared`: JSON `{"containers":{"cpu":2,"memoryBytes":4000000000,"pidLimit":1000}}`. Railway
  counts in decimal units (4 GB = 4,000,000,000 bytes), so facts store memory as decimal MB (4000).
- Region: the key of `meta.serviceManifest.deploy.multiRegionConfig` of the worca service's latest
  deployment (`{"sfo":{"numReplicas":1}}` for US West; `region` there and `ServiceInstance.region`
  are null). Falls back to the worca volume's `region` before a first deploy.
- Sizes: the same ceiling is applied to every service (`serviceInstanceLimitsUpdate`); worca and
  the broker each have a 50 GB volume (`sizeMB`, usage `currentSizeMB`), cloudflared none.

The project's `name` comes back in the same answer and must start with the deployment's
resource prefix (`RESOURCE_PREFIX`, `{name}-`); anything else is refused. Region ids: `sfo`/`us-west2` US West (California), `us-west1` US West (Oregon),
`us-east4-eqdc4a` US East (Virginia), `europe-west4-drams3a` EU West (Amsterdam),
`asia-southeast1-eqsg3a` Southeast Asia (Singapore) (the `regions` query lists them).
