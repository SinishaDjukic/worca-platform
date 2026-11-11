# UI concept

The control plane at `app.worca.dev` gets a web UI in two parts: an **org workspace** for tenants
and a **platform console** for platform staff. This page lists the views, who sees each one, what
it shows and does, and which API it uses. It started as a concept and is now built; the code is in `ui/`.

## Principles

- **One app, two areas.** Everyone signs in at the same place. A switcher at the top lists the
  person's orgs (D21) and, for platform staff only, "Platform console". The two areas never
  mix: an org view never shows platform controls, and the console never shows tenant content.
- **The console sees metadata, never tenant content (D15).** It shows org and instance names (D61), tiers, counts,
  instance status, version, health and pipeline counts. It never shows instance contents and has
  no "open instance" or "sign in as" button. A staff member who is also a tenant member reaches
  that org through the switcher like anyone else.
- **Views follow capabilities, not role names.** The UI reads `/api/me` (platform roles, org
  roles, session `mfa`) and hides what the API would refuse. The API still checks everything;
  hiding is only for clarity.
- **Destructive actions look the same everywhere (D30, D31).** A dialog asks you to type the name.
  If the session isn't a passkey session, it asks for one first (D24). The final screen then says
  "check your email": nothing happens until the emailed link is confirmed.
- **Status is live.** Instance status (`creating`, `running`, `suspended`, `stopped`, `upgrading`,
  `deleting`) is polled while a view is open, and transitions are shown as they happen.
