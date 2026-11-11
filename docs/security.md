# Security

## Threats this design is built around

- **A malicious or compromised tenant instance.** Agents run arbitrary code, so assume any
  instance can serve whatever it likes on its own hostname.
- **A leaked database export or backup** of the control plane.
- **Platform staff seeing tenant data.** Platform roles get status, never content (D15).
- **Abuse from instances:** mining, spam, attacks or phishing pages hosted on `worca.run`.

Not covered: a compromised control plane Worker or a leaked master key. Either can read
everything; protect them with access control on the Cloudflare account and the key backup rules
(D37).

## Domain isolation

The control plane (`worca.dev`) and the instances (`worca.run`) are different sites (D7), so:

- the control plane's `SameSite=Lax` session cookie is never sent with requests an instance page
  makes, and no instance can set a cookie the control plane reads;
- the sign-in redirect to `app.worca.dev` is a top-level navigation, so the Lax cookie is sent
  and sign-in works.

The control plane's session cookie uses Better Auth's `__Secure-` prefix (Better Auth doesn't
support `__Host-`); it is host-only (no `Domain` attribute), so no other host can set it. The
`Origin` header is checked on every request that changes state (Better Auth's `trustedOrigins`
for its routes, the same check on ours).

## Isolation between instances, until the Public Suffix List

Until `worca.run` is on the Public Suffix List (D12), every `*.worca.run` host is the same site
as every other one. The gate Worker closes the gaps that opens:

| Risk | Severity | What the gate does |
|---|---|---|
| A page on instance A makes the visitor's browser send requests to instance B (start a pipeline, change settings) | High | Rejects every request that changes state, and every WebSocket upgrade, unless `Sec-Fetch-Site: same-origin`; if that header is missing, requires `Origin` to equal the host |
| A sets `Domain=.worca.run` cookies that B receives | Medium | Its own cookies are `__Host-`, so they can't be overwritten. Removes every incoming cookie except `__Host-` ones before forwarding, and never forwards its own. Removes any outgoing `Set-Cookie` that isn't `__Host-` |
| JavaScript on A floods `.worca.run` with cookies, pushing out B's session or making requests too large | Low | Can't be prevented before the PSL listing. Oversized or broken requests get a recovery page that sends `Clear-Site-Data: "cookies"`; the person signs in again |
| A loads B in an invisible frame | Medium | Adds `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| A and B share a browser process (side channels) | Low | Adds `Origin-Agent-Cluster: ?1`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` |
| A pushes the visitor through B's sign-in callback with a planted code | Low | Codes are bound to B's host, single-use, short-lived; the `state` cookie must match |

The same rules protect an instance's key page from that instance's own worca pages, where agent
output is shown.

Also: HSTS with `includeSubDomains` on all of `worca.run`, submitted to the preload list, so nobody
on the visitor's network can plant cookies through a plain-http subdomain.

Keep all gate headers after the PSL listing; only the cookie rows become unnecessary.

### What the gate depends on

- **It is the only way in.** No instance has a public Railway domain; traffic reaches it only
  through its own tunnel. worca refuses requests without a valid identity token, so a request that
  went around the gate gets nothing.
- **It covers every host.** One route `*.worca.run/*`, no other routes on the zone, and every DNS
  record proxied (no grey-cloud records).
- **One tunnel per instance** (D5).
- **The gate object is the source of truth.** Status and sessions live in each instance's Durable
  Object, which is strongly consistent; KV only maps hostnames to ids (D43). Requests that change
  state, WebSocket upgrades and reads that return secrets (worca's
  `/api/models/:id/env-value`) are checked against it every time; other reads are checked when
  their 60-second pass runs out (D44).

### How fast access ends

| Event | Requests that change state | Reads | Open WebSockets |
|---|---|---|---|
| Removed from a team or org, signed out, user disabled | At once | Within 60 s; secrets at once | Within the token's lifetime (W7) |
| Instance stopped for abuse or deleted | At once | Within 60 s, or sooner when the services stop | When the services stop |

### What it does nothing about

Phishing or other abusive content hosted on an instance. That is handled by abuse reports and the
platform's power to stop an instance (D16).

## Application-level encryption

### Keys

```
master key (Workers secret, offline backup split between two superadmins)
   ├── org data key   one per org, stored in D1 encrypted under the master key
   ├── user data key  one per user, stored in D1 encrypted under the master key
   └── form data key  one per access request (`ar_` id) or newsletter subscriber (`nl_` id):
                      owner type `user`, people without an account
blind-index key (Workers secret, separate from the master key)
```

