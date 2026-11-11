# Data model

A first sketch of the control plane's tables. **E** marks an encrypted column; the key column says
which data key. Better Auth's own tables (`user`, `session`, `account`, `verification`, `passkey`,
organization and team tables) are mapped onto these through its adapter; names will follow Better
Auth where it already has a table.

## People

| Table | Columns |
|---|---|
| `users` | id, **E** email (user key), email_index (blind index), **E** name (user key), status (`pending`, `active`, `disabled`), registration_code_id (the `registration_codes` hash of the code used at sign-up; empty for accounts made before it was recorded), created_at |
| `accounts` | id, user_id, provider (`google`, `microsoft`, `sso:<id>`, …), provider_account_id, **E** tokens (user key) |
| `passkeys` | id, user_id, credential id, public key, counter, created_at, last_used_at (set when the passkey signs someone in; empty until then) |
| `sessions` | id, token_hash (D49), user_id, **E** ip address (user key), **E** user agent (user key), method used, mfa (yes/no), expires_at. Deleted 7 days after expiry |
| `verifications` | id, identifier_index (blind index; Better Auth puts the email address in the identifier), value_hash (D49), expires_at. Deleted 1 day after expiry |
| `platform_roles` | user_id, role (`superadmin`, `admin`, `support`), granted_by, granted_at |
| `data_keys` | owner type (`org`, `user`), owner_id, version, wrapped key, master_id (fingerprint of the master key that wrapped it; empty before migration 0011), created_at, rotated_at and rotated_by (on the version an org key rotation created; `rotated_by` is empty for system rotations), destroyed_at |

## Orgs, teams, instances

