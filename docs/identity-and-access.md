# Identity and access

## One account, scoped roles

Every person has one account. What they can do comes from role bindings, each with a scope
(decision D13):

| Scope | Role | Can do |
|---|---|---|
| Platform | **superadmin** | System settings; grant and revoke all platform roles; rotate the master key; everything an admin can do |
| Platform | **admin** | Tenant processes, tenant invites (codes that let an org register), tenant limits and tiers; stop an instance for abuse; support actions on people: look up an account by exact email, sign it out everywhere, disable and enable it, request and approve a sign-in reset. Cannot grant platform roles |
| Platform | **support** | Read-only: orgs, instances, their status and operations. No support actions on people |
| Org | **tenant admin** | Everything in their org: settings, login policy, SSO connectors, teams, members, instances, data key rotation, audit log, deleting the org |
| Org | **tenant user** | Use the instances their teams grant |

Rules the code enforces:

- There is always at least one superadmin, and every org has at least one tenant admin.
- No platform role ever grants access to a tenant instance (D15). A platform staff member who is
  also a tenant member gets in through that membership only.
- Platform staff act only on people whose platform role is strictly below their own: an admin can't
  disable, sign out or reset another admin or a superadmin. Only someone of at least the disabler's
  role can enable a disabled account. Nobody can disable themselves or the last active
  superadmin.
- Platform roles require MFA or a passkey. Tenant admins must confirm with MFA or a passkey before
  destructive actions (D24).

## Orgs, teams and instances

```
org ──┬── members (user, role: tenant admin | tenant user)
      ├── teams ── team members (user)
      └── instances ── instance teams (team, role: reserved, empty in v1)
```

- A tenant admin registers and creates the org (tenant = org, D17).
- Tenant admins create teams, invite people by email, and put members into one or more teams.
- Tenant admins create instances within a team, and can share an instance with more teams. An
  instance always keeps at least one team: removing its last team, or deleting a team that is
  some instance's only team, is refused until another team is assigned or the instance is
  deleted (D71).
- Teams come first: the console leads a new org through creating its first team (the admin is
  added to it), then the first instance in that team. While an org has no team, every "new
  instance" action is "create a team first".
- A person can use an instance only if at least one of their teams is assigned to it (D19).
- A person can belong to several orgs and switches between them in the control plane (D21).

### What members see

- **Member directory (D62).** Every member of an org sees every other member's name, email, role
  and teams, as in GitHub, Slack or Linear. Only tenant admins also see when people joined, how
  each signs in (email code, passkeys, Google, Microsoft, SSO), who invited them, the pending
  invitations and the management actions (change role, remove, resend or cancel an invitation).
- **Teams.** Every member sees the org's team names, their member counts and which teams are
  their own. Only tenant admins see which instances a team grants and when it was created. A tenant
  user also gets their own teams with the instances each one grants them, and the names of the
  teams that grant them access to an instance.
- **Instances.** Tenant admins see all of the org's instances; a tenant user sees the ones their
  teams grant (D19). Each org in the switcher shows how many instances the person can open there,
  as a number only.

## Registration

One platform setting picks the mode (D25):

| Mode | What happens |
|---|---|
| **Invite code** (launch) | Signing up needs a code from a platform admin. Email is verified first, then the account is active. |
| **Waitlist** | Anyone can sign up; the account waits for a platform admin to approve it. A valid code skips the wait. |
| **Open** | Anyone with a verified email gets an active account. |

Invites to an existing org are separate: a tenant admin invites an email address; the person signs
up or signs in and joins the org. An invitation is valid for 7 days; resending it starts the 7 days
again. Someone who joined only through an invitation can't create an org of their own until
registration is open (D25).

### Access requests

While registration is invite-only, people ask for access with the form on worca.dev (D69):

1. The form posts address, use case and optionally company to `POST /api/public/access-requests`
   (CORS for `PUBLIC_FORM_ORIGINS`, per-IP rate limit, Turnstile when configured). The answer is
   always `202 { ok: true }`, whether or not the address has an account or an open request.
2. A new request gets a confirmation mail linking to `/access-request#t=<token>` on the app. The
   token is in the fragment, so it never reaches a log; the page posts it when the person presses
   the button. The token is stored hashed and expires after 7 days. Sending the form again resends
   the link at most once an hour; once confirmed, nothing more is sent. An address that already
   has an account gets no mail.
3. Confirmed requests wait for a superadmin (`access_requests.manage`) in the console under
   Access requests. Superadmins are mailed when the first one arrives, then at most one digest an
   hour (5-minute cron), with counts only.
4. Granting creates a single-use registration code through the same path as a staff-made code,
   bound to the requester's address (`registration_codes.email_index`): sign-up with it is
   refused for any other address. The mail links to `/sign-in#code=<code>`, which fills in the
   code field. Declining mails a short note unless the superadmin turns it off.
5. When the account is created with that code, the request becomes `joined`. The console shows
   the funnel: requested, confirmed, granted, signed up, and signed up people running an instance.

Each request's personal data is encrypted with its own data key. A daily cron deletes unconfirmed
requests, with their key, 7 days after the link expired. 180 days after a decision (or, for
`joined`, the sign-up) it deletes the key and empties the address, its blind index, the use case,
the company and the staff message; the anonymous row stays so the funnel counts don't change.
Audit entries and logs never carry an address or request text.