- Users have their own key because one person can belong to several orgs. Destroying a user's key
  on account deletion makes their data unrecoverable (GDPR erasure).
- Destroying an org's key on org deletion makes all of the org's data unrecoverable, including any
  copies left in database backups.
- An access request (D69) has its own key, deleted when retention removes the request or its
  personal data (crypto-shredding), so copies in backups become unreadable too.
- Every key and ciphertext carries a version prefix. Rotating the master key re-encrypts only the
  data keys. Rotating an org's data key (D38) re-encrypts that org's rows in a Workflow.
- Each wrapped data key records which master key wrapped it, as a fingerprint
  (`data_keys.master_id`: `k` and 16 hex characters of an HMAC of a fixed label, keyed with a key
  derived from the master key by HKDF-SHA256, info `worca-run master-id v1`, so the wrapping key is
  never used for anything else). Rows with an older-style fingerprint still unwrap; a master
  rotation run with the same key rewrites them. It identifies the key without revealing it and appears in the platform console's key
  counts. Rows from before the fingerprint existed have none and are tried against `MASTER_KEY`,
  then `MASTER_KEY_PREVIOUS`. Errors and logs name owners, versions and fingerprints, never key
  material.

### Rotating an org's data key

A tenant admin with a passkey session starts it (`POST /api/orgs/:orgId/keys/rotate`, D38). The
call adds version N+1 of the org's key, which every new write uses, and starts a
`KeyRotationWorkflow` that does the rest in three stages: re-encrypt, verify, then destroy.

1. **Re-encrypt.** The job walks a fixed list of every column the org's key encrypts
   (`ORG_COLUMNS` in `keys-jobs.ts`), 200 rows per Workflow step. Each value is decrypted with the
   version it names and encrypted under N+1 with the same additional authenticated data, and written
   only if the row is unchanged since it was read. A value that doesn't decrypt is counted as
   `failed` and left alone.
2. **Verify.** After a 3-minute grace (an isolate may cache the old current version for up to a
   minute and still write under it), the job counts what is left on older versions. If anything is,
   it makes another pass, at most three in all.
3. **Destroy.** Only when nothing is left, and a scan of every table finds no ciphertext in a
   column the list doesn't know, are the older key versions wiped (`wrapped` set to NULL,
   `destroyed_at` set). Otherwise the job ends `incomplete` and keeps the older versions, so
   nothing becomes unreadable; a ciphertext in an unknown column blocks destruction until the column
   is added to the list. The job also ends `incomplete` if the org's key was destroyed meanwhile.

Old rows stay readable the whole time. Progress, the last rotation's time and who started it are in
`GET /api/orgs/:orgId/keys`.