- **Each result is reported once, where the eyes are** (as worca, #555): see [Feedback](#feedback).
- **No tenant data in URLs** beyond ids. Names are display-only.

## Who sees what

| Area | tenant user | tenant admin | support | admin | superadmin |
|---|---|---|---|---|---|
| Personal (home, account) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Org workspace: instances they can use | ✓ | ✓ | | | |
| Org workspace: management | | ✓ | | | |
| Platform console: read-only | | | ✓ | ✓ | ✓ |
| Platform console: tenants, registration, abuse | | | | ✓ | ✓ |
| Platform console: roles, system settings, keys | | | | | ✓ |

Platform roles also need a passkey session (D24): without one, the console shows only a
"sign in with your passkey" step.

## Personal views (everyone)

| View | Shows | Actions | API |
|---|---|---|---|
| **Home** | Every instance the person can use, across all their orgs: name, org, status, a short status line ("asleep, opens in a few seconds"). The main page for tenant users. | Open (goes to the instance host; the gate does the rest) | `/api/me`, `GET /api/orgs/:id/instances` per org |
| **No org yet** | Shown after sign-up with no membership. | Create an org; see pending invitations | `POST /api/orgs` |
| **Waiting for approval** | Waitlist mode: the account is pending. | Sign out | `/api/me` (`status: pending`) |
| **Invitation** | Org name, inviter, role. (Exists, server-rendered.) | Accept | `/invite/:id` |
| **Account: profile** | Name, email. | Edit name | `PATCH /api/me` |
| **Account: sign-in methods** | Passkeys (name, created, last used), linked Google or Microsoft accounts. | Add or remove a passkey (needs a passkey session), link or unlink a provider | Better Auth passkey and account endpoints |
| **Account: sessions** | Signed-in devices: method, created, last seen, current one marked. | Sign out one or all others | Better Auth session list with signed handles (D49) |
| **Account: your data** | What we hold about you. | Download export, delete account (D30 flow) | `GET /api/me/export`, `DELETE /api/me` |
| **Confirm** | The D30 page from the emailed link. (Exists, server-rendered.) | Confirm | `/confirm/*` |

## Org workspace

### Tenant user

Tenant users see **Home** (above) filtered to the org, plus a read-only **Org** page with the org
name, the member directory (name, email, role, teams; D62) and the teams with their own marked.
They don't see invitations, how people sign in, or any settings.

### Tenant admin

| View | Shows | Actions | API |
|---|---|---|---|
| **Overview** | Instances by status, members and pending invitations, tier and how much of it is used (instances, size), upgrades available, the last few audit entries. Instances with their teams. While the org has no team or no instance, a "Get started" checklist comes first: 1) create the first team (name suggested, the admin is added), 2) create the first instance in it (D71). | Shortcuts to the actions below; "Create a team first" instead of "New instance" while there is no team | aggregate of existing endpoints; a summary endpoint later |
| **Instances** | Table: name, host, status, version, health, teams (links to them), last heartbeat. Filter by status and team. | Create instance, or "Create a team first" while there is no team | `GET /api/orgs/:id/instances` |
| **Create instance** | The team it belongs to (required; pre-selected when coming from a team or when there is only one), name, the compute size when the tier offers more than one (the tier's default picked, D78), optional stricter login policy. Tier limits shown before submit. With no team yet, only the "create a team first" step, which creates the team (the admin in it) and comes back with it selected (D71). Then a live progress view (creating → running) with the steps of the Workflow. | Create | `POST /api/orgs/:id/instances` |
| **Instance detail** | Status (with the current operation's phase while one runs), URL, version and "upgrade available" (or, when the platform withdrew the version it runs, an amber banner with the reason and "Move to x.y.z", D77), health, pipeline counts by status, whether it can be suspended, next scheduled run, automatic updates, compute size (with "not applied yet"), remote access in Worca (terminal, actions) and the outbound network policy (effective policy, "Same as the org" or own, not applied yet; read-only for members), git credentials (what each one is, never a secret; members see only whether pushes go out as them and a link to the key page), teams, login policy. | Open, rename, change teams, upgrade or change the version (any published one, also older; tenant-initiated, D26; with release candidates on for the org, also pin it to a candidate, which then shows "release candidate" and pauses automatic updates, D80), turn automatic micro updates on or off, change the compute size (the sizes the plan includes; restarts Worca, D78), turn Worca's terminal and actions on or off (switches, a warning, a confirmation step in the dialog, a passkey to turn one on; restarts Worca, D72), set an own outbound network policy or go back to the org's (the shared editor in a dialog with a confirmation step; a passkey to loosen; restarts Worca, D73), set the git credentials (GitHub App or token, Azure DevOps, Bitbucket, commit identity, clone allowlist, who pushes go out as; a secret left empty keeps the stored one; a passkey to add one; restarts Worca, D79), change login policy (D31), delete (D30) | `GET/PATCH /api/orgs/:id/instances/:iid`, `PUT …/teams`, `GET …/versions`, `POST …/upgrade`, `PUT …/auto-update`, `POST …/size`, `POST …/remote-access`, `GET/PUT …/egress`, `GET/PUT …/git`, `POST …/delete`, `GET/PUT …/policy` |
| **Members** | Name, email, role, teams, joined. Pending invitations with expiry. | Invite (email, role, team), resend or revoke an invitation, change role, remove member (the last tenant admin is protected, D18) | `/members`, `/invitations` |
| **Teams** | Teams with member and instance counts. Team detail: members, granted instances. | Create, rename, delete; add or remove members; grant instances; new instance in this team. An instance's last team can't be switched off, and a team that is some instance's only team can't be deleted; the page says which instances to move first (D71) | `/teams`, `/teams/:id/members`, `PUT …/instances/:iid/teams` |
| **Sign-in and security** | Org login policy (allowed methods, required domain), verified domains with their TXT records, SSO connections. "Outbound network": the org's policy (Open / Open except blocked hosts / Only allowed hosts, the lists, the always-allowed hosts read-only), how many instances follow it and which have their own, and the note that Worca applies it from version 1.11.0 (older versions ignore it) and that it covers tools that go through Worca's proxy, not a program bypassing it on purpose (`EGRESS_NOTE` in egress.mjs). | Edit policy (D31 when it would lock members out), add and verify a domain, connect SSO, save the outbound network policy (asks first when running instances will restart Worca; a passkey to loosen; field errors under the list; D73) | `/policy`, `/domains`, `/domains/:id/verify`, `/sso`, `/egress` |
| **Audit log** | Who did what and when, filterable by person and action. Kept 30 days (D57). | Export CSV | `GET /api/orgs/:id/audit` |
| **Org settings** | Name, tier (read-only), created. | Rename, rotate the org data key, delete the org (D30) | `PATCH /api/orgs/:id`, `POST …/keys/rotate`, `DELETE /api/orgs/:id` |

## Platform console

Console views show org and instance names (D61) and status, never instance content.

| View | Roles | Shows | Actions | API |
|---|---|---|---|---|
| **Overview** | support+ | Orgs and instances by status, Railway services in use of the workspace's 100 (a "needs a look" entry from 80%), instances with no heartbeat for a while, failed or stuck Workflows, waitlist length, codes left, worca version adoption. | Drill down | needs a stats endpoint |
| **Orgs** | support+ | id, tier, status, members, instances, created. Org detail: the same with the tier's limits (instances and members used of allowed, the sizes it includes) plus its instances' status, size and "above plan". | admin: change tier; turn release candidates on or off (D80) | `GET /api/platform/orgs`, `PUT …/orgs/:id/tier`, `PUT …/orgs/:id/release-candidates` |
| **Instances** | support+ | id, org, status, version, health, last heartbeat, abuse flag. Filters: status, org, "unhealthy", "outdated". Detail: current operation and its phase, pipeline counts, provider refs and provider status, remote access in Worca (read-only). | admin: stop for abuse, lift (D60 lets the tenant delete it), renew credentials (D74; "Renew all credentials" on Operations) | `GET /api/platform/instances[/:id]`, `POST …/stop`, `POST …/lift`, `POST …/rotate`, `POST /api/platform/instances/rotate` |
| **Registration** | admin+ | Current mode; codes with tier, uses left, expiry; waitlist with sign-up date. | Create and revoke codes; approve or reject waiting accounts. superadmin: change mode (D25) | `/registration`, `/registration/codes`, `/waitlist` |
| **Users** | admin+ | Look up one account by exact email: status, sign-in methods, orgs. | Sign out everywhere, disable or enable, sign-in reset approved by a second staff member | `/api/platform/users`, `/api/platform/support-requests` |
| **Audit log** | admin+ | Platform audit: role changes, stops, tier changes, settings. | Export CSV | `GET /api/platform/audit` |
| **Releases** | superadmin | Current worca version, released versions (published by hand or from npm), how many instances run each, withdrawn ones with their reason, npm versions held back from enrollment and why, the release settings. | Release candidates are marked "release candidate" and never the latest (D80). Publish a version (tenants then upgrade themselves, D26); withdraw a release with a reason, or restore it; turn automatic enrollment on or off and set how long automatic updates wait (D77) | `/worca-version`, `/releases`, `/releases/:version/withdraw`, `/releases/:version/restore`, `/release-settings` |
| **Tiers** | support+ | Tiers with their instance and member limits, compute sizes (the default marked), how many orgs are on each, which one new orgs get; the fixed compute sizes. | superadmin: new tier, edit, delete one nothing uses (D78) | `GET/POST /api/platform/tiers`, `PUT/DELETE …/tiers/:id` |
| **Platform roles** | superadmin | Staff with their roles. | Grant or revoke (the last superadmin is protected) | `/roles` |
| **System** | superadmin | Registration mode, master key version and the last rotation. | Rotate the master key; provider and mail status | `/api/platform/keys/master`, `/keys/rotate-master`, `/system/providers`, `/system/mail` |

## Pages on instance hosts (gate)

These are server-rendered by the gate on `{slug}.worca.run` (`src/gate/pages.ts`) in the app's
look, with one inline stylesheet allowed by a per-response CSP nonce and the logo inlined, so they
load nothing from other origins:

- **Starting:** the instance is waking up; refreshes on its own.
- **Suspended for the moment, waking:** the same page while a wake runs.
- **Stopped:** stopped by the platform; contact your admin.
- **No access:** signed in, but no team grants this instance.
- **Sign in again:** the instance policy needs another method (D23).

## Feedback

As worca (ui/public/feedback.mjs, #555): report each result once, where the eyes are, with an icon
and words.

| What happened | Where it shows | Helper (core.mjs) |
|---|---|---|
| A form saved in place | Its button: spinner and "Saving…", then a green "✓ Saved" for 2 s | `busy(btn, fn, { done: 'Saved' })`; `fn` returns `false` when it reported a problem itself |
| One field (or a group sharing one rule) is wrong | Under the field: red border, `aria-invalid`, icon and sentence linked by `aria-describedby`, focus; cleared when edited | `fieldError(target, text)`, `clearFieldErrors(root)` |
| The form or action as a whole is refused, to read in place | A red alert box above the buttons, in the form or dialog (a dialog replaced by a passkey step opens again with it) | `alertBox(id)`, `showAlert(el, text)` (`.banner.red`) |
| A switch that applies at once | Its new state; a failure turns it back and shows an error toast | `busy(null, …)` |
| A decision taken in a dialog | The dialog closes; a toast says what happened (with an action where useful) | `toast(text, kind, { detail, action, key })` |
| Something that finishes elsewhere or later | A toast: an instance operation started in this tab (create, version change, remote access, an outbound network change, a git credentials change, lifting a stop) or an org key rotation, when the person isn't on its page | `watchOp({ url, href, kind, ok, fail })` |

Toasts sit bottom right (full width on a phone), at most three (the oldest non-error goes first).
`ok` and `info` close after 5 s, paused while hovered or focused; `warn` and `error` stay until
dismissed. Each has a Dismiss button and at most one action (Open, Details, Retry, Undo); errors
are `role=alert`, the rest `role=status`; a toast never takes focus. The server-rendered pages
(sign-in, newsletter, access-request confirmation) follow the same rule with `FEEDBACK_JS` in
src/control/auth/pages.ts: field errors under the field, the status box as a red alert.

## API gaps the UI needs

1. Platform overview stats (counts by status, unhealthy, stuck Workflows).
2. Operation progress (phases of create, upgrade, wake), for the create and detail views.
3. Org overview summary (or the UI aggregates existing endpoints at first).
4. Platform user lookup by email (blind index) and the passkey-reset support action.
5. Resend an invitation.
6. Master key status (version, last rotation).
7. Tier limits and current use per org, for the create-instance form.

## Building it

- **Stack (D66):** plain ES modules and one stylesheet in `ui/`, no framework and no build step, as
  in worca's own UI. The control Worker serves them (`src/control/ui.ts`): `/assets/*` are the
  files, every other app route gets `ui/index.html` once signed in. The CSP (`script-src 'self'`,
  `style-src 'self'`) stays unchanged, so pages use no inline scripts or styles. Conventions for
  views are in [ui/README.md](../ui/README.md).
- **Routing:** `/` home, `/account/*`, `/o/:orgId/*` for the org workspace, `/platform/*` for the
  console. The server pages (`/sign-in`, `/invite/:id`, `/confirm/*`) stay server-rendered and use
  the same stylesheet.
- **Tests:** `npm run test:ui` drives the views in Chromium (Playwright) against the local stack.

## Decided

Open questions from this concept were settled on 2026-10-06 (D61–D63): names are shown in the
console, every member sees the member directory, and the UI shows only data we have (no history
charts, no session location). The look follows worca's own design system (the "Refined" tokens of
worca-cc and worca.dev). Prototypes:
[org workspace](https://claude.ai/artifact/Q8VVh7h8HZ8mYVSzPKaLeu),
[platform console](https://claude.ai/artifact/4LfcWQLtCkW96sZX2UFZ2h). Feasibility per feature:
[UI feasibility](ui-feasibility.md).