| Table | Columns |
|---|---|
| `orgs` | id, **E** name (org key), tier, limits, status, created_at |
| `org_members` | org_id, user_id, role (`tenant_admin`, `tenant_user`), joined_at |
| `teams` | id, org_id, **E** name (org key) |
| `team_members` | team_id, user_id |
| `instances` | id, org_id, slug, key_slug, **E** display name (org key), status (`creating`, `running`, `suspended`, `stopped`, `upgrading`, `deleting`), worca_version, available_version, railway_project_id, tunnel_id, cpu/memory_mb (the Worca service's ceiling: the compute size's, D78), volume_gb (the tier's intended volume size; not applied, Railway's API takes no size), compute_size (`standard`, `large` or `xl`, D78; `standard` for instances from before it) and size_pending (1 while a size is saved but not yet applied on Railway: changed while asleep, stopped or busy, or the reconfigure failed), compute_facts and compute_facts_at (what Railway last reported: region, per-service CPU and memory ceilings, volume sizes, as JSON, and when it was read; NULL until first read, see [Instance lifecycle](instance-lifecycle.md#compute-facts)), health, health_since (when `health` last changed), stopped_reason, stopped_by (D47), auto_update (`micro` or `off`: automatic micro updates, D26 as amended; `micro` for new instances, existing ones set to `off` by migration 0020), auto_update_minor (0 or 1: with `micro`, minor releases too, D75; 0 for every instance until a tenant admin turns it on), auto_update_failed_version (the version automatic updates skip, with anything not newer, until a newer release is published: one an automatic update rolled back from, or one a tenant admin downgraded away from; NULL when none), terminal_remote and actions_remote (0 or 1: Worca's terminal and actions, `WORCA_TERMINAL_REMOTE` / `WORCA_ACTIONS_REMOTE` on the worca service; tenant admins switch them, D72), remote_pending (1 while saved values are not yet applied on the worca service), egress_mode (NULL: follows the org's outbound network policy; else the override's `open`, `block` or `allow`, D73), **E** egress_hosts (org key; the override's `{ allow, deny }` host lists as JSON, NULL without an override), heartbeat_cred_hash_prev and heartbeat_cred_prev_until (during a rotation, the hash of the heartbeat credential a running instance used before and until when it is still accepted, at most 30 minutes; NULL otherwise, D74), secrets_rotated_at (when its credentials were last renewed, D74), egress_version (moves on whenever the effective policy may have changed: override set or removed, or the org policy it follows changed; compare-and-set and pending clearing use it), egress_pending (1 while the effective policy is not yet confirmed applied: saved while asleep, stopped or busy, or the reconfigure failed), deployed_images (JSON `{ worca, broker, cloudflared }`: the images of the last deploy, written by create, upgrade and roll back, and by a refresh or wake once the new cloudflared reported in; NULL for instances deployed before migration 0026, whose cloudflared counts as out of date, D76), **E** git_settings (org key; the git credentials, commit identity, clone allowlist and push mode as JSON, D79; NULL when none), git_version (0: never set from the console, its git variables are left alone; else moves on with every change), git_pending (1 while not yet confirmed applied), git_broker_applied (SHA-256 of the broker git variables its running deployment has, to tell when it must restart; NULL for none) |
| `instance_teams` | instance_id, team_id, role (empty in v1, D20). Every instance has at least one row (D71), kept by the API, not a constraint: the create inserts the instance and its teams in one batch, and removing the last team or deleting an instance's only team is refused |
| `heartbeats` | instance_id, received_at, health, worca_version, pipeline counts by status, next scheduled run, suspendable (yes/no) |
| `instance_ops` | op_id, instance_id, org_id (copied, because the row outlives a deleted instance), kind (`create`, `upgrade`, `delete`, `wake`, `suspend`, `stop`, `lift`), workflow_id, phase and phase_started_at (user-facing, see [Instance lifecycle](instance-lifecycle.md#operations-and-their-phases)), step and whether it is running, attempts of the current step, started_at, updated_at, finished_at, status (`running`, `done`, `failed`), outcome, last_error. Ids, phases and error texts only, no tenant data, so nothing is encrypted. Kept 30 days after the operation finishes |

## Policies and connectors

| Table | Columns |
|---|---|
| `org_login_policies` | org_id, allowed methods, required email domain (**E**, org key) |
| `org_egress_policies` | org_id, mode (`open`, `block`, `allow`), **E** hosts (org key; `{ allow, deny }` as JSON, NULL when both are empty), version (bumped on every change; a change names the version it was based on), updated_at. No row: open, version 0 (D73). Deleted with the org |
| `instance_login_policies` | instance_id, required methods (narrowing only) |
| `org_domains` | org_id, **E** domain (org key), domain_index, verification token, verified_at |

## Invites and confirmations

| Table | Columns |
|---|---|
| `registration_codes` | code hash, created_by, tier, uses left, uses total, **E** note (user key of the staff member who created the code), expires_at, email_index (set on codes granted for an access request: only that address may sign up with it, D69) |
| `access_requests` | id (`ar_` + uuid), **E** email, email_index, **E** use_case, **E** company, source, status (`unconfirmed`, `pending`, `granted`, `declined`, `joined`), confirm token hash (D49), confirm expires_at and sent_at, created_at, confirmed_at, decided_at, decided_by, **E** decision note (the staff member's message), registration_code_id (the granted code's hash), joined_at, notified_at (when superadmins were told), shredded_at. **E** columns use the request's own data key (`{ type: 'user', id }`). One open (`unconfirmed` or `pending`) request per address. Retention (D69): unconfirmed rows are deleted with their key 7 days after the link expired; 180 days after the decision (`joined`: the sign-up) the key is deleted and email, email_index, use_case, company and decision note emptied, leaving an anonymous row for the funnel counts |
| `org_invites` | id, org_id, **E** email (org key), email_index, role, teams, invited_by, expires_at, accepted_at |
| `sso_providers` (Better Auth) | id, provider id (`sso-` prefix, unique across the platform), org_id, **E** domain (org key), domain_index, **E** settings and secrets (org key), created_at (set by us; empty for providers registered before migration 0014) |
| `confirmations` | id, user_id, action, target, token hash, expires_at, used_at |
| `support_requests` | id, kind (`signin_reset`), user_id (the person being reset), requested_by, **E** reason (key of the person being reset, so erasing them erases it), created_at, expires_at (24 hours after the request), approved_by, approved_at, executed_at, status (`open`, `approved`, `executed`). Deleted 30 days after it expired unapproved or was executed |

## Audit

| Table | Columns |
|---|---|
| `audit_platform` (entries kept 30 days, D57) | id, at, actor user_id, actor role, action, target type and id, details (ids and numbers only, never tenant data, so not encrypted) |
| `audit_org` (entries kept 30 days) | id, org_id, at, actor user_id, actor scope (`platform`, `tenant`), action, target type and id, **E** details (org key) |

`audit_org` is append-only. A trigger refuses every update, with one exception added in migration
0011: the key re-encryption job may replace an entry's `details` with a ciphertext of the same
plaintext under a newer key version. For that update every other column must be unchanged and both
the old and the new value must be ciphertexts. Deletes are refused for entries younger than 30 days
unless the org is gone (migration 0003).

## Outside D1

The gate object (one Durable Object per instance, D43) holds only ids, statuses and times: the
instance's status, its gate sessions (session id, user id, control-plane session id, created at),
the last visit, the latest `suspendable` flag, the next scheduled run, and whether a wake is
under way. No tenant data,
so nothing in it is encrypted. KV holds hostname → instance id.

## Keys, mail and releases

| Table | Columns |
|---|---|
| `key_rotation_jobs` | org_id (one row per org; a newer rotation replaces it), target_version, status (`running`, `verifying`, `done`, `incomplete`), step and cursor (where the job is in the list of encrypted columns), done and total rows, failed rows, passes, last_error, started_at, updated_at, finished_at. Counts and ids only |
| `worca_releases` | version, published_at (empty for releases recorded before the table existed), published_by (empty for npm and older releases), source (`manual` or `npm`, D77), withdrawn_at, withdrawn_by, withdrawn_reason (staff-written, shown to the org admins of instances on it) |
| `release_holds` | npm versions not enrolled yet (D77): version, reason (`image_missing`, `registry_unavailable`, `label_mismatch`), detail (the version the image reports), first_seen_at, checked_at |
| `mail_daily` | day (UTC), kind (`sign_in_code`, `invitation`, `confirmation`, `notification`, `passkey_notice`), count |
| `mail_messages` | email_id (Resend's id), ref (e.g. `invitation:<id>`), kind, sent_at, last_event (`sent`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed`, `suppressed`, `send_failed`), last_event_at. No recipient addresses. Deleted 30 days after the final event; in flight (no event, `sent`, `delivery_delayed`) kept up to 180 days; an existing invitation's mail is kept with it |

## Settings

| Table | Columns |
|---|---|
| `org_settings` | org_id, tier, status, created_at, rc_access (0 or 1: its tenant admins may pin instances to release candidates, D80; set by staff with tenant rights) |
| `platform_settings` | key, value (registration mode, default tier, version channels, when superadmins were last told about access requests, …) |
| `tiers` | id, name, instances per org, vCPU and memory (the default size's, for older readers), volume size, members, sizes (JSON list of compute size ids its orgs may pick, D78), default_size. Seeded: `free` (1 instance, 10 members, Standard), `team` (5, 25, Standard and Large), `business` (10, 50, all three). Compute sizes themselves are fixed in `instances/sizes.ts` |

## Newsletter

| Table | Columns |
|---|---|
| `newsletter_subscribers` | id (`nl_` + uuid), **E** email (the subscriber's own data key, `{ type: 'user', id }`; NULL once shredded), email_index (blind index, unique), status (`unconfirmed`, `active`, `unsubscribed`, `suppressed`), releases (`none`, `major`, `minor`, `micro`, `rc`: a threshold), product (0/1), token_version (part of the signed manage link; "unsubscribe from everything" bumps it), confirm_token_hash and confirm_expires_at (the pending double opt-in link, 7 days), source (`website`, `account`, ...), created_at, confirmed_at (the consent), unsubscribed_at, updated_at, shred_after (set on unsubscribe or suppression, 30 days ahead). Unconfirmed rows and their keys are deleted after 30 days; after `shred_after` the key is deleted and email set to NULL, the index and status stay (suppression list); account deletion deletes the row and key |
| `newsletter_issues` | id, kind (`release`, `product`), version (unique per kind), release_level (`major`, `minor`, `micro`, `rc`), subject, url (the release notes), status (`sending`, `sent`, `failed`), recipients (counted at the start), sent_count, created_at, finished_at |

`mail_daily` also counts `newsletter` (issues) and `newsletter_confirm` (opt-in and manage-link
mails); newsletter mails are recorded in `mail_messages` under `newsletter:<subscriber id>:<issue id | confirm | link>`.
