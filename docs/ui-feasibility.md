# UI feasibility

Every feature of the two click-through prototypes ([UI concept](ui.md)), checked against our
control plane, Better Auth 1.7.7, worca (`~/dev/worca-cc`) and the provider APIs (Cloudflare,
Railway, Resend, GHCR). Checked on 2026-10-06; provider calls were read-only, and Railway's
schema was introspected live.

**Verdicts**

| Verdict | Meaning |
|---|---|
| **Ready** | An endpoint already serves it. |
| **Add** | Small backend addition over data we already hold: a field, an aggregate, a route. |
| **Build** | Needs data we don't store yet, a worca change, or a new provider integration. |
| **Change** | Not possible as drawn; the prototype must change. |

## Decided on 2026-10-06

The product owner's answers to this review (recorded as D61–D65 in [Decisions](decisions.md)):

- **Images:** worca's public image `ghcr.io/sinishadjukic/worca` (the provider pointed at a
  non-existent org; fixed).
- **Railway:** move to Pro within weeks. **DNS:** Pro raises the zone to 3,500 records.
- **Dropped from the UI:** "waiting for your answer", history widgets (two-week chart, hourly
  heartbeats, durations), "pipelines today", session location.
- **Changed:** "Retry step" becomes "Restart operation".
- **Kept and built:** passkey "last used", sessions, SSO read and delete, user support tools,
  mail counting, and all the other Add and Build items.
- **Member directory:** visible to every member; admin-only details and invitations (D62).
- **Org names:** shown in the console (D61).
- **worca gaps:** in the worca backlog (kept with worca-cc), including auto-resume on start and a
  per-person Away mode.

## Status after implementation (2026-10-06)