**Rule for developers:** every encrypted column must be listed in `src/control/keys-jobs.ts`, in
`ORG_COLUMNS` (org key) or `OTHER_ENCRYPTED_COLUMNS` (user key); see
[Internal APIs](internal-apis.md#keys-srccontrolkeysts-keys-jobsts-authdatabasets).

### Rotating the master key

A superadmin action (D37, capability `keys.master`, passkey session). It re-wraps every data key
under a new master key; no ciphertext in any table changes. The two routes are
`GET /api/platform/keys/master` (status) and `POST /api/platform/keys/rotate-master`.

1. **Make the new key and back it up first.** A new master key is 32 random bytes in base64, as
   `npm run keys:dev` makes locally (for example `openssl rand -base64 32`). Put it in the offline
   backup held by two superadmins and in `.secrets.prod.env` (D37) before it touches production.
   Keep the old key too.
2. **Set both secrets on the control Worker.** `MASTER_KEY_PREVIOUS` gets the old key, `MASTER_KEY`
   the new one. From then on new data keys are wrapped under the new key, and old rows still
   unwrap because each names its master key (or, for rows without a fingerprint, either is tried).
3. **Check the status.** `GET /api/platform/keys/master` returns `{ masterId, previousMasterId,
   total, done, status }`. `masterId` must be the new key's fingerprint and `previousMasterId` the
   old one's; `status` is `pending` until `done` equals `total`.
4. **Re-wrap.** Call `POST /api/platform/keys/rotate-master` until `status` is `done`. Each call
   re-wraps up to 1000 data keys (`{ "limit": n }` asks for fewer) and returns the status plus
   `rewrapped` and `failed`. A row is updated only if it is unchanged since it was read, so a key
   destroyed in the meantime is never revived. A non-zero `failed` means rows that neither key
   could unwrap; they are left as they were and `status` stays `pending`. Check that
   `MASTER_KEY_PREVIOUS` really is the old key before going on. Every call is audited
   (`platform.master_key_rotated`, with the counts).
5. **Check the result.** `GET /api/platform/keys` should list every wrapped key under the new
   `masterId`.
6. **Remove `MASTER_KEY_PREVIOUS`.** Only after `status` is `done`: a data key still wrapped under
   a master key that is no longer configured can't be unwrapped, and its data is unreadable. Keep
   the old key in the offline backup for as long as you may need a database backup taken before
   the rotation, which holds data keys wrapped under it.

### Fields

AES-256-GCM through WebCrypto. Each ciphertext is bound to its table, column, row id and owner
(as additional authenticated data), so it can't be copied into another row or another tenant.

| Stays readable (metadata) | Encrypted (tenant data) |
|---|---|
| ids, foreign keys, timestamps | emails, names, display names |
| statuses, roles, limits, tiers | org, team (D39) and instance display names |
| random slugs, hostnames | SSO connector settings and client secrets |
| heartbeat numbers | OAuth tokens |
| audit action types | invite addresses |
| | instances' git credentials, commit identity and clone allowlist (D79) |
| | audit log details |
| | staff notes on registration codes, support request reasons |
| access request source, status and timestamps | access request address, use case, company and staff message (the request's own key, D69) |
| | session IP addresses and user agents (user key, D49) |
| | newsletter subscriber addresses (the subscriber's own key, D70) |

Secrets that are only ever compared are stored as SHA-256 hashes, never encrypted: session tokens,
email sign-in codes, registration codes, confirmation tokens and newsletter opt-in tokens (D49).
Newsletter manage links are not stored at all: they are an HMAC over the subscriber id and a
version number, with a key derived from `BETTER_AUTH_SECRET` (HKDF, its own label). A leaked database export
then holds no live session or usable code.

What counts as which is listed per table in the [data model](data-model.md).

### Newsletter addresses and their retention

Newsletter subscribers (D70) are often not users, so each gets a data key of their own, and
their address is kept only as long as it is needed:

| State | What is kept |
|---|---|
| unconfirmed (double opt-in pending) | Encrypted address and key for 30 days, then row and key are deleted |
| active | Encrypted address, key, blind index |
| unsubscribed or suppressed (bounce, complaint) | The same for 30 days, so an unsubscribe can be undone from the manage page; then the address is **shredded**: the key row is deleted and `email` set to NULL. The blind index and status stay as a suppression list, so a suppressed address is never mailed again and a returning address goes through double opt-in, getting a new subscriber id and a new key |
| account deleted (D59) | The subscriber for the account's address is deleted with its key |

The daily cron does the deleting and shredding. Per-address mail limits key their KV counters on
the blind index; no log line, audit entry, error or KV key holds an address (the local-dev mail
capture `dev:mail:<address>` exists only with `LOCAL_DEV=1`). The console sees counts only.

### Retention of sign-in, invitation and mail records

Rows that hold personal data, or point at a person, and that nothing else removes are deleted by
the daily cron (`src/control/system/retention.ts`), in batches of 500, at most 10,000 rows of each
kind per run (a backlog drains over the following days):

| Rows | Deleted |
|---|---|
| Sessions (encrypted IP address and user agent) | 7 days after the session expired |
| Verifications (sign-in codes and other one-time values) | 1 day after they expired |
| Invitations (encrypted address) | 30 days after the invitation's expiry date (37 days after it was sent), whatever its status: pending, accepted, rejected or canceled |
| Sign-in reset requests (`support_requests`, encrypted reason) | 30 days after the request expired unapproved, or 30 days after it was executed |
| Mail records (`mail_messages`: Resend's id, a reference such as `invitation:<id>`, the last delivery event; no addresses) | 30 days after the final delivery event (delivered, bounced, complained, failed, suppressed, or a refused send). A mail still in flight (no event yet, `sent`, `delivery_delayed`) is kept until 180 days after it was sent. The mail of an invitation that still exists is kept with it, for the invitation list's delivery status |

Access requests (D69), newsletter subscribers (D70) and the audit logs (D57) have their own
retention, described with them. `mail_daily` holds counts only and is kept.

### Looking things up by email

Sign-in needs "find the user with this email". Each encrypted email has a blind index next to it:
an HMAC-SHA256 of the normalized address with the blind-index key. Only exact matches work, so
admin search by email is "exact email", never "contains".

### The Better Auth adapter

Better Auth reads and writes `user`, `account`, `session`, `invitation` and `verification` rows
itself. Better Auth accepts a function as its `database` option, so a wrapper around its Kysely
adapter on D1 sees every call, with structured `where` clauses (field, operator, value), and:

- encrypts on write and decrypts on read, including the `user` joined into session lookups;
- turns `where email = ?` on `user` and `invitation` into a blind-index lookup (every email query
  in core and in the organization and SSO plugins uses `eq` on a lowercased address);
- stores the session token as a hash and turns `token` lookups, including `in` lookups, into
  lookups by hash. Every token it is given is hashed, whatever it looks like, so a stored hash
  from a leaked export never works as a token. Sessions read by anything but their token (as
  `listSessions` does) carry a signed handle instead of a token: valid for 15 minutes, only for
  that session, and impossible to make from the database alone. `revokeSession` passes it back.
  `GET /api/me/sessions` hands these out so a person can see their own sessions
  (`DELETE /api/me/sessions/:handle` ends one, `POST /api/me/sessions/revoke-others` the rest);
  Better Auth's own `/list-sessions`, `/revoke-session` and `/revoke-other-sessions` stay closed.
  The list shows a coarse "Browser on OS" label, never the user agent, IP address or location;
- covers `consumeOne`, `incrementOne` and the adapter passed into transactions, not only the
  usual create, find, update and delete calls.

Better Auth does the rest itself (D54): the email OTP plugin hashes codes (`storeOTP: "hashed"`),
and `verification.storeIdentifier` hashes identifiers, which contain the email address, with our
blind-index HMAC. The SSO plugin finds a provider by email domain with an `eq` lookup on its
`domain` field, so that field gets a blind index too.

Not usable with this design: Better Auth's `secondaryStorage` (it needs atomic operations KV
doesn't have) and the admin plugin's `listUsers` search (it searches email with `contains`).
 This is the riskiest piece of the design and was prototyped first.

### Scope

This covers the control plane's database. The gate objects hold only ids, statuses and times. Data inside each instance's Railway volume is not
covered by it.

## Sign-in rules enforced in code

- **SSO counts only for the org whose provider it was.** A session records the org of the
  domain-verified SSO provider that created it. An instance or org policy that requires SSO is
  met only by that org's SSO; any other SSO session meets no method requirement at all.
- **Passkeys and MFA (D24).** The first passkey can be added from any session. Once an account
  has one, adding, renaming or removing passkeys needs a session signed in with a passkey. Every
  new passkey is emailed to the account and audited. Someone who loses every passkey needs an
  account reset by platform support, which takes two people (next bullet).
- **Two-person sign-in reset.** One staff member (admin or superadmin) requests it with a reason;
  a different staff member approves it within 24 hours from a session signed in with a passkey.
  Approving executes it: every passkey and session of the person is deleted, their gate sessions
  are dropped, and they are mailed. The person being reset can neither request nor approve their
  own reset, one request per person can be open at a time, and the requester must still be active
  staff when it is approved. The reason is encrypted with the person's own key. They then sign in
  with an email code and add a new passkey.
- **Disabling an account ends its access at once.** Disabling sets the status and deletes every
  control-plane session and gate session of the person in the same call; the status alone is
  only checked when a session is created or a token renewed, so it isn't left to expire. Staff can
  also sign someone out everywhere without disabling them. Nobody can disable themselves, a
  waitlisted account, or the last active superadmin.
- **Staff act only on people below them.** Support actions (sign out, disable, enable, reset
  request and approval) need a platform role strictly above the target's: admins can't touch admins
  or superadmins, superadmins can't touch superadmins. At approval the requester is checked again.
  A disabled account records who disabled it and their role at the time; only someone of at least
  that role can enable it again (403 `disabler_outranks_you`). Finding a person takes their exact address, never a search, and every lookup is
  audited, misses included, without the address.
- **SSO provider ids.** New providers get an id starting `sso-` (3 to 40 more characters of
  `a-z`, `0-9`, `-`). Accounts are keyed by provider id, so ids of built-in methods (`google`,
  `microsoft`, `credential`, the other social providers and our own method names) are refused, and
  an id is never reused: it counts as taken while any provider or any account, even one left
  behind, carries it. The list of an org's connectors never returns client secrets, certificates
  or endpoints.
- **Deleting an SSO provider** removes the accounts linked through it for members of that org
  only, never another org's, and ends every SSO session of the org together with its gate
  sessions: sessions record the org, not the provider. People sign in again.
- **Changes that could lock members out** need the typed name, a passkey session and the emailed
  confirmation (D30, D31); see [below](#what-counts-as-locking-members-out).
- **Sign-up codes** are claimed atomically while the registration is decided, so concurrent
  sign-ups can't share the last use of a code.
- **Better Auth's own HTTP routes** for organizations, members, teams, invitations and SSO
  providers are closed (allowlist); those changes go through our routes, which add the
  last-admin guards, confirmations, gate session drops and audit entries.

### What counts as locking members out

The check (D31, `lockOutReport` in `tenancy/policy.ts`) runs before a change to the org login
policy, to an instance's login policy, or the removal of an SSO provider, and lists the members it
would hurt. Disabled and pending accounts are left out: they have no access either way. A member
is listed when either of these is true:

- **They lose their way in.** For the org, and again for each instance their teams grant, the
  allowed methods are the org's, narrowed by the instance's (an instance can only narrow, D23; no
  overlap left admits nobody). Of those, the member can only use methods they can actually
  complete: the email code (always), a passkey if they have one, Google or Microsoft if linked, and
  SSO if an SSO provider of the org with a verified domain matches their address or they already
  have an account on it. A member counts when that gave them at least one way in before the change
  (the required email domain included) and none after. The reason is `domain` when their address
  fails the new required domain, otherwise `method`; the instances they lose are listed.
- **Their session stops counting.** The method of their newest live session was admitted before
  and isn't after (reason `signed_out`).

A change that lists nobody is applied at once. One that lists someone is refused until the admin
types the org name (the instance name, or the provider's id), is on a passkey session, and then
waits for the emailed confirmation; the affected members are returned with every refusal so the
console can show them. Removing an SSO provider also needs this confirmation when a policy depends
on it (an SSO-only org policy, an instance policy requiring SSO, or a required domain only that
provider serves), even if nobody is affected today. Removing a verified domain is refused outright
while an SSO provider or the org policy uses it.

### Delivery webhooks

`POST /api/webhooks/resend` receives Resend's delivery events. Resend signs them with Svix: the
Worker checks `HMAC-SHA256(secret, "<svix-id>.<svix-timestamp>.<raw body>")` against the
`svix-signature` header with a constant-time compare, and refuses timestamps more than 5 minutes
off in either direction. With no `RESEND_WEBHOOK_SECRET` configured the endpoint answers 404, so it
can't be used unsigned. It stores no addresses: only Resend's email id, the reference and kind we
tagged the send with (for example `invitation:<id>`), the latest event and its time. The per-day
mail counts hold no addresses either. Our Resend key can only send, so these are the only numbers
we have.

Each `svix-id` is remembered (hashed) in KV for 10 minutes, so a replayed event is acknowledged and
ignored. Bodies over 256 KiB are refused by `content-length` before they are read, and the read
itself stops at the limit, counted in bytes.

### Limits that protect shared resources

- **Mail.** All tenants share one Resend quota (100 mails a day on the free plan) with sign-in
  codes. Invitation mail is capped per org at 50 a day, creating and resending together, and each
  invitation can be resent at most once per 5 minutes and 5 times a day (429 `resend_too_soon`,
  `invitation_mail_limit`). The per-invitation count follows the invited address, so replacing an
  expired invitation doesn't reset it.
- **Org key rotation.** Refused while the org's re-encryption job is running or verifying (409
  `rotation_in_progress`) and within an hour of the last rotation (429 `rotation_too_soon`).
- **Revoking sessions.** Any session of an account may sign out its other sessions, including
  passkey sessions, as on Google and GitHub. Someone with a stolen email-code session can sign the
  owner out, but gains nothing from it, and the owner can sign straight back in.

### Outbound requests to tenant-supplied URLs

SSO configuration and domain verification make the control plane fetch URLs a tenant admin
supplies. They must be `https`, and IP literals, `localhost`, `.internal` and our own domains
are refused (local development alone also accepts a loopback IdP over `http`). Private address
ranges aren't checked after DNS resolution: a Worker's outbound `fetch` reaches only the public
internet, so there is no private network to reach. That changes if Workers VPC is ever bound to
the control plane (D51); resolve and check addresses then.

### Git credentials of instances

Tenant admins hand the platform credentials for their own repositories (D79): a GitHub App's
private key, tokens, a client secret. They are written once and never sent back to a browser; the
console shows what they are and their last four characters. They are kept encrypted with the org
key (erased with the org) and written only to the instance's own Railway services, where Worca adds
them to its own git calls and never gives them to agents. Adding or replacing one needs a passkey
session, as turning remote access on does (D72); so does changing the clone allowlist. The audit log
records what changed (kinds, App ID, the token's account), never a value. Variables written to
Railway are read back by name; errors and logs name variables, never values. The control plane
calls only `api.github.com` to check a GitHub credential, with a fixed set of paths.

### Trusting an org's identity provider

The Better Auth SSO plugin fetches an OIDC provider's discovery document and checks every URL in
it with an "is this a trusted origin" test. In its own registration route that test is Better
Auth's global `trustedOrigins`, the same list that decides which origins may make state-changing
requests and which `callbackURL`s and redirect targets sign-in accepts. That list holds only
`app.worca.dev`, and stays that way: adding tenant IdP origins to it, even through a
per-request function, would make every origin some tenant typed in a valid post-login redirect
target (an open redirect that can carry people's sign-ins to an attacker's site) and a trusted
request origin, for every flow.

So registration (`POST /api/orgs/:orgId/sso`, `tenancy/sso-routes.ts`) runs discovery itself,
through the plugin's own `discoverOIDCConfig`, with a trust test that applies to that one call
only: the issuer, the discovery URL and every endpoint the document lists must be `https` on a
public name that isn't ours (the rules above). Endpoints a tenant admin types by hand must also be
on the issuer's site; discovered ones needn't be, since the issuer's own document vouches for
them (Google and Entra ID serve some endpoints from other domains). Redirects from the discovery
URL aren't followed. The resolved endpoints are registered with `skipDiscovery`, so the plugin's
route fetches nothing and trusts nothing; at sign-in it fetches only the stored token, JWKS and
userinfo endpoints, which it allows for public hosts without consulting `trustedOrigins`, and it
validates the id token's signature, issuer and audience. SAML settings are never fetched: the IdP
metadata XML (or entity id, sign-on URL and certificate) is part of the request. Both kinds of
connector are stored encrypted under the org's key.

## When a provider is breached

What each provider holds, and what to renew when it says it may have leaked. Rotate first, then
read the provider's logs for use since the incident. Done for Railway on 2026-10-23 (D74).

| Provider | What it holds | What to do |
|---|---|---|
| Railway (instance variables) | Per instance: tunnel token, broker secret, heartbeat credential, broker vault key | "Renew all credentials" on the platform Operations page (D74, [Instance lifecycle](instance-lifecycle.md#rotate)). Running instances restart; tenant admins are emailed. The vault key stays (next row) |
| Railway (volumes) | Worca's data, the broker's key store (encrypted with the vault key) | Not covered by a rotation. If both a volume and its vault key may have leaked, the provider keys people stored are exposed: tell the org's admins to revoke and re-enter them |
| Railway (account) | The workspace token the control plane uses (`RAILWAY_TOKEN`), held only by us | Issue a new workspace token for "My Projects" in the Railway dashboard, put it in `.secrets.env` and on the control Worker (`wrangler secret put RAILWAY_TOKEN -c wrangler.control.jsonc --env prod`), delete the old one. Railway may have revoked it already: provisioning then fails until this is done |
| Cloudflare (Worker secrets) | `MASTER_KEY`, `BLIND_INDEX_KEY`, `BETTER_AUTH_SECRET`, `IDENTITY_SIGNING_JWK`, `CF_API_TOKEN`, `RAILWAY_TOKEN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TURNSTILE_SECRET`, `RELEASE_HOOK_SECRET`, `SETUP_TOKEN` | The master key has its own procedure ([Rotating the master key](#rotating-the-master-key)). The provider tokens: issue new ones at the provider, `wrangler secret put` each, revoke the old. A new `BETTER_AUTH_SECRET` signs everyone out; a new `IDENTITY_SIGNING_JWK` makes running instances reject sessions until they fetch the new key set. `BLIND_INDEX_KEY` can't simply be replaced: every blind index would have to be recomputed |
| Cloudflare (tunnels) | Tunnel secrets (the tokens are made from them) | Renew all credentials, as for Railway |
| Resend | Sending key, webhook signing secret | New key and webhook secret at Resend, `wrangler secret put RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` |

Instances the control plane doesn't manage (the team's self-run `worca-01`) are renewed by hand:
new tunnel secret, its open connections dropped and a new `TUNNEL_TOKEN`, new `WORCA_BROKER_SECRET` on worca and the broker, a new
private key for any GitHub App in its variables, then a redeploy of all its services.

## Audit trail

Every operation by anyone is recorded (D40): sign-ins, invites, membership and team changes,
policy changes, instance creation, upgrades, suspensions, deletions, key rotations, and every
platform action on a tenant.

- **Platform log:** platform-level actions. Readable by platform roles.
- **Org log:** everything in an org, including platform actions on its instances. Details are
  encrypted with the org's key. Tenant admins can read it (D41).
- When an org is deleted its key and log are destroyed with it. The platform log keeps a metadata
  record of the deletion (org id, who, when) so the deletion itself stays accountable.
- Both logs keep entries for 30 days, then delete them (D57).
- The org log is append-only for everyone. The one exception is the key re-encryption job, which
  may replace an entry's encrypted details with the same text under a newer key version; the
  database trigger allows only that.
- Staff lookups and support actions are in the platform log (`support.*`). It holds ids and
  numbers only (D15): never an address, a reason or a note.

## Abuse

- Outbound traffic from agents follows the org's outbound network policy or the instance's own
  (D73, refining D34), with CPU alerts; see [Outbound network](#outbound-network).
- Superadmins and admins can stop an instance, logged, with the tenant admins notified (D16). A
  visit never wakes a stopped instance (D47). They cannot read its data.
- Worca's terminal and actions are off on every instance (remote mode). Only the org's tenant
  admins can turn either on, per instance, with an MFA session; platform roles cannot (D15, D72).
  Either one gives everyone who can open that instance a shell or commands running as the Worca
  server user, which can read Worca's settings and environment, including the broker secret;
  agents stay isolated. Each change is in the org audit log (`instance.remote_access_set`) and
  restarts Worca.
- Reports go to `abuse@worca.dev` or a form on `worca.dev`, linked from the "stopped" page and
  from `security.txt` on both domains (D58).

## Outbound network

- **Policy** (D73): open by default; an org can block hosts or allow only some, and an instance can
  have its own policy instead. Only tenant admins change it. Loosening (any change that could let
  a host through that wasn't before; the exact rules are in [Internal APIs](internal-apis.md),
  "Outbound network policy") needs an MFA session; tightening doesn't. Changes are compare-and-set
  (409 `egress_changed`) and audited (`org.egress_updated`, `instance.egress_set`,
  `instance.egress_reset`, with from and to). Host lists are tenant data, encrypted with the org key.
- **Enforced by Worca, softly.** The platform stores the policy and sends it to the worca service
  as `WORCA_EGRESS_MODE` / `_ALLOW` / `_DENY`. From Worca 1.11.0 (worca-cc #634) Worca runs a
  filtering proxy on loopback inside its container and points `HTTPS_PROXY` / `HTTP_PROXY` at it
  for every program it starts and for its own calls; older versions ignore the policy. On Railway
  this is a guardrail, not a boundary: the container itself can reach any host, so a program that
  ignores the proxy variables, unsets them, or opens raw sockets connects directly, and DNS isn't
  filtered. Agents run arbitrary commands, so one trying on purpose can get around it. A hard limit
  needs network-level control Railway doesn't offer (worca's Docker Compose overlay has it: worca's
  network has no route out but the proxy). The console says both, wherever the policy is edited.
- **Always allowed**, listed once in `instances/egress.ts` (`platformEgressHosts`), shown read-only,
  never blockable: the control plane's host (heartbeats, and the JWKS Worca checks sign-ins with)
  and the instance's broker on Railway's private network (`worca-run-broker.railway.internal`;
  agents reach model providers through it, D68). The policy goes to the worca service only: the
  broker (which calls the model providers) and cloudflared (which needs Cloudflare's tunnel
  endpoints) are separate services and are never restricted by it, so their hosts aren't listed.
- **Fail closed**: the variables are written together and read back before the restart, and the
  pending flag clears only once the new deployment runs; a write or deployment that can't be
  confirmed keeps the policy pending and visible, never silently looser.