## Sign-in methods

Sign-in happens once, on `app.worca.dev` (D22):

| Method | Setup |
|---|---|
| Email code | Sent through Resend. No passwords anywhere in the system. |
| Google | One Google Cloud project and one OAuth client for the whole platform. Redirect URI on `app.worca.dev`. The consent screen must be published to production (testing mode caps at 100 users). Only `openid`, `email` and `profile` are requested, so full app verification isn't needed; brand verification (homepage and privacy policy on a verified domain) is, to show our name and logo. |
| Microsoft | One Entra app registration, multi-tenant (`common`, which includes personal Microsoft accounts). Requests only `openid`, `profile` and `email`. Publisher verification needs a Microsoft AI Cloud Partner Program account whose verified domain matches the app's publisher domain; it is free. With it, users can consent themselves under Entra's default policy. Companies that turn user consent off use the admin consent URL `login.microsoftonline.com/{tenant}/adminconsent?client_id=…` or Entra's admin consent request workflow. |
| Passkey | Better Auth passkey plugin. Can be added to any account as a sign-in method and as the second factor. |
| Org SSO | An org connects its own OIDC or SAML provider (Entra, Okta, …), tied to an email domain the org proved it owns with a DNS TXT record. Better Auth SSO plugin. |

**Org SSO connectors.** A tenant admin registers a connector for a domain the org has verified.
The console shows the two URLs to enter at the identity provider, both on `app.worca.dev` and built
from the connector's id (`sso-…`): for OIDC the redirect URI
`https://app.worca.dev/api/auth/sso/callback/<providerId>`; for SAML the assertion consumer service
(reply) URL `https://app.worca.dev/api/auth/sso/saml2/sp/acs/<providerId>` and the service provider
metadata at `https://app.worca.dev/api/auth/sso/saml2/sp/metadata?providerId=<providerId>`. The
list never shows secrets or certificates.

What the admin enters. **OIDC** (Entra ID, Okta, Google Workspace, Auth0, …): the issuer URL, the
client id and the client secret. The endpoints come from the issuer's discovery document, which is
fetched once at registration; an IdP without discovery can be configured by hand (authorization,
token and JWKS endpoints, on the issuer's site). Scopes default to `openid email profile` and PKCE
is on. **SAML**: the IdP's metadata XML, or by hand its entity id (the issuer), its sign-on URL
(HTTP-Redirect binding) and its signing certificate. Our side of SAML is the service provider
metadata URL above, which is also our entity id and the audience the IdP must send. Every IdP URL
must be `https` on a public host; settings the IdP or the plugin refuse come back as 400s with a
code and an explanatory `detail` (`discovery_failed`, `issuer_mismatch`, `cert_required`, …;
[internal APIs](internal-apis.md)). Registering an IdP never makes its origin trusted anywhere
else ([security](security.md#trusting-an-orgs-identity-provider)). People the connector signs in
for the first time join the org as tenant users.

A connector whose domain is no longer verified shows
`domain_unverified` and signs nobody in. Deleting a connector removes the accounts linked through it
for the org's members and ends every SSO session of the org, so people sign in again. It needs
a passkey session, and the confirmation above when members would lose access or a policy depends
on the connector.

Accounts are linked by verified email: signing in with Google and later with Microsoft under the
same verified address reaches the same account. "Verified" means the provider says so: Google's
`email_verified`, Microsoft's optional `xms_edov` claim. Microsoft's `email` claim alone is never
trusted, and Microsoft users are identified by `tid` + `oid` (D50).

## Login policy

- **Org policy:** which methods members may use, and optionally a required email domain
  ("only @acme.com, only through our SSO").
- **Instance policy:** can only narrow the org policy, e.g. "this instance requires SSO". If the
  current session used another method, the person is asked to sign in again with the required one
  before the gate lets them in (D23).
- Changing a policy so that current members could no longer sign in counts as a destructive action
  (D31). The check lists every active member who would lose their way into the org or into one of
  their instances, or whose live session's method would stop being allowed, and it covers
  instance policies as well as the org policy: for each instance a member reaches, the methods
  allowed are the org's, narrowed by the instance's. Removing an SSO provider is analysed the same
  way. The admin then types the org's name (the instance's, or the connector's id), needs a
  passkey session and confirms by email. The exact rule is in
  [Security](security.md#what-counts-as-locking-members-out).
- Disabling an account (platform support) takes away every session and every instance session of
  the person at once. Enabling it doesn't bring them back; they sign in again. A person who lost
  every passkey gets a two-person reset (see [Security](security.md)).

## The instance gate

The gate Worker on `*.worca.run/*` decides every request before it reaches an instance. The
sign-in exchange, the 60-second pass and revocation are described in
[Architecture](architecture.md#signing-in-to-an-instance).
The identity token it hands to worca:

- is a JWT signed by the control plane, verified by worca against
  `app.worca.dev/.well-known/jwks.json`;
- has the instance's host as its audience, so a token for worca can't be used on the key page
  and the other way round;
- carries the user id, email, display name and the ids of the teams that granted access;
- lives a few minutes; the gate renews it server to server, and the control plane checks access
  again each time (D45).

Platform staff never get a token for an instance from their platform role.