The control plane now serves every Add and Build item below except those listed as open. Routes and
fields are in [Internal APIs](internal-apis.md#http-routes-added-or-changed-for-the-consoles).
The rest of this page is the review as written, before the work.

**Done**

| ID | Served by |
|---|---|
| T1 | Instance view: `teams` with names for tenant users, `op`, `healthSince` |
| T3 | `GET /api/me`: `orgs[].instances` |
| T4, T5 | `GET /api/orgs/:orgId/summary`: counts, upgrades available, degraded since, invitations expiring in 48 hours, sign-in settings |
| T8 | `instance_ops` and `op` with phases (`OP_PHASES`); `policy` on create |
| T9 | Role-shaped `GET /members` (joined, signs in with, invited by), `inviter` on invitations, `POST /invitations/:id/resend` |
| T10, T15 | `POST` and `DELETE /teams/:teamId/instances/:instanceId`; `GET /teams/mine`; `GET /teams` for every member |
| T11 | `GET /sso`, `DELETE /sso/:id`; the people a change would lock out come back as `affected` |
| T12 | `category`, `actorId`, `action`, `before`, `limit` filters on the org audit log |
| T13 | `GET /keys`; org key rotation now re-encrypts the org's rows and then destroys the old versions |
| T14 | `GET /api/me/sessions` (list, revoke one, revoke others), `GET /api/me/passkeys` with `lastUsedAt` |
| P1, P3 | `GET /api/platform/stats`; provider status polled by the 5-minute cron and shown in the instance detail |
| P2, P6 | `GET /api/platform/ops`, `POST /api/platform/ops/:opId/restart` ("Restart operation"); instance detail with refs, size, region, provider status |
| P5, P11 | Org names, first admin and admin addresses; names and addresses in the staff list |
| P7 | Registration code `note` and `usesTotal`; waitlist approve fixed |
| P8 | Lookup by exact email, sign out, disable (ends sessions), enable, two-person sign-in reset |
| P9 | Same filters on the platform audit log |
| P10 | `worca_releases`, `GET /releases`, GHCR image check on publish |
| P12, P13 | Key counts by master key, master key rotation, mail counts, provider usage |
| G1 | Wake phase (`starting`, `waiting`) on the gate's starting page |

T2, T7, T16 and P14 were Ready.

**Still open**

- CSV export of the audit log: built in the browser from the filtered entries; no server route.
- Nothing is built for the dropped history widgets (D63): two-week chart (P4), hourly heartbeats,
  "pipelines today", the done and failed totals of T6, session location. The daily snapshot and
  hourly counter tables are not created.
- T1 "waiting for an answer": needs worca to report it (W3); the console can only show what the
  heartbeat carries.
- Invitation delivery status is recorded (`mail_messages`, from the Resend webhook) and
  `deliveryStatusFor` exists, but no route returns it yet.
- Railway webhooks are not used; status comes from the polled cache only.
- Workflow step detail from Cloudflare's REST API isn't used: our own `instance_ops` rows carry
  phase, step, attempts and last error.
- worca-side items stay in the the worca backlog (kept with worca-cc): graceful drain (so the upgrade
  banner wording still applies), auto-resume on start, per-person Away mode.

## Tenant: org workspace

| ID | Feature | Verdict | What it takes |
|---|---|---|---|
| T1 | Home cards: status, host, pipeline counts, teams, open or wake | Add + Build | Instances list has it all (`instances/routes.ts`), except team **names** for tenant users (`/teams` is admin-only). "Waiting" needs worca to report it (W3). **"Waiting for *your* answer" → Change:** worca's questions have no addressee and the heartbeat carries no per-user data (D28). Show "waiting for an answer". |
| T2 | Wake and open, waking page | Ready | The gate wakes on visit and serves a polling page. Restyle only. |
| T3 | Other orgs with role and instance count | Add | `/api/me` has orgs and roles; add the visible instance count. |
| T4 | Overview tiles | Add + Build | Summary endpoint over existing data. **"Pipelines today" → Build**: we keep only the latest heartbeat. worca can count today's runs (`stats.mjs`) and report them (new W8). Its day is UTC midnight. |
| T5 | Needs you: upgrade, degraded, invitation expiring, activity | Add | **"Degraded for 20 min"** needs a `health_since` column set on transitions; nothing records when health changed. |
| T6 | Instances table | Add + Build | Fields exist. **done/failed totals → Build**: the heartbeat reports current counts per status only. Use W8's today counts, or show current state only. |
| T7 | Instance detail | Ready | All fields are in the instance view. The **upgrade banner text → Change** (see "Upgrades" below). |
| T8 | Create instance with live progress | Build | Policy isn't part of create (a second call works). **Step progress**: the Workflow id isn't stored, and the binding's `status()` has no step detail. Write a progress row from each `steps.do`. The prototype's 5 steps aren't the real ones: the real create has 7 steps plus the wait for the first heartbeat (`instances/ops.ts`). Map them to 4–5 user-facing phases. |
| T9 | Members and invitations | Add | Joined date exists (`member.createdAt`). Inviter **name**: join on `inviterId`. **"Signs in with"**: derive it from accounts, passkeys or the last session method. **Resend invitation**: Better Auth supports `resend: true`; pass it through and exempt it from the member-limit check. |
| T10 | Teams | Ready / Add | Exists. A per-team instance toggle must read-modify-write `PUT /instances/:id/teams`; add a per-team grant route to avoid the race. |
| T11 | Sign-in and security | Add | Policy, domains with their TXT records, and SSO registration exist. Missing: an **SSO read/delete route** (admins can connect SSO but never see or remove it) and the **list of locked-out people** (only a count today; and see the bug below). |
| T12 | Audit log with filters and CSV | Add | Filter on `action` and `actor_id` (plaintext). Build the CSV in the browser. 30 days only (D57). |
| T13 | Org settings, key rotation | Add + Build | "Last rotated at" comes from `data_keys`. "By whom" survives only 30 days in audit; store it. **The org-key re-encryption Workflow is still a TODO.** |
| T14 | Account: passkeys, linked accounts, sessions, export, delete | Add + Build | Passkey and account routes are open. Passkey **"last used"** has no column; add one in the passkey hook. **Sessions**: Better Auth's session routes are closed on purpose, so we need `/api/me/sessions` with signed handles (D49). **City → Change or decide**: never stored; `request.cf.city` is available, but it's new personal data (GDPR). "Last active" refreshes only daily. |
| T15 | Tenant user: your teams, org admins | Add | A member-scoped teams endpoint. |
| T16 | Org switcher | Ready | `/api/me`, `organization/set-active`. |

## Platform console

| ID | Feature | Verdict | What it takes |
|---|---|---|---|
| P1 | Overview tiles | Add | Stats endpoint: counts, orgs this week, users, silent, degraded and stuck. **Provider status → Build**: Cloudflare tunnel status (`healthy/degraded/down`) and Railway `latestDeployment.status`, polled and cached. |
| P2 | Needs a look: stuck step, silent, degraded since | Build | Our own progress rows (T8). Retry counts come from the Workflows REST API (`attempts[]` per step). That needs a token with Workers Scripts Read, and instances are kept 30 days on Workers Paid. Railway `deploymentEvents` and logs show where a deploy hangs (HEALTHCHECK not completed). |
| P3 | Version adoption | Add | GROUP BY `worca_version`. |
| P4 | Two-week chart | Build | No status history exists. A daily snapshot table written by the daily cron. It starts empty on the day it ships. |
| P5 | Orgs with names, first admin | Add after decision | Names are encrypted with the org key; the platform Worker can decrypt them (it holds the master key). **Policy decision**: ui.md currently says ids only. |
| P6 | Instance detail | Add + Build | Provider refs, size and region are in the table, but not returned to the console; add them. **Hourly heartbeats → Build**: an hourly counter per instance, not a row per beat. **"Retry step" → Change**: Workflows can't re-run a single step. Offer "Restart operation" (`restart()`; finished steps are cached). Stop-for-abuse and lift are ready, with the email to admins. |
| P7 | Registration | Ready / Add | Mode, codes, approve and reject exist. Add a **note** and **total uses** (only `uses_left` is stored). Fix approve (bug below). |
| P8 | Find a user and support actions | Build | Lookup: add a route over the existing blind-index resolver. **"Registered via code X"**: not stored, only from now on. **Last sign-in**: from sessions or audit. **Sign out everywhere, disable** (disabling must also revoke live sessions and gate sessions), **two-person reset** (needs an approvals table): all new. |
| P9 | Platform audit | Ready / Add | Exists with actor role; add filters. |
| P10 | Releases | Add | Store release dates (today a bare JSON array) and instance counts. **Image check**: GHCR's anonymous manifest check works against the public `ghcr.io/sinishadjukic/worca`. |
| P11 | Staff and roles | Add | The list returns user ids only; decrypt name and email. |
| P12 | System | Build | Wrapped-key counts: Add. **Master-key rotation is not implemented** (version is the constant `m1`); that is L. Provider counts come from Railway `workspace{projectCount subscriptionPlanLimit}` and Cloudflare `result_info.total_count`. **Latency**: no provider API; time our own calls. **Mail sent today**: our sending-only Resend key can read nothing. Count our own sends, or capture Resend's quota headers on send (documented, unverified). |
| P13 | Mail quota in the sidebar | Build | As P12. |
| P14 | Console needs a passkey session | Ready | `requireCap` checks `session.mfa`. |

## Gate

| ID | Feature | Verdict | What it takes |
|---|---|---|---|
| G1 | Waking, stopped, no access, sign in again | Ready / Add | The pages exist. A progress bar needs a wake sub-state ("starting services", then "waiting for worca"). "No access" is served by the control plane, not the instance host. |

## Corrections to the prototype

| Prototype says | Reality | Change to |
|---|---|---|
| "N pipelines waiting for your answer" | Questions have no addressee; the heartbeat has no per-user data | "waiting for an answer" |
| Upgrade: "running pipelines finish first; goes back by itself if it fails" | worca can't drain. A container stop kills runs instead of pausing them: the server's SIGTERM handler likely never runs under `tini → worca ui → server`. Runs come back `interrupted` and need a manual Resume. No rollback exists | Until W9: "Running pipelines are interrupted and can be resumed afterwards." Rollback is our job: watch for a heartbeat with the new version, else redeploy the old image |
| "Retry step" | Workflows restart whole operations (finished steps cached) | "Restart operation" |
| "18 of 100 projects" | Railway Hobby allows **50** projects; worca-01 already uses one | Read `subscriptionPlanLimit.projects` live |
| Provisioning in 5 steps | 7 Workflow steps plus the first heartbeat | 4–5 phases mapped onto the real steps |
| Session "Zagreb" | Not stored; IP-derived city is personal data | Leave it out, or store city and country only at sign-in, with disclosure |
| Passkey "used today" | No column | Add `lastUsedAt` in our passkey hook |
| "Registered via code WRC-…" | Only "registered with a code" and its tier | Store `registration_code_id` from now on |
| Heartbeats per hour, two-week chart, "degraded for 20 min" | Nothing is stored as history | Build the history tables below, or drop those widgets in v1 |
| Plan sizes "2 vCPU · 4 GB · 10 GB" | Railway Hobby caps volumes at 5 GB, and `volumeCreate` can't set a size (it gets the plan default) | Show the tier's real values; move to Pro before selling bigger tiers |

## Blockers found on the way

1. **Images pointed at the wrong place** (fixed 2026-10-06). The provider used
   `ghcr.io/worca-dev/worca` and `worca-broker`, which don't exist. worca publishes one public image,
   `ghcr.io/sinishadjukic/worca`, and the broker is the same image started with
   `worca-entrypoint worca broker`. Both are now set that way.
2. **Railway API budget.** Hobby allows 1,000 requests per hour. Polling three services per
   instance runs out at about 30 instances. Status and metrics must come from one workspace-wide
   query, cached, plus webhooks. Webhooks are **unsigned**, so add a secret header and treat each
   webhook as a hint to re-check through the API.
3. **DNS records.** The worca.run zone (created 2026-10-06) is on the Free plan, which allows 200
   records per zone: about 98 instances at two records each. Pro and Business allow 3,500 records
   (about 1,750 instances); past that, Cloudflare's 1,000 tunnels per account is the limit.
4. **Railway Hobby** caps at 50 projects and 5 GB volumes. Real tenants need Pro.

## Server bugs found by the audit

All three are fixed (2026-10-06).

- **Fixed, by decision:** `GET /api/orgs/:orgId/members` is open to every member, which is now the
  intended behaviour (D62). Every member sees name, email, role and teams; joined date, sign-in
  methods and inviter go to tenant admins only.
- **Fixed:** platform waitlist approval goes through `approveWaitlistedUser`, so `registeredVia`
  becomes `approved` and the account may create an org.
- **Fixed:** the lock-out check (D31) now covers allowed methods (passkey, SSO and the others),
  the required domain, instance policies, the removal of an SSO provider and the method of live
  sessions, and returns the affected members.

## What to build, by layer

**Control plane: history and progress** (unblocks T4, T5, T8, P2, P4, P6)
- `instances.health_since` (set when health changes).
- `instance_ops` progress: op id, workflow instance id, current phase, started and updated times,
  written from every `steps.do`.
- `instance_daily` snapshot from the daily cron; `heartbeat_hourly` counter (beats per hour, 48 h).

**Control plane: routes**
- Tenant: summary, per-team grants, SSO read and delete, invitation resend, member-scoped teams,
  `/api/me/sessions` with handles, passkey `lastUsedAt`.
- Platform: stats, org detail, user lookup, sign out everywhere, disable (also revokes sessions),
  releases table, staff names.
- Two-person reset with an approvals table, and master-key rotation (both L).

**Providers**
- Tunnel status: Cloudflare `cfd_tunnel/{id}`.
- Deployment status and events: Railway, one workspace-wide query, cached.
- Workflow step detail: Cloudflare REST, with a read token as a secret.
- Plan limits: Railway `subscriptionPlanLimit`.
- Optional: Railway `metrics` for abuse signals (CPU at the limit for hours, egress), and Resend
  webhooks (Svix-signed) for invitation delivery status.

**worca**: moved to the worca backlog (kept with worca-cc): B1 refined heartbeat, B2 graceful drain,
B3 auto-resume on start, B4 per-person Away mode, B5 today's counts (deferred), B6 team-use notes.
