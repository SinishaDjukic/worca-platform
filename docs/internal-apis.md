# Internal APIs

How the control plane's modules call each other, and the tables more than one module reads.
Each module's owner may change its internals freely but keeps these signatures. Cross-Worker
calls are in `src/shared/contracts.ts`.

## Hostnames

A *host* is always a hostname without a port: `k7m2qz9xwp.worca.run`, locally
`k7m2qz9xwp.run.localhost`. URLs are built as
`${INSTANCE_SCHEME}://${host}${INSTANCE_ORIGIN_SUFFIX}`. Identity token audiences and KV keys use
the host. The gate strips the port from the `Host` header.

## Modules

### keys (`src/control/keys.ts`, `keys-jobs.ts`, `auth/database.ts`)

- `getKeyRing(env): KeyRing` (interface in `keys-api.ts`).
- `KeyRing.rotateOrgKey(orgId, { by? }): Promise<number>` adds the next version of the org's key
  (`data_keys.rotated_at`, `rotated_by = by`) and calls `startOrgReencryption` (`keys-jobs.ts`),
  which records a `key_rotation_jobs` row and starts a `KeyRotationWorkflow`. Old rows stay
  readable until the job has re-encrypted them and destroyed the older versions.
- `getOrgKeyInfo(env, orgId): OrgKeyInfo` (`keys-jobs.ts`): `{ version, rotatedAt, rotatedBy,
  reencryption: { status: 'none' | 'running' | 'verifying' | 'done' | 'incomplete', done, total,
  failed, error } }`. Served by `GET /api/orgs/:orgId/keys`.
