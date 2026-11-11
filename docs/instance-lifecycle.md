# Instance lifecycle

```
creating ──► running ◄──► suspended         idle only; the next visit wakes it
               │  ▲
               ▼  │
            upgrading

 running / suspended ──► stopped            abuse only; only platform staff lift it
 stopped ──► running

 running / suspended / stopped ──► deleting ──► (gone)
```

Every status change is written to both the instance row and the instance's gate object. The gate
acts on the gate object's copy (D43).

## Create

The request reserves two slugs and writes the instance row with status `creating` (refused with
`tier_limit` when the org already has as many instances as its tier allows, D33), stores any team
grants and login policy sent with it, records the operation, and starts the Workflow. The org's
tier decides the CPU, memory and volume limits set on the Railway services. The Workflow's steps,
each retried on failure and resumable, in this order (`instances/ops.ts`):

1. `load`: read the row and the latest worca version.
2. `create project`: the Railway project with its services and volume, EU region.
3. `create tunnel`: the Cloudflare Tunnel. It comes before the variables, which carry its token.
4. `add dns`: the two proxied DNS records pointing at the tunnel.
5. `gate hosts`: tell the gate the two hosts (the gate's KV entries and object). This comes before
   the deploy so the gate already knows the instance when the first heartbeat arrives.
6. `set variables`: tunnel token, allowed host, identity issuer and audiences, heartbeat URL and a
   new heartbeat credential (only its hash is stored), the outbound network policy (D73), and the credential broker
   in multi mode (D68): a new shared secret for worca and the broker and a new vault key, which
   exist only in the instance's Railway variables. All of them are generated inside this one step
   and none is returned from it, so a retry generates and applies a fresh, consistent set and no
   secret reaches the Workflow's stored step results. Deploys, upgrades and wakes never set
   variables again, so the secrets stay the same for the instance's life.
7. `deploy`: deploy the image for the latest version.
8. Wait for the first heartbeat: poll every 10 seconds for up to 10 minutes. The heartbeat handler
   moves the instance from `creating` to `running` and tells the gate.
9. `notify created`: audit entry and an email to the tenant admins.

If no heartbeat arrives, the instance stays `creating` with the error `no_heartbeat`, the tenant
admins are told, and platform staff see the operation as stuck or failed. The tenant admin can
delete it and create it again. Any other failure is recorded as `create_failed: <message>`.
[Architecture](architecture.md#creating-an-instance) has the longer description.

## Operations and their phases

Every create, upgrade, wake, suspend, stop, lift, delete, reconfigure, rotate and refresh is one `InstanceOpsWorkflow` run and
one `instance_ops` row, written when it starts and from inside every step
(`instances/progress.ts`). The Workflow's own step names are internal; the row carries a
user-facing phase from `OP_PHASES`, so a console can show a progress bar without asking the
Workflows API. Phases in order (an upgrade can also pass through `rolling_back`):

| Operation | Phases | Steps that set each phase |
|---|---|---|
| create | `reserving`, `compute`, `network`, `starting`, `waiting`, `ready` | `load`; `create project`; `create tunnel`, `add dns`, `gate hosts`; `set variables`, `deploy`; first heartbeat check; `notify created` |
| rotate | `preparing`, `renewing`, `restarting`, `waiting`, `ready` | `load`; `renew secrets`; `restart services`; new credential check, tunnel check; `finish`. Suspended and stopped instances go from `renewing` to `finish` |
| upgrade | `preparing`, `deploying`, `waiting`, `ready` | `load`; `set worca settings` (only when pending), `deploy new version`; new version check; `mark applied` (only when pending); `notify upgraded`. `roll back` sets `rolling_back` |
| wake, lift | `starting`, `waiting`, `ready` | `load`, `set worca settings` (only when pending), `start services`; heartbeat check; `mark applied` (only when pending), new connector check and `record images` (only when cloudflared was out of date) |
| refresh | `preparing`, `deploying`, `waiting`, `ready` | `load`; `deploy components`; new connector check; `finish` |
| suspend | `stopping`, `suspended` | `load`, `stop services`; `mark suspended` |
| stop | `stopping`, `stopped` | `load`, `gate stopped`, `stop services` |
| delete | `closing`, `compute`, `network`, `cleanup`, `deleted` | `load`, `gate deleting`; `destroy compute`; `delete edge`; `revoke heartbeat credential`, `destroy gate object`, `delete rows` |
| reconfigure | `preparing`, `applying`, `restarting`, `ready` | `load`; `set worca settings` (remote access and the outbound network policy, read back); `restart worca`; `confirm restart: check` (until the new deployment runs); `mark applied`. Settings changed meanwhile: another round, steps suffixed ` (2)`, ` (3)` |

A step that finishes the operation successfully moves it to the last phase. The row's status is
`running`, `done` or `failed`; an operation that stopped because the instance moved on (deleted,
stopped meanwhile: outcomes `aborted`, `gone`, `skipped`, `already_gone`) counts as `done`.

- **Tenants** see the latest operation of an instance as kind, phase, the phase list and times.
- **Platform staff** also see the Workflow step, attempts of the current step and the last error
  (`GET /api/platform/ops`). A running operation is *stuck* when it has sat in one phase for 15
  minutes (the heartbeat wait alone may take 10) or has entered one step 3 times. A step is retried
  up to 5 times with exponential backoff, each try limited to 5 minutes.
- Rows are kept 30 days after the operation finishes; the daily cron deletes older ones.

### Retries are safe

A step may fail after its provider call succeeded (the answer was lost, or a later call in the same
step failed), and the retry runs the whole step again. Every provider step therefore looks before
it creates (`providers/railway.ts`, `providers/cloudflare.ts`):

| Step | What a retry does |
|---|---|
| `create project` | Finds the project by its deterministic name (`worca-run-` plus 22 hex digits of the instance id, ignoring deleted projects), then reuses its environment, its services by name and its volumes by service and mount path, creating only what is missing. Region, start command and limits are plain updates. A half-built project is no longer deleted on failure: the retry finishes it, which also avoids Railway's one-new-project-per-30-seconds limit. |
| `create tunnel` | Finds a live tunnel named `worca-run-<instance id>` before creating one, and looks again if the create fails (its answer may have been lost). The configuration is a PUT of the whole ingress and the token a read, so both repeat safely against that tunnel. |
| `add dns` | Upserts each host's CNAME: a record from an earlier attempt (comment `worca-run <instance id>`) is reused, and pointed at the current tunnel if it isn't; a record for the host that we didn't make is never touched, and the step fails instead. |
| `set variables` | `variableCollectionUpsert` replaces the values; the step generates and applies a fresh set of secrets (see Create). |
| `deploy`, `start services` | A repeat starts one more deployment of the same image; the latest one wins. |
| `stop services` | Nothing is stopped twice by mistake: a deployment with nothing running (`REMOVED`, `REMOVING`, `FAILED`, `CRASHED`, `SKIPPED`, or `SUCCESS` with `deploymentStopped`) is left alone, and `deploymentStop` on one already stopped answers true again. The step only succeeds once Railway reports every service stopped ([Railway](railway.md#stopping-and-waking)); otherwise it throws and is retried. |
| delete steps | Deleting something already gone counts as done. |

If a create fails for good half-way through a step, what that step made was never recorded on the
instance. The delete covers that: without a saved compute ref it looks the Railway project up by
name, and it always looks up the tunnel by name and the DNS records by host and this instance's
comment, removing them together with the saved ones.

### Restart operation

Staff with `instances.stop` can restart an operation that is running or failed
(`POST /api/platform/ops/:opId/restart`). Cloudflare Workflows can't re-run one step, so this
restarts the whole run: steps that already finished return their stored results and don't run
again, so only the failed or stuck step and those after it do work. Every operation checks the
instance's status in its first step (create and upgrade also in the steps that change something)
and stops with `aborted` if the instance has moved on, so a restart doesn't act on an instance
that was deleted or stopped meanwhile. The row goes back to `running` with the
attempt count and outcome cleared. Both audit logs record it.

## Heartbeat

worca sends a heartbeat to `app.worca.dev` every minute, signed with the instance's own
credential (D28):

| Field | Example |
|---|---|
| health | `ok`, `degraded` |
| worca version | `1.8.0` |
| pipelines by status | `{ running: 2, queued: 1, waiting: 0, failed: 3 }` |
| next scheduled run | time of the next scheduled pipeline, if any (D56) |
| suspendable | `false` while anything runs or is queued |

No titles, prompts, branch names or pipeline IDs. The control plane stores the heartbeat and
passes `suspendable` and the next scheduled run on to the gate object.

A Cron Trigger marks a `running` instance `degraded` in the consoles when its heartbeat has been
missing for 5 minutes. Suspended and stopped instances send no heartbeat and are never marked.
The control plane also records when `health` last changed (`health_since`, set by a heartbeat that
changes it or by that cron), so the consoles can say "degraded since".

### Provider status

The same 5-minute cron polls the providers, read-only, and caches the answer in KV
(`provider-status:v1`, kept an hour past the last success): one Railway query for the latest
deployment of the worca, broker and cloudflared service of every `worca-run-*` project, and one
Cloudflare list of the `worca-run-*` tunnels (`healthy`, `degraded`, `down`, `inactive`). The
number of calls doesn't grow with the number of instances, and a console view never calls a
provider itself: Railway Hobby allows 1,000 API requests an hour. A provider that fails keeps its
last answer, with the error text and the time of the last success. The platform's instance detail
shows it (`providers`); tenants never do.

### Compute facts

What an instance really runs on is read from Railway and stored on its row (`compute_facts`,
`compute_facts_at`; `src/control/instances/compute-facts.ts`), so the consoles show the truth
instead of the tier's numbers and a fixed region. `ComputeProvider.describe(ref)` returns the
region of the worca service's latest deployment and, for worca, broker and cloudflared, the CPU and
memory ceilings and the volume size and usage; one read-only Railway request per instance
([Railway](railway.md#compute-facts)).

- **When**: after a create's first heartbeat (step `compute facts`, after `notify created`), after
  an upgrade (or its rollback), and in the 5-minute cron for up to 4 instances per tick whose facts
  are missing or older than 6 hours (picked at random, `creating` and `deleting` skipped). After a
  deploy the cron fills existing instances within a few ticks.
- **Never breaks anything**: the step and the cron pass catch every error, log it and keep the
  previous facts.
- **Shown as**: `compute: { region, regionLabel, eu, services, checkedAt }` in the platform
  instance detail and the tenant instance view, null until first read ("Not checked yet"). The
  tier's `cpu`/`memoryMb`/`volumeGb` stay in the platform API as the intended size. An instance
  outside the EU (every one created before 2026-10-07 ~11:00 UTC runs in US West) gets a note: staff
  see "Created before EU placement; recreate the instance to move it to the EU", tenant admins
  that new instances run in the EU and moving means creating a new instance.

## Releases

D77; `src/control/instances/releases.ts` and `registry.ts`, run by the 5-minute cron.

- **Enrolled from npm**: each tick reads `@worca/app` from the npm registry. Stable versions newer
  than the enrollment floor (`release_enroll_floor`, the latest when the check first ran) and not
  recorded yet are checked, oldest first, at most 3 per tick, and so are release candidates
  (`x.y.z-rc.N`, D80) whose release isn't on npm yet. Anything below `MIN_HOSTED_WORCA_VERSION`
  is ignored, and so are other prerelease tags.
- **Image check**: the image tag must be on GHCR and its linux/amd64 config's
  `org.opencontainers.image.version` label must equal the version. The upgrade waits for a
  heartbeat that reports the target exactly, so an image that reports another version (1.14.0 was
  the 1.14.0-rc.4 image retagged) could never finish an upgrade. Until the image is there, or when
  GHCR can't be asked, the version is held in `release_holds` and checked again next tick; a label
  mismatch is held for good and shown to staff. npm publishes before the image is built, so a
  release is usually held for one or two ticks.
- **Enrolling** records it in `worca_releases` (`source = 'npm'`, `published_at` = now). When it is
  newer than the latest it becomes the latest and is offered to every older instance; a backport
  of an older line only becomes deployable. Audited `platform.release_enrolled`.
- **By hand**: a superadmin can still publish any version (`PUT /worca-version`), with the same
  image check; it becomes the latest even when older. Enrollment can be switched off in the
  console. The local stack never enrolls (no images).
- **Withdrawn**: a superadmin withdraws a release with a reason. It stays recorded, so it is never
  enrolled again, but nothing is created, upgraded or downgraded to it (`isPublishedVersion`), and
  automatic updates skip it. When it was the latest, the newest release left becomes the latest
  and is offered to every instance on another version, so instances on the withdrawn release are
  offered the way off it (an older version when nothing newer is left). Instances on it keep
  running (D26); each org with any gets one mail to its tenant admins, and the instance page shows
  an amber banner with the reason and "Move to x.y.z". A rollback to a withdrawn version is still
  allowed: it is what the instance ran. Withdrawing the last deployable release is refused.
  Restoring undoes it.
- **Release candidates** (D80): enrolled like releases (`platform.release_enrolled` with
  `{ source, rc: true }`) but never the latest, never offered and never installed automatically.
  A superadmin turns them on per org (`org_settings.rc_access`, the org page in the console,
  audited `org.release_candidates_set` in both logs); only then do the org's tenant admins see
  them in the version picker, and only those of releases not out yet (`releaseCandidates`): once
  `x.y.z` is enrolled or the latest is at or above it, `x.y.z-rc.N` leaves the list. The order is
  `1.9.0 < 1.10.0-rc.1 < 1.10.0-rc.2 < 1.10.0`. Withdrawing works as for releases; publishing one
  by hand is refused.

## Upgrade

1. A new worca version is released and enrolled ([above](#releases)). The control plane records
   it as available for every instance on an older version.
2. Tenant admins get an email and a banner in the tenant console (D26).
3. A tenant admin starts the upgrade when they choose. They can postpone forever, also for
   security fixes. The platform upgrades an instance on its own only for micro releases, while it
   is idle, and only where automatic updates are on ([below](#automatic-updates), D26, D75).
4. A Workflow redeploys the Railway services with the new image. The instance is `upgrading`, then
   `running` once a heartbeat reports the new version. If no heartbeat arrives in time, it rolls
   back to the previous image and tells the tenant admin.

Platform staff see each instance's version and how far it is behind.

### Choosing a version

- The banner's "Upgrade to x.y.z" and the "Change version" button next to the version (tenant
  admins, running instance, nothing else under way) open the same dialog. It lists the versions
  from `GET /instances/:id/versions`, newest first, labelled `1.9.2 · latest`, `1.9.1`,
  `1.9.0 · current`; the latest is preselected, so the banner path stays one click.
- Listed are the published releases (`worca_releases`), the latest and the instance's available
  version, never anything older than `MIN_HOSTED_WORCA_VERSION` (1.9.0), never an unpublished
  tag and never a withdrawn release (D77). The upgrade route accepts exactly this set (`isPublishedVersion`).
- With release candidates on for the org (D80), the candidates of releases not out yet are listed
  too, labelled `1.10.0-rc.1 · release candidate`; picking one shows an amber note that the
  instance stays on it and the button reads "Change to x.y.z-rc.N". Without them, the upgrade
  route refuses a candidate (403 `release_candidates_off`), and one not listed (400
  `unknown_version`).
- **Pinned**: an instance on a candidate shows "release candidate" next to its version and
  "Automatic updates: paused". Automatic updates skip it whatever its setting, also once the
  release is out; the banner offers the latest only when it is newer than the candidate. An admin
  moves it with "Change version" (to the release, a newer candidate or back). A failed move rolls
  back to the candidate; the cloudflared refresh reaches it like any instance.
- The running version is listed but can't be chosen (409 `already_on_version`), unless its
  components are out of date: then it is labelled `component update` and the button reads
  "Update components", which starts a [component refresh](#component-refresh).

### Downgrade

- Picking a version older than the running one is a downgrade: the same upgrade Workflow,
  heartbeat check and rollback, only to an older image. It exists to step back from a bad release.
- The dialog warns in amber: data written by a newer version may not be readable by an older one.
  The button reads "Change to x.y.z" instead of "Upgrade to x.y.z".
- The audit entry `instance.upgrade_started` records `{ from, to, direction }` with direction
  `upgrade` or `downgrade`; the activity views say "Started moving … back to x.y.z".
- After a downgrade the newer version is offered again by the banner, as for any older instance.
- Automatic updates don't undo a downgrade: the version left (and anything not newer) is
  recorded in `auto_update_failed_version` when the downgrade starts and skipped until a newer
  micro is published.

### Automatic updates

D26 as amended, D75; `src/control/instances/auto-update.ts`, run by the 5-minute cron.
An instance pinned to a release candidate is never picked here (D80).

- **Setting**: one mode per instance, `off`, `micro` or `minor` (micro and minor releases), stored
  as `auto_update` (`micro` or `off`) and `auto_update_minor` (migration 0025; only with `micro`).
  New instances start with `micro`; instances that existed before migration 0020 were set to
  `off`, so their admins opt in; minor is off for every instance until a tenant admin turns it on.
  Tenant admins switch them on the instance page ("Automatic updates" and "Minor releases too",
  which needs the first; `PUT /instances/:id/auto-update`, audited `instance.auto_update_set`);
  members see them read-only, platform staff in the instance detail.
- **Eligible**: mode `micro` or `minor`, status `running`, no pending operation, no abuse stop,
  and the newest release that has settled is a newer release the mode covers. Settled
  (`autoUpdateTarget`, D77): not withdrawn, not newer than the latest, and enrolled at least the
  soak time ago (`auto_update_soak_hours`, 0 to 720, none by default for now, set by superadmins on the
  Releases page; a release recorded without a time counts as settled). Upgrades started by hand
  aren't held back. The mode must cover it (`autoUpdateModesFor`): a higher micro of the running major.minor
  (1.9.1 → 1.9.2) for both modes, a higher minor of the running major (1.9.4 → 1.10.1) for
  `minor` only. Never a new major, never a prerelease. The running version is the heartbeat's.
  The start checks the mode again in the same write, so a switch turned off meanwhile wins.
- **Idle**, all of: the latest heartbeat is at most 10 minutes old and says `suspendable`
  (nothing running or queued); the gate object's `lastVisit` is more than 30 minutes ago (or
  never), and when the gate state can't be read the instance is skipped this round; no run is
  scheduled in the next 30 minutes (`next_scheduled_at`; one already past counts as due).
  Suspended instances are not woken for an update: they get it the next time they are running
  and idle.
- **Start**: at most 2 per tick, oldest-updated first, each through the same `startUpgrade` as
  the tenant admin's route (status `upgrading`, `target_version`, the upgrade Workflow), with the
  actor `system`; audited `instance.upgrade_started` with `{ from, to, automatic: true }`. Up to 8
  candidates per tick have their gate state read.
- **Success**: the tenant admins get one mail, "Worca *name* was updated to x.y.z": from → to,
  that it was a micro or minor release installed while idle, the instance address, and the instance page where automatic updates are
  turned off. `instance.upgraded` carries `automatic: true`.
- **Failure**: the usual rollback; the target is stored in `auto_update_failed_version` and
  skipped until a newer release is published, and the rollback mail (the only one) says the
  automatic update was rolled back and won't be tried again for that version. For a minor release
  it also asks the admin to check the instance: a minor release can change how Worca stores its
  data, and the older version it rolled back to may not read what the newer one changed. A tenant admin can
  still choose that version by hand.

### Component refresh

D76; `refreshOp` in `src/control/instances/ops.ts`, `autoRefresh` in `auto-update.ts`.

- **Recorded images**: every deploy writes the images it used to `instances.deployed_images`
  (migration 0026): create, upgrade and roll back with the deploy itself, a refresh or a wake only
  once Cloudflare confirms the new connector. Instances deployed earlier have NULL: their worca and
  broker run the version's tag (the two always share it), their cloudflared counts as out of date.
- **Out of date**: a service whose recorded image differs from `imagesFor(worca_version)`
  (`outdatedServices`). Only cloudflared is pinned apart from the version (`CLOUDFLARED_IMAGE`), so
  only cloudflared can be out of date at the same version, and a refresh redeploys nothing else
  (`REFRESHABLE`). Should worca or the broker ever differ at the same version, the refresh refuses:
  confirming a fresh worca boot would need more than a heartbeat with the same version.
- **Refresh** (running, nothing under way, `pending_op = 'refresh'`): deploys cloudflared alone
  with the new image. worca and the broker keep running and no run is interrupted; connections
  through the tunnel drop and reconnect within seconds. Done once every connection of the tunnel
  reports the new cloudflared version to Cloudflare (`connectorVersions`); then the images are
  recorded and `instance.components_refreshed` audited with `{ from, to }`. No mail. Not confirmed
  within 10 minutes: the op fails, the images stay out of date (Railway keeps the previous
  deployment running when the new one fails).
- **Who starts it**: a tenant admin, by choosing the current version in the version dialog (the
  upgrade route answers `{ refreshing: true }`; audited `instance.refresh_started`). And the
  5-minute cron, for every running instance that is out of date, whatever its automatic-updates
  setting and without waiting for idle: at most 3 per tick, oldest-updated first, as the actor
  `system`. An instance whose refresh failed is tried again after 6 hours.
- **Asleep**: suspended and stopped instances aren't woken for it. Their wake (or lift) deploys
  cloudflared from the new image instead of redeploying the old one, and records it once the new
  connector reports in; if it doesn't, the wake still succeeds and the cron's refresh tries again.

## Remote access in Worca

On hosted instances Worca runs in remote mode, which turns off its terminal and its actions (run
and stop actions and stacks; open an editor, terminal or file manager). The org's tenant admins
can turn either back on per instance (D72); both start off.

- **Stored** in `instances.terminal_remote` and `actions_remote` (0 or 1), and set on the Worca
  service as `WORCA_TERMINAL_REMOTE` and `WORCA_ACTIONS_REMOTE`: `1` on, `0` off (Worca counts only
  `1`/`true`/`yes`/`on` as on). The broker and cloudflared never get them. Create sets both.
- **Running** with nothing under way: the route stores the values, sets `remote_pending` and
  `pending_op = 'reconfigure'` and starts `reconfigure`: the two variables are upserted on the Worca
  service (nothing else changes; the broker's secrets stay where D68 put them), then a new Worca
  deployment from its current configuration picks them up. Active runs pause and resume
  (`WORCA_AUTO_RESUME`). The same op applies the outbound network policy (below); the variables
  are read back, and `mark applied` clears the flags only once Railway reports the new deployment
  running. While it runs, suspend, upgrades and
  automatic updates wait (`pending_op` is set). A failed or aborted run clears `pending_op` and
  keeps `remote_pending`; saving the same values again retries.
- **Suspended or stopped**: the values are only stored, with `remote_pending`. The next wake or
  lift sets the variables first and starts Worca from its configuration instead of redeploying
  the stopped deployment, so the new values surely apply. An upgrade does the same before its
  deploy.
- **Refused** (409 `instance_busy`) while creating, upgrading, deleting or with another operation
  under way; 409 `remote_access_changed` when the values changed since the request read them
  (the writes compare and set them, so the MFA decision is never made on a stale read).

## Compute size

An instance's compute size (D78, `instances/sizes.ts`) is the Worca service's vCPU and memory
ceiling on Railway plus how much Worca runs at once: Standard 2 vCPU / 4 GB (4 agents, 2 scripts),
Large 4 / 8 GB (6, 3), XL 8 / 16 GB (8, 4). The broker and cloudflared keep 2 vCPU / 4 GB on every
size. Railway bills use, so a larger ceiling costs more only while Worca uses it.

- **Create** takes the size from the request or the tier's default; the tier must allow it. The
  ceiling goes on with the other service settings (`serviceInstanceLimitsUpdate`), the parallelism
  with the variables (`WORCA_MAX_PARALLEL`, `WORCA_MAX_PARALLEL_SCRIPTS`).
- **Changing it** works like remote access (below): running with nothing under way, the route
  stores `compute_size`, `cpu`, `memory_mb`, sets `size_pending` and starts `reconfigure`, which
  sets the two variables and the Worca service's limits with the other settings and restarts
  Worca; `mark applied` clears `size_pending` once the new deployment runs, and the compute facts
  are read again. Suspended or stopped: only stored, applied on the next wake or lift (or an
  upgrade). 409 `size_changed` when it changed since the request read it.
- **Tier changes** never resize: an instance on a size its tier no longer includes keeps it until a
  tenant admin moves it, and may always move to an allowed one.

## Outbound network policy

What Worca's agents may reach (D73). The org has a policy (`org_egress_policies`; open until an
admin changes it); an instance follows it or has its own (`instances.egress_mode`/`egress_hosts`),
which replaces it as a whole. Effective policy = the override, else the org's.

- **Sent** to the worca service only, as `WORCA_EGRESS_MODE` (`open`, `block`, `allow`),
  `WORCA_EGRESS_ALLOW` and `WORCA_EGRESS_DENY` (comma-separated, `*.example.com` written as
  worca's `.example.com`). All three are always set and never empty, so they are written together
  in one upsert and no list is ever deleted: ALLOW starts with the platform's own hosts in every
  mode (always allowed; worca reads ALLOW only in `allow` mode), DENY is `.invalid` when the
  blocklist is empty (reserved, never resolves). The broker and cloudflared never get them. Create
  sets the org's policy. Instances created before D73 have `WORCA_EGRESS_ALLOWLIST` (a fixed list
  worca never read); the first apply deletes it.
- **Applied** by the same `reconfigure` op as remote access: it sets remote access and the
  policy together, reads the worca service's variables back (it fails unless all five hold exactly
  what was written and the old allowlist is gone), restarts Worca, and waits until Railway reports
  the new deployment `SUCCESS`. Only then are the pending flags cleared (compare-and-set on
  `egress_version` and the remote-access values): a failed deployment leaves Railway running the
  previous one with the previous variables, so a failed or unconfirmed run fails the op, releases
  `pending_op` and keeps `egress_pending` (the instance page says "Not applied yet"; saving again
  retries). Wake, lift and upgrade apply pending settings before starting or deploying and clear
  the flags once worca reported in from the new start or version (not after a roll back).
- **Org change**: in one transaction, every instance that follows the org is marked pending
  (`egress_version` moves on) and the running ones with nothing under way are claimed for a
  `reconfigure`. Asleep, stopped or busy ones get it on their next start, upgrade, or an admin's
  "save again". A change landing while a `reconfigure` runs is applied in another round of it (up
  to three). A stop for abuse still wins over every start.
- **Instance override**: as remote access: applied at once when running and idle, stored for the
  next start when asleep or stopped, refused (409 `instance_busy`) while something else runs. An
  override that leaves the effective policy unchanged is stored without a restart.
- **Not enforced yet**: Worca doesn't read these variables yet; see [Security](security.md#outbound-network).

## Git credentials

What Worca on an instance clones, pushes and opens pull requests with (D79). Per instance, set by
the org's tenant admins on the instance page; nothing is set until they do, and an instance whose
`git_version` is 0 keeps whatever git variables it has (none, on a platform-created instance).

- **Stored** in `instances.git_settings`: the whole configuration as JSON, credentials included,
  encrypted with the org key (`instances/git.ts` `GitSettings`, `git-api.ts`). Never returned to a
  browser: the console gets what each credential is (App ID and name, token owner, last four
  characters, when it was set). `git_version` moves on with every change; `git_pending` as for the
  other settings.
- **What a tenant admin sets**: GitHub (the org's own App: App ID, private key, optional
  installation ID; or one token), Azure DevOps (one PAT), Bitbucket (an access token, or an
  Atlassian API token with its email), the commit identity, the clone allowlist, and who pushes go
  out as (`instance`, `prefer`: the person who acted when they connected GitHub, the default;
  `required`: only that person). With an App, members can also sign in with GitHub on the key page
  through it, which needs the App's client secret. A secret left out of a save keeps the stored
  one of the same kind.
- **Checked** before it is saved: an App with a JWT signed by its key (`GET /app`, the answer must
  name the same App ID; then its installation, or that it is installed somewhere), a token with
  `GET /user`. GitHub's answer fills in the App's slug, name and client ID, or the token's
  account. Azure DevOps and Bitbucket credentials are not checked.
- **Sent** as Worca's own variables (`gitVariables`): `WORCA_GH_APP_ID`, `WORCA_GH_APP_KEY_B64`,
  `WORCA_GH_APP_INSTALLATION_ID` or `GH_TOKEN`; `WORCA_ADO_TOKEN`; `WORCA_BB_TOKEN` (and
  `WORCA_BB_EMAIL`); `GIT_AUTHOR_*` and `GIT_COMMITTER_*`; `WORCA_CLONE_ALLOW`;
  `WORCA_GH_AS_PERSON`. On the broker `WORCA_BROKER_GITHUB_CLIENT_ID` and `_SECRET` when members
  sign in through the App. Every other managed git variable (`WORCA_GIT_VARIABLES`,
  `BROKER_GIT_VARIABLES`: token pairs, a hand-set `GH_TOKEN`, …) is deleted, so nothing can win
  over the configured credential. Worca keeps all of them from agents.
- **Applied** by the same steps as the other settings: `setGitSettings` upserts what changed,
  deletes what is no longer wanted and reads both services back (names in errors, never values),
  then Worca restarts. The broker restarts only when its git variables differ from what it last
  started with (`git_broker_applied`, a SHA-256 over them): a separate `restart key page` step in
  `reconfigure`, or the broker started from its configuration on a wake or lift. An upgrade deploys
  every service from its configuration anyway. Running and idle: `applying`; suspended or
  stopped: `saved` for the next start; otherwise 409 `instance_busy`.
- **Members** connect their own GitHub on the key page: by pasting a token (Worca with B7), or by
  signing in through the App. Worca then clones, fetches, pushes and opens pull requests as them
  (reads from Worca with B9); someone who hasn't connected gets the instance's credential.
- **The default** for an instance whose git settings nobody saved (`git_version` 0) is "the person
  who acted": `WORCA_GH_AS_PERSON=prefer` goes to the worca service with its other settings
  (`worcaSettingsFor`), from create on. Migration 0030 marks existing instances `git_pending`, so
  their next wake, lift, upgrade or reconfigure sets it; the consoles don't show that as "not
  applied yet". Once an admin saves git settings, `setGitSettings` manages the variable instead.

## Suspend and wake

- **Idle:** the gate object records a visit every time the gate asks it about a session, which
  for an active user is about once a minute (D44). An open worca tab counts too: worca closes its
  WebSocket when the token expires (W7), and the reconnect is a visit.
- **Alarm:** the gate object keeps an alarm set to 24 hours after the last visit. When it fires
  and the latest heartbeat says `suspendable`, it asks the control plane to suspend the instance.
  If not, it tries again an hour later (D27).
- **Schedules:** before suspending, the gate object sets a second alarm 10 minutes before the
  next scheduled run, which wakes the instance the same way a visit does (D56).
- **Suspending:** a Workflow stops the latest deployment of each service (worca, broker,
  cloudflared) with Railway's `deploymentStop` (D48), waits until Railway reports them stopped
  (a stopped deployment keeps the status `SUCCESS`; see [Railway](railway.md#stopping-and-waking)),
  and sets the status to `suspended`.
  Railway can't scale a service to 0 replicas. Its app sleeping and serverless mode can't be used
  either: they only sleep a service after minutes with no *outbound* traffic, and cloudflared's
  tunnel connection and the heartbeat are always outbound.
- **Waking:** a visit to a suspended instance reaches the gate object, since nobody holds a valid
  pass after 24 idle hours. The gate shows a "starting…" page. The gate object starts one wake,
  however many people are waiting: a Workflow redeploys each service with `deploymentRedeploy`
  (an out-of-date cloudflared is deployed from its new image instead, D76).
  The page asks the gate every few seconds and reloads once the first heartbeat has set the status
  back to `running`. While it waits, the gate's status answer carries the wake's phase, asked of
  the control plane (`ControlRpc.wakePhase`): `starting` while the services are redeployed
  ("Starting services…"), `waiting` until worca's first heartbeat ("Waiting for worca…"). With
  no wake under way the phase is empty and the page shows no extra line.

Whether the volume survives a stop and what a stopped service costs are still to be confirmed
with Railway (Q14).

**Running but not answering.** When the gate object says `running` but worca doesn't send its
response headers in time (crashed, restarting, stuck), the gate stops waiting instead of letting
the browser hang: after 10 s for a page load or WebSocket handshake, 90 s for anything else
(API calls may long-poll; Cloudflare's own limit is 100 s), or at once when Cloudflare answers 530
(no tunnel connector). A page load gets the gate's "*host* isn't answering right now" page (504,
or 502 when unreachable), which tries again by itself every 20 s; other requests get
`{"error":"instance_unresponsive"}`. Only the wait for the headers is bounded, never a streamed
body or an open WebSocket. The limits are the gate vars `UPSTREAM_PAGE_TIMEOUT_SECONDS` and
`UPSTREAM_TIMEOUT_SECONDS`. Suspended instances never reach this: the gate shows the starting
page and wakes them without forwarding.

## Stop for abuse

A platform superadmin or admin stops the instance (D16, D47). Tenant admins can still delete it
(D60). The gate object's status becomes
`stopped` and the services are stopped the same way as for suspending. It is logged in the
platform and org audit logs, the tenant admins get an email with the reason, and the gate shows a
"stopped by the platform" page. A visit never wakes it; only platform staff can lift it.

A stop preempts any operation. A step that starts or deploys Worca (wake, lift, upgrade and its
roll back, reconfigure) reads the row again once the provider answered; if a stop landed
meanwhile it stops the services again, so the stop wins, and the operation ends
`stopped_meanwhile` (counted as superseded) without touching the stop's status, reason or
`pending_op`.

## Rotate

Platform staff with `instances.rotate` renew an instance's credentials (D74): its Cloudflare
tunnel token, the broker secret worca and the broker share, and its heartbeat credential. The
broker's vault key stays: it only decrypts the broker's volume, and a new one would make the keys
people stored on the key page unreadable. Use it when a provider holding the instance's variables
may have leaked them (Railway, 2026-10-21) or a secret may have been seen.

- **One instance:** `POST /api/platform/instances/:id/rotate`, "Renew credentials" on the
  platform instance page. Running, suspended or stopped, with nothing else under way: 409
  `instance_busy` otherwise. It claims the instance with `pending_op = 'rotate'`, so a wake,
  upgrade or settings change waits until it is done.
- **Every instance:** `POST /api/platform/instances/rotate` with `{ confirm: 'all instances' }`,
  "Renew all credentials" on the Operations page. Each instance that is free now starts its own
  rotate operation, one every 15 seconds, closer together when there are more than 40 so all start
  within 10 minutes. The rest (being created, upgraded or deleted, or busy) come back as
  `skipped`, to be renewed one by one later.

The operation:

1. `renew secrets`: a new tunnel secret at Cloudflare (`PATCH cfd_tunnel/:id { tunnel_secret }`),
   then every open connection of the tunnel dropped (`DELETE cfd_tunnel/:id/connections`): a new
   secret alone leaves open connections up, including any opened with a leaked token. The old token
   can't connect again, so a running instance is unreachable until its new cloudflared is up. Then
   the new token, a new broker secret and a new heartbeat credential written to the three
   Railway services and read back (`setSecrets`), then the credential's hash in D1. As in create,
   every secret is made and used inside this one step and none is returned, so none reaches the
   Workflow's stored results or logs; a retry makes a fresh set.
2. Suspended or stopped: done. The old heartbeat credential is dropped at once, and the next wake
   or lift starts the services with the new values.
3. Running: `restart services` deploys all three from their current configuration (same images).
   The credential worca beats with until then stays accepted (`heartbeat_cred_hash_prev`) for at
   most 30 minutes; worca's first beat with the new one retires it. The op waits for that beat, then for the tunnel to be
   connected again (only the new token can connect, so this proves cloudflared has it), and the org's tenant admins get an
   email that the instance restarted to renew its credentials.

`finish` records `secrets_rotated_at` (shown as "Credentials renewed" on the platform instance
page) and audits `instance.secrets_rotated` in the org log; the start is audited as
`instance.rotate_started` in both logs, a rotation of every instance also as
`instances.rotate_all_started`. A rotation that fails (no new beat or no tunnel within 10
minutes, a provider error) releases the claim. The old heartbeat credential stays accepted until
its 30 minutes are up and never after, so a possibly leaked credential can't outlive a failed
rotation; Railway already holds the new one, so any restart, or renewing again, brings the
instance's heartbeats back. Restarting the failed operation
doesn't: its claim is gone, so it stops at once.

## Delete

Immediate and permanent (D29), after the two confirmations of D30: a tenant admin with a passkey
session (D24) types the instance's name (`POST /api/orgs/:orgId/instances/:id/delete`), then
confirms through the emailed link. Then:

1. Set the gate object's status to `deleting`, so the gate refuses every request that reaches it.
   Remove the two KV entries.
2. Delete the Railway project, including its volume. Until this finishes, reads holding a pass
   from the last 60 seconds can still reach the instance.
3. Delete the DNS records and the tunnel; revoke the heartbeat credential (and one a rotation kept, D74).
4. Delete the gate object's storage and the instance's rows; record the deletion in the audit
   logs.

### Delete during create

A delete can be confirmed while the create Workflow is in the middle of a provider call, before
it has saved the id of what it is creating; the delete would then miss that Railway project,
tunnel, DNS record or gate entry. Two rules close this:

- The delete reads the instance's compute and edge refs again inside its own provider steps
  (`destroy compute`, `delete edge`), not from its first step.
- Every create step that makes something (`create project`, `create tunnel`, `add dns`,
  `gate hosts`) saves its ref first and is followed by a step `<name>: overtaken?` that reads the
  instance. Still `creating`: the delete, if one comes, starts after the ref was saved and finds
  it. Gone or `deleting`: the step `undo create` removes everything this run made (project, DNS
  records, tunnel, gate hosts and gate object; all idempotent, so it doesn't matter that the
  delete may remove some of them too), and the create ends with the outcome `aborted`.

Deleting an org runs these steps for every instance, then destroys the org's data key and deletes
the org's rows. The platform audit log keeps the metadata record of the deletion. Every other
tenant admin is notified.