- `masterKeyStatus(env): MasterKeyStatus` and `rewrapDataKeys(env, { limit?, after? })`
  (`keys.ts`): master key rotation, served by `/api/platform/keys/master` and
  `/api/platform/keys/rotate-master`. See [Security](security.md#rotating-the-master-key).
- `createDatabase(env)`: the value for Better Auth's `database` option, with the adapter wrapper.
- Field contexts used by other modules when they read encrypted columns directly:

| Table.column | Owner |
|---|---|
| `user.email`, `user.name` | `{ type: 'user', id: user.id }` |
| `organization.name` | `{ type: 'org', id: organization.id }` |
| `team.name` | `{ type: 'org', id: team.organizationId }` |
| `invitation.email` | `{ type: 'org', id: invitation.organizationId }` |
| `instances.display_name` | `{ type: 'org', id: instances.org_id }` |
| `audit_org.details` | `{ type: 'org', id: audit_org.org_id }` |
| `org_login_policies.required_domain` | `{ type: 'org', id: org_id }`; `rowId` is `org_id` |
| `org_domains.domain` | `{ type: 'org', id: org_domains.org_id }` |
| `ssoProvider.domain`, `.oidcConfig`, `.samlConfig` | `{ type: 'org', id: ssoProvider.organizationId }` (a provider without an org: the user) |
| `confirmations.payload` | `{ type: 'org', id: org_id }` when `org_id` is set, else the user |
| `registration_codes.note` | `{ type: 'user', id: registration_codes.created_by }`; `rowId` is `code_hash` |
| `support_requests.reason` | `{ type: 'user', id: support_requests.user_id }` |
| `newsletter_subscribers.email` | `{ type: 'user', id: newsletter_subscribers.id }`: the subscriber's own key (ids start with `nl_`, never a user id) |
| `session.ipAddress`, `.userAgent`; `account.accessToken`, `.refreshToken`, `.idToken` | `{ type: 'user', id: userId }` |

`rowId` is the row's `id` column unless the row says otherwise.

**Every encrypted column must be listed in `keys-jobs.ts`**: in `ORG_COLUMNS` when an org key
owns it (the rotation re-encrypts it), or in `OTHER_ENCRYPTED_COLUMNS` when a user key owns it.
Before a rotation destroys the older versions of an org key, it scans every table for ciphertexts
(`e1.<version>.<iv>.<ct>`) in unlisted columns. If it finds any, the job ends `incomplete` and the
old versions are kept, so a forgotten column blocks rotation instead of becoming unreadable. Add
the column there in the same change that adds it to a table.

### auth (`src/control/auth/`)

- `getAuth(env)`: the Better Auth instance (`auth/index.ts`).
- `globalMiddleware`, `requireSession` (`auth/middleware.ts`). After `globalMiddleware`,
  `c.get('user')` and `c.get('session')` are set (decrypted) or null.
- `sendEmail(env, { to, subject, text, html, kind?, ref?, from?, headers? })` (`auth/email.ts`; `from` defaults to `EMAIL_FROM`, `headers` go to Resend as is). `sendEmailBatch(env, mails, { idempotencyKey? })` sends up to 100 through Resend's batch endpoint (newsletter). With `LOCAL_DEV=1`
  and no `RESEND_API_KEY`, mail is stored in KV under `dev:mail:<to>` and readable at
  `GET /__dev/mail?to=<email>` (JSON array, newest last; only when `LOCAL_DEV=1`). Every send
  increments `mail_daily` for its `kind` (`sign_in_code`, `invitation`, `confirmation`,
  `notification`, `passkey_notice`, `newsletter`, `newsletter_confirm`; untagged mail is a `confirmation` when the subject starts with
  `Confirm:`, else a `notification`). With a `ref` such as `invitation:<id>`, the Resend email id
  is stored in `mail_messages` (a refused send is stored as `send_failed`), and the webhook
  updates its last event.
- `deliveryStatusFor(env, ref)` (`system/mail.ts`): `{ emailId, kind, sentAt, status, at } | null`
  for the newest mail sent under `ref`; `status` is the last webhook event, `accepted` before any
  event, or `send_failed`. `invitationMailRef(id)` builds the ref of an invitation's mail. No
  route returns it yet.
- `approveWaitlistedUser(env, userId): Promise<boolean>` (`auth/index.ts`): sets `status` to
  `active` and `registeredVia` to `approved`; false when the user isn't `pending`.
- Sign-up decisions carry `registrationCodeId` (`registration_codes.code_hash` of the claimed
  code, else null); the user create hook stores it in `user.registrationCodeId`.
- After a successful `/passkey/verify-authentication`, an after-hook sets `passkey.lastUsedAt`
  (`recordPasskeyUse`).
- `getRegistrationMode(env): Promise<'invite_code' | 'waitlist' | 'open'>`.
- Better Auth organization roles: `tenant_admin`, `tenant_user`. `user.status` is a Better Auth
  additional field: `pending | active | disabled`.
- Session additional fields `method` and `mfa` (see `SessionInfo` in `env.ts`).

### tenancy (`src/control/tenancy/`)

- `roles.ts`: `PlatformRole`, `Capability`, `can(roles, cap)`, `getPlatformRoles(env, userId)`,
  `requireCap(cap)` (middleware: 401 / 403; platform capabilities also need `session.mfa`, D24),
  `requireOrgRole(role?)` (middleware on routes with `:orgId`; 404 for non-members).
- `audit.ts`: `auditPlatform(env, { actorId, actorRole, action, targetType, targetId, details })`,
  `auditOrg(env, orgId, { actorId, actorScope, action, targetType, targetId, details })`,
  `pruneAudit(env)` (30 days, D57).
- `policy.ts`:
  `checkInstanceAccess(env, { userId, sessionMethod, instanceId })` →
  `{ ok: true, orgId, teamIds } | { ok: false, reason: 'not_found' | 'not_member' | 'no_team' | 'policy_method' | 'policy_domain' | 'disabled', requiredMethods?: string[] }`.
- `policy.ts` also exports the lock-out analysis behind D31: `currentPolicyState(env, orgId)`,
  `lockOutReport(env, orgId, current, next, { removeSsoProviderId? }): AffectedMember[]` and
  `describeAffected`. `AffectedMember` is `{ id, name, email, reasons: ('domain' | 'method' |
  'signed_out')[], instanceIds }`. Lock-out is defined in
  [Security](security.md#what-counts-as-locking-members-out).
- `teams.ts`: `teamNamesFor(env, orgId, teamIds): Promise<Map<string, string | null>>`, names of
  teams of that org only (other orgs' ids are left out). The instances list uses it so tenant
  users see the names of the teams that grant them access.
- `support-routes.ts`: `endAllSessions(env, userId): Promise<number>` deletes every control-plane
  session of the user and drops their gate sessions on every instance they can reach (D46);
  returns the number of sessions ended. Used by sign-out and disable.
- `sso-routes.ts`: `SSO_PROVIDER_ID_RE` (`^sso-[a-z0-9-]{3,40}$`), `isReservedProviderId`,
  `providerIdTaken` (true when any provider or any account already uses the id),
  `ssoEndpoints(env, providerId, type)`; for registration `ssoRegistrationSchema`,
  `prepareSsoRegistration(env, body, providerId)` (URL checks, SAML shaping; returns
  `{ issuer, config }` for the plugin), `discoverOidcEndpoints(env, issuer, oidcConfig)` (OIDC
  discovery with the IdP trust scoped to that call; returns the config with every endpoint and
  `skipDiscovery: true`), `idpUrlAllowed(env, url)`, and `ssoRegistrationFailure(err)`, which
  turns `SsoConfigError`, the plugin's `DiscoveryError` and its 4xx `APIError`s into stable codes.
  `deps.ts` `registerSsoProvider` calls the plugin without `organizationId` (its register route
  only lets org roles `owner`/`admin` name an org, and ours is `tenant_admin`), then sets the org
  through the adapter, which re-encrypts the provider's fields under the org's key, and marks the
  domain verified.
- `confirmations.ts`: `registerConfirmAction(action, handler)` and
  `startConfirmation(env, { userId, orgId, action, target, payload, summary })`. The handler
  `(env, ctx, { userId, orgId, target, payload }) => Promise<void>` runs on the confirming POST
  (D30).

### identity (`src/control/identity/`)

- `signIdentityToken(env, claims)`, `getJwks(env)`.
- `GET /authorize?host=<host>&state=<state>&return=<path>`, `GET /.well-known/jwks.json`.
- `exchangeCode`, `renewToken` behind `ControlRpc`.

### instances (`src/control/instances/`)

- `getProviders(env): { compute: ComputeProvider; edge: EdgeProvider }` (`providers/index.ts`).
- `stopForAbuse(env, instanceId, { actorId, reason })`, `liftStop(env, instanceId, { actorId })`,
  `deleteInstanceNow(env, instanceId, { actorId })` (used by org deletion; no confirmation).
- `instanceUrl(env, host)`, `findInstanceByHost(env, host)` →
  `{ id, orgId, kind: 'worca' | 'keypage', status } | null`.
- `requestSuspend`, `requestWake` and `wakePhase` behind `ControlRpc`. `wakePhase(instanceId)`
  (`instances/progress.ts`) returns `'starting'` or `'waiting'` while a `wake` or `lift` operation
  is running, else `null`. `ControlRpcApi.wakePhase` and the `WakePhase` type are in
  `src/shared/contracts.ts`; the gate calls it on its status path while the instance is
  `suspended`.
- `startOp(env, params)` (`api.ts`) writes the `instance_ops` row first, then starts
  `InstanceOpsWorkflow` under the id `<op>-<instanceId>-<time>`; `restartWorkflow(env, workflowId)`
  calls the Workflow's `restart()`.
- `OP_PHASES` (`progress.ts`): the user-facing phases of each operation kind, in order. Operation
  rows carry the phase, not the Workflow step name (see
  [Instance lifecycle](instance-lifecycle.md#operations-and-their-phases)).
- `providerStatusFor(env, instanceId): InstanceProviderStatus | null` (`provider-status.ts`): the
  cached Railway and Cloudflare status of one instance, read from KV (`provider-status:v1`), never
  from the providers. Null when the instance doesn't exist. Platform staff only.
- `refreshProviderStatus(env)`: one Railway query and one Cloudflare tunnel list, run by the
  5-minute cron.

### providers (`src/control/providers/`)

- `createRailwayProvider(env, fetchImpl = fetch): ComputeProvider` (`railway.ts`).
- `createCloudflareEdge(env, fetchImpl = fetch): EdgeProvider` (`cloudflare.ts`).
- `createFakeCompute(env)`, `createFakeEdge(env)` (`fake.ts`), against the stub's admin API.
- Read-only status, added for the consoles (`providers/types.ts`):
  - `ComputeProvider.deploymentStatuses(refs): Promise<Record<projectId, ProjectStatus>>`.
    `ProjectStatus` is `{ worca?, broker?, cloudflared? }`, each `{ status, statusUpdatedAt }`
    with Railway's `DeploymentStatus` string or null without a deployment. Railway answers with
    one workspace query for every `worca-run-*` project; the fake maps the stub's state to
    `SUCCESS`, `REMOVED` or `FAILED`.
  - `EdgeProvider.tunnelStatuses(tunnelIds): Promise<Record<tunnelId, TunnelStatus>>`, with
    `TunnelStatus` one of `healthy`, `degraded`, `down`, `inactive`. Cloudflare lists the
    `worca-run-*` tunnels, 100 per page; the fake answers `healthy` for every id.
  - `EdgeProvider.connectorVersions(tunnelId): Promise<string[] | null>` (D76): the cloudflared
    version of each live connection, from `GET cfd_tunnel/{id}` (`connections[].client_version`,
    pending reconnects left out); `worca-run-*` tunnels only. The fake answers null (can't tell).
- Component refresh (D76): `ComputeProvider.deploy(ref, image, kinds?)` deploys only `kinds` when
  given; `start(ref, { images })` sets those services' new image and deploys from the configuration
  instead of redeploying the stopped deployment.

## HTTP routes added or changed for the consoles

The two consoles ([UI feasibility](ui-feasibility.md)) call these. Bodies are JSON; errors are
`{ "error": "<code>" }`. Times are unix milliseconds unless a field is described as ISO text
(Better Auth's own date columns). Routes the consoles didn't need changed are not repeated here.

Access in the tables:

- **signed in**: any session, whatever the account's status (`requireSignedIn`).
- **member** / **tenant admin**: a member of `:orgId` with that role. Non-members get 404.
- **MFA**: the session was signed in with a passkey (D24).
- **cap `x`**: a platform capability. Every capability also needs an MFA session. Roles per
  capability: `platform.view` support, admin, superadmin; `audit.view`, `tenants.manage`,
  `registration.codes`, `waitlist.manage`, `instances.stop`, `instances.rotate`, `users.support` admin, superadmin;
  `system.settings`, `roles.manage`, `keys.master`, `access_requests.manage` superadmin only.

### Account: `/api/me` (`tenancy/me-routes.ts`)

| Route | Access | Response |
|---|---|---|
| `GET /api/me` | signed in | `{ user: { id, email, name, status }, session: { method, mfa, activeOrganizationId }, signIn: { emailCode: true, passkeys, providers, available }, orgs, platformRoles }`. `signIn.passkeys` is the number of passkeys; `providers` is a sorted subset of `google`, `microsoft`, `sso` (linked ones); `available` lists `google` and `microsoft` when this deployment has their client credentials, i.e. the providers a user can link (Better Auth's `/link-social`; `/unlink-account` may remove the last one, since an email code always works). Each `orgs` entry is `{ id, name, role, joinedAt, instances }`; `instances` is how many instances the caller can open in that org (every non-deleting one for a tenant admin, those their teams grant otherwise): a number only |
| `GET /api/me/sessions` | signed in | `{ sessions: [{ handle, current, method, mfa, device, createdAt, lastActiveAt, expiresAt }] }`: the caller's unexpired sessions, the current one first. `handle` is a signed session handle (valid 15 minutes), never a token. `device` is a coarse "Browser on OS" label; the user agent, IP address and location are never returned. The three times are ISO text; `lastActiveAt` refreshes at most once a day |
| `DELETE /api/me/sessions/:handle` | signed in | `{ ok: true }`, and the session's gate sessions are dropped (D46). 404 `session_not_found` for a malformed, forged, expired or foreign handle (one answer for all four); 409 `current_session` for the caller's own session (sign out instead) |
| `POST /api/me/sessions/revoke-others` | signed in | `{ ok: true, revoked }`: ends every other session of the caller, expired rows included, and their gate sessions |
| `GET /api/me/passkeys` | signed in | `{ passkeys: [{ id, name, deviceType, backedUp, createdAt, lastUsedAt }] }`; `lastUsedAt` is null until the passkey first signs someone in. Read-only: adding, renaming and removing stay on Better Auth's passkey routes (MFA-guarded, D24) |

Both session revocations are audited in the platform log (`auth.session_revoked`,
`auth.other_sessions_revoked`).

### Org console: `/api/orgs/:orgId/...`

| Route | Access | Request | Response |
|---|---|---|---|
| `GET /members` | member | | Role-shaped (D62). Every member gets `{ members: [{ userId, role, name, email, teams: [{ id, name }] }] }`. A tenant admin also gets, per member, `joinedAt`, `signsInWith: { methods, passkeys }` (`methods` from `email-otp`, `passkey`, `google`, `microsoft`, `sso`; `email-otp` is always there) and `invitedBy: { userId, name }` or null (the inviter of the member's accepted invitation, matched through the email blind index) |
| `GET /teams` | member | | Every member gets `{ teams: [{ id, name, members, mine }] }`. A tenant admin also gets `createdAt` and `instanceIds` |
| `GET /teams/mine` | member | | `{ teams: [{ id, name, members, instanceIds }] }`: the caller's own teams and the instances each grants them |
| `DELETE /teams/:teamId` | tenant admin | | `{ ok: true }`. Removes its grants and members; members who lose access lose their gate sessions (D46). Audited as `team.deleted`. 404 `not_found`; 409 `{ error: 'team_has_instances', instances }` while it is the only team of `instances` instances not being deleted (D71): assign them another team or delete them first |
| `POST /teams/:teamId/instances/:instanceId` | tenant admin | | `{ ok: true, changed }`; `changed` is false when the team already had the grant. 404 `not_found` (team) or `instance_not_found`. Audited as `instance.teams_changed` |
| `DELETE /teams/:teamId/instances/:instanceId` | tenant admin | | `{ ok: true, changed, droppedUsers }`. Members of the team whom no other team grants the instance lose their gate sessions on it (D46); `droppedUsers` counts them. 409 `last_team` when it is the instance's only team (D71) |
| `POST /invitations` | tenant admin | `{ email, role?, teamId? }` | `201 { id, expiresAt }`; mails the invitation. 409 `already_member` (the address belongs to a member), `already_invited` (an unexpired pending invitation for it; resend that one instead), `member_limit` (members plus pending invitations reach the tier's limit, D33); 404 `team_not_found`; 429 `invitation_mail_limit` (50 invitation mails a day per org) |
| `GET /invitations` | tenant admin | | `{ invitations: [{ id, email, role, status, expiresAt, createdAt, inviterId, teamId, inviter: { userId, name }, expired, delivery }] }`, pending ones only. `delivery` is the last mail event from Resend (`accepted`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed`, `suppressed`, `send_failed`) with its time, or null |
| `POST /invitations/:id/resend` | tenant admin | | `{ id, expiresAt }`. Mails the invitation again with a fresh expiry; not subject to the member limit, since the pending invitation already holds its seat. When the invitation had expired, Better Auth creates a new one: the response carries the new id and the old one is canceled. 404 `not_found`; 409 `invitation_unreadable`; 429 `resend_too_soon` (1 per 5 min), `invitation_mail_limit` (5 a day per invitation, 50 invitation mails a day per org) |
| `GET /audit` | tenant admin | query `before`, `limit`, `actorId`, `action`, `category` | `{ entries: [{ id, at, actorId, actorScope, action, category, targetType, targetId, details }] }`, newest first |
| `GET /keys` | tenant admin | | `getOrgKeyInfo` (see Modules, keys). `POST /keys/rotate` (tenant admin, MFA) answers `{ version }` and starts the re-encryption |
| `GET /summary` | tenant admin | | `{ instances: { byStatus, total, limit, sizes: [<size>], defaultSize, upgradesAvailable: [{ id, name, version, availableVersion }], degraded: [{ id, name, healthSince, lastHeartbeatAt }] }, members: { count, limit }, invitations: { open, expiringWithin48h }, signIn: { allowedMethods, requiredDomain, instanceOverrides, ssoProviders } }`. Current state only, no history. Empty `allowedMethods` means every method; `ssoProviders` counts domain-verified ones |
| `GET /policy` | tenant admin | | `{ allowedMethods, requiredDomain, instanceOverrides: [{ instanceId, requiredMethods }] }`. Empty `allowedMethods` means every method; `instanceOverrides` lists the instances whose own policy narrows the org's (D23). `PUT /policy` takes `{ allowedMethods, requiredDomain, confirmName? }` and answers with the lock-out responses below |
| `GET /sso` | tenant admin | | `{ providers: [{ id, providerId, type, issuer, domain, createdAt, status, redirectUrl, metadataUrl? }] }`. `type` is `oidc` or `saml`; `status` is `active` or `domain_unverified`; `createdAt` is null for providers registered before migration 0014. `redirectUrl` is the OIDC redirect URI, or for SAML the assertion consumer service URL; `metadataUrl` (SAML only) is the service provider metadata. Client secrets, certificates and endpoints are never returned |
| `POST /sso` | tenant admin | `{ type: 'oidc' or 'saml', domainId, providerId?, issuer, config }`, shapes below | `201 { id, providerId, redirectUrl, metadataUrl? }`. A given `providerId` must match `^sso-[a-z0-9-]{3,40}$`; without one the server makes `sso-<8 hex>`. 409 `provider_id_taken` when any provider or any account already uses the id; 409 `domain_not_verified`; 409 `sso_provider_limit`. IdP settings that are refused answer `400 { error, reason?, detail? }` (`detail` is a sentence for the admin, `reason` the underlying check): `invalid_body` (unknown or malformed fields), `idp_url_not_allowed`, `idp_url_off_issuer`, `endpoints_required`, `discovery_failed` (`reason` e.g. `discovery_not_found`, `discovery_timeout`, `discovery_incomplete`, `oidc_endpoint_redirect`, `unsupported_token_auth_method`), `issuer_mismatch`, `entity_id_required`, `sso_url_required`, `cert_required`, `invalid_certificate`, `invalid_idp_config` (anything else the SSO plugin refuses) |
| `DELETE /sso/:id` | tenant admin, MFA | optional `{ confirmName }` | Lock-out responses below. Removes the provider, the accounts linked through it for this org's members, and every SSO session of the org. 404 `not_found`; 409 `provider_id_reserved` (a provider registered before ids were checked, whose id belongs to a built-in method; support handles those) |

`POST /sso` config shapes. Unknown fields are refused (`invalid_body`), so nothing else reaches
the SSO plugin. URLs must be `https` on a public host that isn't ours (`idp_url_not_allowed`);
under wrangler dev a loopback IdP over `http` is accepted too.

- **OIDC** (`issuer`: the IdP's issuer URL, which the id token's `iss` must equal):
  `{ clientId, clientSecret, discoveryEndpoint?, skipDiscovery?, authorizationEndpoint?,
  tokenEndpoint?, jwksEndpoint?, userInfoEndpoint?, tokenEndpointAuthentication?
  ('client_secret_basic' | 'client_secret_post'), scopes?, pkce?, mapping?: { email, name, image? } }`.
  By default the server fetches `discoveryEndpoint` (or `<issuer>/.well-known/openid-configuration`),
  checks its `issuer` and required fields and that every endpoint in it is an allowed URL, and
  stores the endpoints; endpoints given by hand win over discovered ones and must be on the issuer's
  site (`idp_url_off_issuer`). With `skipDiscovery: true` nothing is fetched and
  `authorizationEndpoint`, `tokenEndpoint` and `jwksEndpoint` are required (`endpoints_required`).
  `scopes` defaults to `openid email profile`, `pkce` to true, the client authentication to what
  the discovery document offers (basic before post; an IdP offering only `private_key_jwt` is
  refused).
- **SAML** (`issuer`: the IdP's entity id, an opaque URI that is never fetched, so `http://www.okta.com/exk…`
  and `urn:…` are fine; optional with metadata XML. Only the sign-on URL must be an allowed URL):
  `{ idpMetadata?: { metadata? | entityID?, singleSignOnService?: [{ Binding, Location }], cert? },
  entryPoint?, cert?, audience?, identifierFormat?, wantAssertionsSigned?, mapping?: { email, name,
  firstName?, lastName? } }`. Either `idpMetadata.metadata` (the IdP metadata XML, at most 100 kB;
  the entity id, certificate and HTTP-Redirect sign-on URL come from it, and a given `issuer` must
  equal its entity id: `issuer_mismatch`), or by hand the entity id (`idpMetadata.entityID`, else
  `issuer`), an HTTP-Redirect sign-on URL (`entryPoint`, or a `singleSignOnService` entry with that
  binding) and the PEM signing certificate (`cert` or `idpMetadata.cert`; an array for rotation).
  The service provider's entity id is the SP metadata URL
  (`/api/auth/sso/saml2/sp/metadata?providerId=…`), which is also the audience the IdP must send
  unless `audience` says otherwise.

Lock-out responses (D31) are shared by `PUT /policy`, `PUT /instances/:id/policy` and
`DELETE /sso/:id`. When the change would lock no one out, it is applied and the answer is
`200 { ok: true }`. Otherwise, in this order:

| Status | Body | When |
|---|---|---|
| 409 | `{ error: 'lock_out_confirmation_required', affected }` | no `confirmName` in the request |
| 422 | `{ error: 'confirm_name_mismatch', affected }` | `confirmName` isn't the expected name: the org name for the org policy, the instance name for an instance policy, the provider's `providerId` for SSO deletion |
| 403 | `{ error: 'mfa_required', affected }` | the session isn't MFA |
| 202 | `{ status: 'confirmation_sent', confirmationId, expiresAt, affected }` | the emailed confirmation (D30) was started; the change is applied when it is confirmed |

`affected` is a list of `{ id, name, email, reasons, instanceIds }`; `reasons` holds `domain`,
`method` or `signed_out`, and `instanceIds` the instances they lose. `DELETE /sso/:id` adds
`policyDependence` to all four bodies: a list of `org_policy_sso_only`,
`instance_policy_requires_sso` and `required_domain_served_by_sso`, filled when the policies depend
on that provider even if nobody is affected today. `PUT /instances/:id/policy` also answers 400
`not_narrowing` when the instance requires a method the org policy doesn't allow.

### Instances: `/api/orgs/:orgId/instances...` (`instances/routes.ts`)

| Route | Access | Request | Response |
|---|---|---|---|
| `GET /instances`, `GET /instances/:id` | member; tenant users see only instances their teams grant | | The instance view: `id, orgId, name, status, health, healthSince, version, availableVersion, upgradingTo, host, keyHost, url, keyUrl, teamIds, teams: [{ id, name }], lastHeartbeatAt, pipelines, suspendable, nextScheduledAt, stoppedReason, error, createdAt, op, autoUpdate, autoUpdateFailedVersion, remoteAccess, size, git`. `git` is `{ configured, pending }` (D79; the details at `…/git`). `size` is the compute size `{ id, name, vcpu, memoryMb, maxParallel, maxParallelScripts, pending }` (D78); `pending` as for `remoteAccess`. `remoteAccess` is `{ terminal, actions, pending }`: Worca's terminal and actions (D72); `pending` when the values are saved but not yet applied (they apply on the next start, or the reconfigure failed). `autoUpdate` is `micro`, `minor` or `off` (automatic updates, D26 as amended, D75); `autoUpdateFailedVersion` the version automatic updates skip (rolled back, or downgraded away from), or null. `healthSince` is when `health` last changed (null until it first does). `teams` names the teams that grant access. `op` is the latest operation, `{ kind, phase, phases, startedAt, phaseStartedAt, finishedAt, status }`, or null; `phases` is that kind's `OP_PHASES` list. Tenants never see steps, ids or provider errors |
| `POST /instances` | tenant admin | `{ name, teamId, teamIds?, policy?: { requiredMethods }, size? }` | `201` and the instance view. `teamId` is the team the instance is created in (D71); `teamIds` (older clients) are assigned too. The instance row and its teams are inserted in one batch, before the create operation starts. `policy` is the instance login policy (narrowing only, D23), stored with the instance row. `size`: a compute size the org's tier allows (D78), the tier's default when left out. 400 `team_required` (no team given), `not_narrowing`, `invalid_body`, `size_not_allowed`; 404 `team_not_found` (a team not of this org); 403 `tier_limit` |
| `PATCH /instances/:id` | tenant admin | `{ name }` | `{ ok: true }`. Audited as `instance.renamed` |
| `PUT /instances/:id/teams` | tenant admin | `{ teamIds }` | `{ teamIds, droppedUsers }`: replaces the grants; members who lose access lose their gate sessions (D46). 400 `unknown_team`; 409 `last_team` for an empty list (D71) |
| `GET /instances/:id/versions` | tenant admin | | `{ current, latest, releaseCandidates, versions: [{ version, latest, current, rc, publishedAt, direction }] }`, newest first: the versions the instance may move to (published releases, the latest and its available version; never below `MIN_HOSTED_WORCA_VERSION`, never unpublished; with `releaseCandidates` on for the org, also the candidates of releases not out yet, `rc: true`, D80). `direction` is `upgrade`, `downgrade` or `current` relative to the running version (`upgrade` when that is unknown); `publishedAt` is null for releases with no recorded date |
| `POST /instances/:id/upgrade` | tenant admin | `{ version? }` | `202 { ok: true, status: 'upgrading', version }`; without `version`, the available or latest one (D26). Any listed version, also an older one (a downgrade). Audited as `instance.upgrade_started` with `{ from, to, direction }`. A downgrade records the version left as `autoUpdateFailedVersion`. A release candidate only with release candidates on for the org (403 `release_candidates_off`) and only one listed (D80). 400 `invalid_version`, `unknown_version`; 409 `already_on_version`, `instance_not_running` |
| `PUT /instances/:id/auto-update` | tenant admin | `{ mode: 'micro' \| 'minor' \| 'off' }` | `{ ok: true, autoUpdate }`. Which releases the 5-minute cron installs while the instance is idle: micro ones, micro and minor ones (D75), or none ([Instance lifecycle](instance-lifecycle.md#automatic-updates)). Audited as `instance.auto_update_set` with `{ mode, from }` when it changes. 400 `invalid_body` |
| `POST /instances/:id/remote-access` | tenant admin; MFA to turn one on | `{ terminal: boolean, actions: boolean }` | `{ ok: true, result, remoteAccess: { terminal, actions } }`, always 200. `result`: `applying` (running: values stored, `reconfigure` started: sets `WORCA_TERMINAL_REMOTE` and `WORCA_ACTIONS_REMOTE` on the worca service and restarts Worca), `saved` (suspended or stopped: stored, applied on the next wake or lift), `unchanged`. Audited as `instance.remote_access_set` with `{ from, to }` (and `appliesOnStart` when saved) when the values change (D72). 400 `invalid_body` (unknown keys too); 403 `mfa_required` (turning one on without an MFA session), `forbidden`; 409 `instance_busy` (creating, upgrading, deleting, or another operation under way), `remote_access_changed` (someone changed the values since they were read: every write is compare-and-set on them, so a stale read can't skip the MFA check) |
| `POST /instances/:id/size` | tenant admin | `{ size }` | `{ ok: true, result, size }`, always 200. D78: moves the instance to a compute size its org's tier allows (its current size is always accepted, also when the tier no longer includes it). `result` as for remote access: `applying` (running: stored with `cpu`/`memory_mb`, `size_pending` set, `reconfigure` started: the Worca service's limits and `WORCA_MAX_PARALLEL*`, then a Worca restart), `saved` (suspended or stopped: applied on the next wake or lift), `unchanged`. Audited as `instance.size_set` with `{ from, to }` (and `appliesOnStart` when saved). 400 `size_not_allowed`, `invalid_body`; 409 `instance_busy`, `size_changed` |
| `GET /instances/:id/egress` | member; tenant users only for instances their teams grant | | `{ effective, inherited, override, org: { policy, version }, version, pending, platformHosts: [{ host, why }] }`. A policy is `{ mode: 'open' \| 'block' \| 'allow', allow: [host], deny: [host] }` (lists a mode doesn't use are empty). `inherited`: no override, the org's policy applies; `version` is the instance's egress version to send back; `pending`: not yet confirmed applied on the worca service (D73) |
| `PUT /instances/:id/egress` | tenant admin; MFA to loosen | `{ policy: <policy> \| null, version }` | `{ ok: true, result }`, always 200. `null` removes the override (the org's policy applies again). `result`: `applying` (running: stored, `reconfigure` started), `saved` (suspended or stopped: applied on the next wake or lift), `stored` (the effective policy doesn't change, e.g. an override equal to the org's: nothing restarts), `unchanged` (the same override; the same one still pending on a running instance is applied again instead). Audited as `instance.egress_set` / `instance.egress_reset` with `{ from, to }` (policies; null = the org's). 400 `invalid_body` and the policy refusals below; 403 `mfa_required` (the effective policy would loosen, see below); 409 `egress_changed` (the instance's egress version, or the org policy the decision used, moved), `instance_busy` |
| `GET /instances/:id/git` | member; tenant users only for instances their teams grant | | Tenant admins: `{ github, azure, bitbucket, identity, cloneAllow, pushAs, signIn, configured, version, pending }` (D79), never a secret. `github` is `{ kind: 'app', appId, installationId, appSlug, appName, clientId, signIn, setAt }`, `{ kind: 'token', login, last4, setAt }` or null; `azure` `{ last4, setAt }`; `bitbucket` `{ kind: 'access-token' \| 'api-token', email, last4, setAt }`; `pushAs` `instance`, `prefer` or `required`. Tenant users: `{ pushAs, github: { kind } \| null, signIn, configured }` |
| `PUT /instances/:id/git` | tenant admin; MFA to add or replace a credential or the client secret, or to change the clone allowlist | `{ version, github?, azure?, bitbucket?, identity?, cloneAllow?, pushAs? }`: `github` `{ kind: 'app', appId, privateKey?, installationId?, signIn?: { clientSecret? } \| null }` or `{ kind: 'token', token? }` or null; `azure` `{ token? }` or null; `bitbucket` `{ token?, email? }` or null. A field left out keeps what is stored; a secret left out keeps the stored one of the same kind | `{ ok: true, result, git }`, always 200; `git` as the admin GET. `result` as remote access: `applying`, `saved`, `unchanged`. A new GitHub App or token is checked against GitHub first. Audited as `instance.git_updated` with `{ changes }` (kinds, App ID, login, clone list, push mode: never a secret). 400 `invalid_body` and `{ error, field, entry? }`: `git_secret_required`, `git_app_id_invalid`, `git_private_key_invalid`, `git_installation_invalid`, `git_token_invalid`, `git_email_invalid`, `git_identity_invalid`, `git_clone_allow_invalid`; 422 `{ error, field }` from GitHub: `git_app_rejected`, `git_installation_not_found`, `git_app_not_installed`, `git_token_rejected`, `git_private_key_invalid`; 502 `git_check_failed` (GitHub didn't answer); 403 `mfa_required`; 409 `git_changed`, `instance_busy` |
| `POST /instances/:id/delete` | tenant admin, MFA | `{ confirmName }` (`{ name }` is still accepted) | `202 { status: 'confirmation_sent', confirmationId, expiresAt }`, like `DELETE /api/orgs/:orgId`: the instance is deleted when the emailed link is confirmed (D30). Allowed while stopped (D60). 403 `mfa_required`; 422 `confirm_name_mismatch`; 409 `already_deleting` |

### Outbound network policy: `/api/orgs/:orgId/egress` (`instances/routes.ts`, D73)

| Route | Access | Request | Response |
|---|---|---|---|
| `GET /egress` | tenant admin | | `{ policy, version, platformHosts: [{ host, why }], instances: { inheriting, inheritingRunning, overriding }, overrides: [{ instanceId, mode }] }`. Open with empty lists, version 0, until first changed |
| `PUT /egress` | tenant admin; MFA to loosen | `{ policy: { mode, allow?, deny? }, version }` | `{ ok: true, result: 'saved' \| 'unchanged', version, applying, applyingIds, pending, policy }` (the normalized policy). In one transaction, every instance that follows the org's policy is marked pending and the running ones with nothing under way are claimed for a `reconfigure` (`applyingIds`); the others get it on their next start (`pending`); instances with an override are untouched. Audited as `org.egress_updated` with `{ from, to, applying, pending }`. 409 `egress_changed` when `version` isn't the current one |

Entries are hostnames, normalized on the server (trimmed, lowercase, trailing dot dropped,
internationalized names as punycode, duplicates dropped): `example.com` is that host,
`*.example.com` any subdomain (not the apex). Refusals are 400 `{ error, field: 'allow' | 'deny',
entry?, reason? }`: `egress_host_invalid` (`reason`: `scheme`, `path`, `port`, `ip`, `wildcard`,
`no_dot`, `label`, `length`, `chars`, `empty`), `egress_too_many` (over 200 in a list),
`egress_blocks_platform_host` (a block entry matching one of the platform's own hosts).

**Loosening** (`egress.ts isLoosening`) is any change that could let through a host that was not
let through before, computed over the effective policy (instance) or the org policy (org): to
`open` from anything that blocked something; from `allow` to `block` or `open`; in `block` a block
entry removed or narrowed; to `allow` an allow entry that reaches beyond the old allowlist, or
reaches a host the old blocklist blocked and the new one doesn't (an allow entry added, a block
entry removed or narrowed); removing an override that was stricter than the org's policy.
Allowing one of the platform's own hosts is never loosening. Tightening needs no MFA.

### Platform console: `/api/platform/...`

`limit` (1 to 500, default 100) and `offset` page the lists.

| Route | Cap | Request | Response |
|---|---|---|---|
| `GET /orgs` | `platform.view` | | `{ orgs: [{ id, name, tier, status, createdAt, members, instances }] }`; `name` is decrypted (D61), null when the org key is destroyed |
| `GET /orgs/:orgId` | `platform.view` | | `{ id, name, tier, tierName, instanceLimit, memberLimit, tierSizes, releaseCandidates (D80), status, createdAt, members, firstAdmin, admins: [{ userId, email, since }], instances: [{ id, name, status, version, availableVersion, health, lastHeartbeatAt, stoppedForAbuse, createdAt, size, aboveTier }], egress }`. `aboveTier` (1/0): the instance runs on a compute size the org's tier no longer includes (D78). `egress` is the org's outbound network policy (D73, read-only), null when it can't be read. `admins` is longest-standing first; `firstAdmin` is the first of them. 404 `not_found` |
| `PUT /orgs/:orgId/release-candidates` | `tenants.manage` | `{ enabled: boolean }` | `{ ok: true, enabled, changed }`. D80: the org's tenant admins may pin instances to release candidates. Turning it off moves nothing. Audited `org.release_candidates_set` in the platform and the org log. 404 `not_found` |
| `GET /stats` | `platform.view` | | `{ orgs: { total, createdLast7Days }, users: { total, active, pending, disabled }, instances: { byStatus, silent, degraded, stuckCreating, byVersion }, waitlist, openRegistrationCodes, accessRequestsPending, thresholds: { silentAfterMs, stuckCreatingAfterMs }, capacity: { services, cap } }`. `capacity`: Railway services in use (three per instance row) and the workspace's cap (100, D78) |
| `GET /instances` | `platform.view` | query `orgId` | `{ instances: [{ id, orgId, name, status, version, availableVersion, health, lastHeartbeatAt, stoppedForAbuse, createdAt, size, aboveTier, pipelines }] }` |
| `GET /instances/:id` | `platform.view` | | The list entry plus `orgName`, `region`, `cpu`, `memoryMb`, `volumeGb`, `computeRef: { projectId, environmentId, services: { <name>: { serviceId, deploymentId } } }`, `edgeRef: { tunnelId, dnsRecordIds }` (ids only, never secrets), `gate` (the gate object's state), `providers`, `stoppedReason` (the staff-written abuse reason, or null), `healthSince`, `op`, `autoUpdate` (`micro`, `minor` or `off`), `autoUpdateFailedVersion`, `secretsRotatedAt` (when its credentials were last renewed, D74; null if never), `pendingOp`, `remoteAccess` (`{ terminal, actions, pending }`, read-only: only tenant admins change it, D72), `computeSize` (the size as in the tenant view, with `pending`, read-only, D78) and `egress` (`{ effective, inherited, pending }`, read-only, D73; null when it can't be read). `providers` is `providerStatusFor`: `{ checkedAt, tunnel, tunnelCheckedAt, services, servicesCheckedAt, errors }` from the 5-minute poll's cache, or null. `op` is the latest operation as one `GET /ops` entry (with `phases`, that kind's `OP_PHASES` list), or null |
| `GET /ops` | `platform.view` | query `state` (`stuck` default, `failed`, `running`), `limit` | `{ state, ops: [{ opId, instanceId, orgId, kind, workflowId, status, phase, phases, step, phaseStartedAt, inPhaseMs, attempts, lastError, outcome, startedAt, updatedAt, finishedAt, stuck }] }`. Ids, kinds, phases and errors only, no tenant names. A running operation is `stuck` when it has sat in one phase 15 minutes or retried a step 3 times. 400 `invalid_state` |
| `POST /ops/:opId/restart` | `instances.stop` | | `202 { ok: true, opId, status: 'running' }`. Restarts the whole operation; finished steps return their cached results. 404 `not_found`; 409 `op_finished` or `no_workflow`. Audited in both logs as `instance.op_restarted` |
| `POST /instances/:id/rotate` | `instances.rotate` | | `{ ok: true }`. Renews the instance's tunnel token, broker secret and heartbeat credential (D74, [Instance lifecycle](instance-lifecycle.md#rotate)): running, suspended or stopped with nothing under way, else 409 `instance_busy`; 404 `not_found`. Audited in both logs as `instance.rotate_started` |
| `POST /instances/rotate` | `instances.rotate` | `{ confirm: 'all instances' }` | `{ started: [id], skipped: [{ id, status, pendingOp }] }`. Starts a rotation of every instance that can be rotated now, spread over up to 10 minutes; the others are listed. 400 `confirm_name_mismatch`. Audited as `instance.rotate_started` per instance and `instances.rotate_all_started` with the counts |
| `GET /worca-version` | `platform.view` | | `{ version }`, the latest release |
| `PUT /worca-version` | `system.settings` | `{ version: 'x.y.z' }` | `{ ok: true, version, instancesNotified }`. Publishes by hand; stable npm releases are enrolled without it (D77). Checks the image on GHCR (anonymous pull token, the manifest, its linux/amd64 entry, the config's `org.opencontainers.image.version` label): 422 `image_not_found`; 422 `{ error: 'image_version_mismatch', reports }` when the label names another version (an upgrade to it could never finish) or none; 409 `release_withdrawn` (restore it instead); 502 `registry_unavailable` when GHCR can't be asked. The check is skipped only when both `LOCAL_DEV=1` and `RELEASE_IMAGE_CHECK=off`, which `scripts/dev.mjs` sets because the local stack deploys the stub, not images. Records the release in `worca_releases`; nobody is upgraded (D26). Every instance on another version is offered it as `availableVersion` (`instancesNotified` counts the newly offered ones); instances already on it have their offer cleared |
| `GET /releases` | `platform.view` | | `{ latest, releases: [{ version, publishedAt, publishedBy, source, instances, latest, deployable, rc, withdrawn }], held: [{ version, reason, reports, firstSeenAt, checkedAt }], settings: { autoEnroll, soakHours } }`, newest version first; `instances` counts instances running it; `publishedAt` is null for versions never recorded (the built-in default, releases from before migration 0008); `source` is `manual`, `npm`, or null for a version only seen on instances; `withdrawn` is `{ at, by, reason }` or null (D77). `held`: npm versions automatic enrollment holds back (`image_missing`, `registry_unavailable`, `label_mismatch` with the version the image `reports`) |
| `POST /releases/:version/withdraw` | `system.settings` | `{ reason }` (1 to 500 characters) | `{ ok: true, latest, instances, orgsNotified }`. D77: the release can't be deployed any more and is never enrolled again; when it was the latest, the newest release left becomes the latest. Instances on it keep running; each org with any gets one mail to its admins with the reason. 404 `release_not_found`, 409 `already_withdrawn`, 409 `last_release` (no deployable release would be left). Audited `platform.release_withdrawn` (counts only; the reason stays on the release) |
| `POST /releases/:version/restore` | `system.settings` | | `{ ok: true, latest }`. Undoes a withdrawal; the latest again when it is the newest. 404 `release_not_found`, 409 `not_withdrawn`. Audited `platform.release_restored` |
| `PUT /release-settings` | `system.settings` | `{ autoEnroll: boolean, soakHours: 0..720 }` | `{ ok: true, settings }`. D77: automatic enrollment on or off; how long automatic updates wait after a release is enrolled. Audited `platform.release_settings_set` |
| `GET /tiers` | `platform.view` | | `{ tiers: [{ id, name, instances_per_org, members, volume_gb, vcpu, memory_mb, sizes, default_size, orgs }], computeSizes: [<size>], defaultTier }`; `orgs` counts orgs on the tier, `defaultTier` is the tier new orgs start on (D78) |
| `POST /tiers` | `system.settings` | `{ id, name, instancesPerOrg (1–100), members (1–1000), volumeGb (1–1000), sizes: [size id], defaultSize }` | `201 { ok: true, id }`. The id (`^[a-z][a-z0-9-]{1,39}$`) is permanent. 400 `invalid_body` (also a default not among the sizes), 409 `tier_exists`. Audited `platform.tier_created` |
| `PUT /tiers/:id` | `system.settings` | the same without `id` | `{ ok: true }`. Applies to every org on it at once; nothing running is stopped or resized. 404 `not_found`. Audited `platform.tier_updated` with the old and new limits |
| `DELETE /tiers/:id` | `system.settings` | | `{ ok: true }`. 409 `tier_in_use` while an org is on it, it is the default tier, or an open registration code offers it; 404 `not_found`. Audited `platform.tier_deleted` |
| `GET /registration/codes` | `registration.codes` | | `{ codes: [{ id, createdBy, tier, usesLeft, usesTotal, note, expiresAt, createdAt }] }`; `note` is decrypted with the creator's key, null once that account is deleted |
| `POST /registration/codes` | `registration.codes` | `{ tier = 'free', uses = 1 (1 to 1000), expiresInDays = 30 (1 to 365, or null), note? (up to 200 characters) }` | `201 { code, id, tier, usesLeft, usesTotal, note, expiresAt }`; the code is shown once. The note never enters the platform log |
| `GET /waitlist` | `waitlist.manage` | | `{ pending: [{ id, createdAt, emailVerified, name, email }] }`, oldest first, up to 500. Name and address are decrypted per person so approvers know whom they let in; each listing is audited as `platform.waitlist_viewed` with the count only |
| `POST /waitlist/:userId/approve` | `waitlist.manage` | | `{ ok: true }`. Goes through `approveWaitlistedUser`, so `registeredVia` becomes `approved`; 404 `not_found` when the user isn't pending |
| `GET /access-requests` | `access_requests.manage` | query `status` (`pending` default, oldest first; `all`: every confirmed request, newest first) | `{ status, requests: [{ id, email, useCase, company, source, status, createdAt, confirmedAt, decidedAt, decidedBy, joinedAt, removed }], counts: { byStatus, requested, confirmed, granted, joined, withInstance } }`, up to 500; unconfirmed requests are only counted. `removed` rows had their personal data deleted by retention (email, useCase and company are null) and appear only under `all`. Audited as `platform.access_requests_viewed` with the count only (D69) |
| `POST /access-requests/:id/grant` | `access_requests.manage` | `{ tier = 'free', expiresInDays = 14 (1 to 365), message? (up to 2000) }` | `{ ok: true, code, codeId, expiresAt, mailed }`. Creates a single-use code like `POST /registration/codes`, bound to the requester's address, and mails it with a link to `/sign-in#code=<code>`; `code` is returned so it can be passed on by hand when `mailed` is false. 404 `not_found`, 409 `not_pending`, 400 `unknown_tier`. Audited as `platform.code_created` and `platform.access_request_granted` |
| `POST /access-requests/:id/decline` | `access_requests.manage` | `{ notify = true, message? (up to 2000) }` | `{ ok: true, mailed }`; mails a short note when `notify`. 404 `not_found`, 409 `not_pending`. Audited as `platform.access_request_declined` |
| `GET /roles` | `roles.manage` | | `{ bindings: [{ userId, role, grantedBy, grantedAt, name, email }] }`; name and address decrypted per person |
| `GET /keys` | `platform.view` | | `{ wrapped: { org: [{ version, masterId, count }], user: [...] }, destroyed: { org, user }, formKeys: { accessRequests, newsletter }, master, lastOrgKeyRotationAt }`. `masterId` is the fingerprint of the master key that wrapped those rows, null before migration 0011. `master` is `MasterKeyStatus`. `user` counts account keys only: keys of access requests (`ar_` ids, D69) and newsletter subscribers (`nl_`, D70) are counted live in `formKeys`; they are deleted with their data, never left destroyed |
| `GET /keys/master` | `keys.master` | | `{ masterId, previousMasterId, total, done, status }`: live data keys, how many sit under the current master key, `done` or `pending` |
| `POST /keys/rotate-master` | `keys.master` | optional `{ limit }` | `{ masterId, previousMasterId, total, done, status, rewrapped, failed }`. Re-wraps up to `limit` (at most 1000, default 1000) data keys per call; call again until `status` is `done`. Runbook in [Security](security.md#rotating-the-master-key) |
| `GET /audit` | `audit.view` | query `before`, `limit`, `actorId`, `action`, `category` | `{ entries: [{ id, at, actorId, actorRole, action, category, targetType, targetId, details }], lostWritesToday }` |
| `GET /system/mail` | `platform.view` | | `{ today: { day, total, byKind }, monthToDate, last14Days: [{ day, total }], quotaHeaders, limits }`: our own send counts per UTC day (`mail_daily`) plus Resend's quota headers from the last send, when present; `limits` is the Resend free plan (100 a day, 3,000 a month) |
| `GET /system/providers` | `platform.view` | | `{ fake, checkedAt, railway, cloudflare: { tunnels, dnsRecords }, turnstile: { configured }, cached }`. Each probe is `{ ok: true, latencyMs, ... }` or `{ ok: false, latencyMs, error }`; latency is the wall time of our own call. Cached in KV for 10 minutes (1 minute after a failed probe). `fake` is true when both providers are fake or `LOCAL_DEV=1` |

Audit filters (both logs): `before` (a time; only older entries), `limit` (1 to 500, default 100),
`actorId`, `action` (a prefix such as `instance.` or an exact action; characters `a-z`, `_` and
`.`) and `category` (`instances`, `members`, `security`, `settings`; every action belongs to exactly
one, unknown ones to `settings`). Anything else is 400 `invalid_query`. Filters use only plaintext
columns. CSV export is built in the browser.

Reading org names, instance names and staff names is not audited (D61).

#### Users and support (`tenancy/support-routes.ts`)

All need cap `users.support` (admin, superadmin). Staff can't act on someone holding a stronger
platform role than their own: 403 `target_outranks_you`.

| Route | Request | Response |
|---|---|---|
| `GET /users?email=` | exact address only | `{ id, name, email, status, createdAt, registeredVia, signupTier, registrationCodeId, orgs: [{ id, name, role, joinedAt }], signInMethods: { passkeys, providers }, platformRoles, lastSignIn: { at, method } or null, activeSessions }`. 400 `exact_email_required`; 404 `user_not_found`. Every lookup is audited as `support.user_looked_up`, misses included, never with the address. `lastSignIn` comes from live sessions or the `auth.signed_in` audit entries |
| `POST /users/:id/sign-out` | | `{ ok: true, sessionsEnded }` |
| `POST /users/:id/disable` | | `{ ok: true, sessionsEnded }`. Sets `status` to `disabled` and ends every session and gate session at once (`endAllSessions`). 403 `cannot_disable_self`; 409 `user_pending`; 409 `last_superadmin` when no other active superadmin would remain |
| `POST /users/:id/enable` | | `{ ok: true }`; 409 `not_disabled` |
| `POST /users/:id/reset-signin` | `{ reason }` (1 to 1000 characters) | `201 { id, kind: 'signin_reset', userId, expiresAt }`: a request that expires after 24 hours. 403 `cannot_reset_self`; 409 `request_already_open` |
| `GET /support-requests` | | `{ requests: [{ id, kind, userId, requestedBy, reason, createdAt, expiresAt, email, name, canApprove }] }`, open and unexpired. `canApprove` is false for the requester and for the target. Audited as `support.requests_viewed` |
| `POST /support-requests/:id/approve` | | `{ ok: true, passkeys, sessions }`: the counts removed. Needs a session signed in with a passkey (403 `passkey_required`). 403 `second_person_required` (the requester) or `cannot_approve_own_reset`; 404 `not_found`; 409 `not_open` or `requester_not_staff`; 410 `expired`. Approving executes: it deletes every passkey and session of the user, drops their gate sessions and mails them |

### Access requests: `/api/public/access-requests` (`public/access-requests.ts`)

No session. CORS for `PUBLIC_FORM_ORIGINS`, whose origins also pass the Origin check here only (D69).

| Route | Body | Answer |
|---|---|---|
| `POST /api/public/access-requests` | `{ email, useCase (1 to 2000), company? (up to 200), source? (up to 100) }`; `x-turnstile-token` when Turnstile is on | Always `202 { ok: true }` for valid input; 400 `invalid_input` otherwise. Rate limit 5 an hour per IP |
| `POST /api/public/access-requests/confirm` | `{ token }`, posted by the page `/access-request` from its URL fragment | `{ ok: true, status: 'confirmed' \| 'already_confirmed' }`; 410 `invalid_token` (unknown, replaced or expired). Rate limit 20 an hour per IP |

### Webhook: `POST /api/webhooks/resend` (`system/resend-webhook.ts`)

Resend's delivery events, signed with Svix. No session; the signature is the authentication.

- 404 `not_found` when `RESEND_WEBHOOK_SECRET` isn't set; 413 `too_large` over 256 KB; 401
  `invalid_signature` when the `svix-id`, `svix-timestamp` and `svix-signature` headers are
  missing, more than 5 minutes off, or don't verify; 400 `invalid_body`.
- Event types `sent`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed` and `suppressed`
  (Resend prefixes them `email.`) update `mail_messages.last_event` for the matching Resend email
  id, unless the stored event is newer. Other types and unknown ids are acknowledged with
  `{ ok: true, applied: false }`. Nothing from the payload is stored except the email id, the
  event and its time; recipient addresses are dropped.
- `bounced` and `complained` on a mail recorded under `newsletter:<subscriber id>:...` also set
  that subscriber's status to `suppressed` (D70).

### Newsletter

Public, no session, under `/api/public/newsletter` (`public/newsletter.ts`; CORS for
`PUBLIC_FORM_ORIGINS`). Bodies are JSON; a malformed one is 400 `invalid_input`. Tokens: the
confirm token is random (stored as SHA-256, single use, 7 days); the manage token is
`<subscriber id>.<token_version>.<base64url HMAC-SHA256>` with a key derived from
`BETTER_AUTH_SECRET` by HKDF-SHA256 (info `worca-run newsletter manage-token v1`), never expires,
and stops working when `token_version` moves on. A bad or revoked token is 410 `invalid_token`.

| Request | Body | Answer |
|---|---|---|
| `POST /subscribe` | `{ email, releases: 'none'\|'major'\|'minor'\|'micro'\|'rc', product: boolean, source? }` (not `none` + `false`) | Always 202 `{ ok: true }`. New, unconfirmed or unsubscribed: a confirmation mail (at most 3 an hour per address). Active: the manage link, at most once an hour. Suppressed: nothing. Rate limited per IP; Turnstile when configured |
| `POST /confirm` | `{ token }` (confirm token) | `{ ok: true, token }` (a manage token); the subscriber is active |
| `POST /prefs` | `{ token }` | `{ email (masked), status, releases, product }` |
| `POST /prefs/update` | `{ token, releases, product }` | The same; also subscribes an unsubscribed (not revoked) subscriber again. 409 `suppressed` |
| `POST /unsubscribe-all` | `{ token }` | `{ ok: true, status }`; bumps `token_version`, so every earlier link dies |
| `POST /link` | `{ email }` | Always 202: active subscribers get their manage link, once an hour. Rate limited; Turnstile |
| `POST /unsubscribe?t=<manage token>` | anything (RFC 8058 sends `List-Unsubscribe=One-Click`, form-encoded, no Origin) | 200 `{ ok: true }`, idempotent |
| `GET /unsubscribe?t=` | | 302 to `/newsletter#t=...&u=1`; changes nothing |

`GET /newsletter` is the page the mails link to (`#c=` confirm, `#t=` manage, `&u=1` opens the
unsubscribe step); its script (`/newsletter/page.js`) makes the POSTs above. Nothing happens on GET.

Signed in: `GET /api/me/newsletter` → `{ subscribed, status, releases, product }` for the account
address; `PUT /api/me/newsletter` `{ releases, product }` subscribes at once (no double opt-in,
source `account`), changes, or with `none` + `false` unsubscribes. Console:
`GET /api/platform/newsletter` (`newsletter.view`: admin, superadmin) →
`{ subscribers: { total, byStatus, active: { releases, product } }, issues: [last 20] }`, counts only.

Release hook: `POST /api/hooks/release` (`newsletter/hooks.ts`), see
[Development](development.md#newsletter) for the signature. A prerelease is `rc`; a stable
version is compared with the highest stable version announced before it (`major`, `minor`, else
`micro`); the first one is `major` when it is `x.0.0`, else `minor`. Recipients: active
subscribers whose threshold includes the level (`rc` reaches only `rc`; `major` everyone but
`none`). The `NewsletterSendWorkflow` sends one Resend batch (`POST /emails/batch`, at most 100,
with an idempotency key) per step, each mail with its own manage link and `List-Unsubscribe` /
`List-Unsubscribe-Post` headers, from `NEWSLETTER_FROM`. Before each batch it checks the day's and
month's mail counts against `RESEND_PLAN`, keeping 30 for transactional mail, and sleeps until the
next UTC day when nothing is left.

## Stub instance server (`stub/instance.mjs`)

One process stands in for any number of instances. Port `STUB_PORT` (default 9100).

| Request | Purpose |
|---|---|
| `POST /__admin/instances` `{ instanceId, host, keyHost }` | create (state `created`) |
| `POST /__admin/instances/:id/variables` `{ variables }` | `InstanceVariables` |
| `POST /__admin/instances/:id/deploy` `{ image }` | start serving and heartbeating; state `running` |
| `POST /__admin/instances/:id/stop`, `/start` | state `stopped` / `running` |
| `DELETE /__admin/instances/:id` | gone |
| `GET /__admin/instances/:id` | `{ state, variables, beats }` |
| `POST /__admin/instances/:id/state` `{ pipelines?, nextScheduledAt?, suspendable?, health? }` | what the next heartbeats report |
| any other request | instance traffic, routed by `x-forwarded-host` (falls back to `Host`) |

Instance traffic: requires a valid identity token in `x-worca-identity` (ES256, from
`${APP_ORIGIN}/.well-known/jwks.json`, audience = host, issuer = APP_ORIGIN); answers 401
without one. A running instance echoes `{ host, method, path, identity, cookies, headers }` as
JSON, accepts WebSockets at `/ws` (echo, closed when the token used at the upgrade expires, W7),
and posts a heartbeat every `STUB_HEARTBEAT_SECONDS` (default 5) to `variables.heartbeatUrl`
with `Authorization: Bearer <heartbeatCredential>`. A stopped instance answers 502.

In local development the gate forwards to `HostEntry.upstream` (`http://127.0.0.1:9100`) and
sets `x-forwarded-host` to the instance host.

## Shared tables

```sql
-- 0003_platform.sql (tenancy)
platform_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
  -- keys: registration_mode ('invite_code' default), default_tier ('free')
registration_codes(code_hash TEXT PRIMARY KEY, created_by TEXT, tier TEXT NOT NULL,
  uses_left INTEGER NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL,
  note TEXT, uses_total INTEGER)  -- note: encrypted, user key of created_by (0008)
platform_roles(user_id TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT, granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role))
tiers(id TEXT PRIMARY KEY, name TEXT NOT NULL, instances_per_org INTEGER NOT NULL, vcpu REAL NOT NULL,
  memory_mb INTEGER NOT NULL, volume_gb INTEGER NOT NULL, members INTEGER NOT NULL,
  sizes TEXT NOT NULL DEFAULT '["standard"]', default_size TEXT NOT NULL DEFAULT 'standard')  -- sizes, default_size: 0028 (D78)
  -- seeded: ('free', 'Free', 1, 2, 4096, 10, 10)  (D33); 'team' (5, 25) and 'business' (10, 50) in 0028
org_settings(org_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL)

-- 0005_instances.sql (instances)
instances(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, key_slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, status TEXT NOT NULL, worca_version TEXT, available_version TEXT,
  compute_ref TEXT, edge_ref TEXT, cpu REAL, memory_mb INTEGER, volume_gb INTEGER,
  stopped_reason TEXT, stopped_by TEXT, heartbeat_cred_hash TEXT UNIQUE, health TEXT,
  last_heartbeat_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  health_since INTEGER)  -- health_since: 0010 (when `health` last changed)
instance_teams(instance_id TEXT NOT NULL, team_id TEXT NOT NULL, role TEXT, PRIMARY KEY (instance_id, team_id))

-- 0008_platform.sql
worca_releases(version TEXT PRIMARY KEY, published_at INTEGER, published_by TEXT)
  -- 0027: source TEXT NOT NULL DEFAULT 'manual', withdrawn_at INTEGER, withdrawn_by TEXT, withdrawn_reason TEXT
-- 0027_release_enrollment.sql (D77)
release_holds(version TEXT PRIMARY KEY, reason TEXT NOT NULL, detail TEXT, first_seen_at INTEGER NOT NULL, checked_at INTEGER NOT NULL)

-- 0009_support.sql (tenancy)
support_requests(id TEXT PRIMARY KEY, kind TEXT NOT NULL,  -- only 'signin_reset'
  user_id TEXT NOT NULL, requested_by TEXT NOT NULL, reason TEXT NOT NULL,  -- reason: encrypted, user key of user_id
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_by TEXT, approved_at INTEGER,
  executed_at INTEGER, status TEXT NOT NULL DEFAULT 'open')  -- open, approved, executed

-- 0010_ops.sql (instances)
instance_ops(op_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, org_id TEXT NOT NULL, kind TEXT NOT NULL,
  workflow_id TEXT, phase TEXT NOT NULL, phase_started_at INTEGER NOT NULL, step TEXT,
  step_running INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
  outcome TEXT, last_error TEXT)

-- 0011_keys.sql (keys)
key_rotation_jobs(org_id TEXT PRIMARY KEY, target_version INTEGER NOT NULL, status TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0, cursor TEXT, done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, passes INTEGER NOT NULL DEFAULT 1, last_error TEXT,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER)

-- 0012_mail.sql (system)
mail_daily(day TEXT, kind TEXT, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind))
mail_messages(email_id TEXT PRIMARY KEY, ref TEXT NOT NULL, kind TEXT NOT NULL, sent_at INTEGER NOT NULL,
  last_event TEXT, last_event_at INTEGER)
```

`instance_ops` rows are written by `instances/progress.ts` only and kept 30 days after they finish
(the daily cron). `data_keys` also gained `master_id`, `rotated_at` and `rotated_by` (0011); see
the [data model](data-model.md).
