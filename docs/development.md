# Development

## Layout

npm workspaces. The published packages live in `packages/`; everything else is for working on
them. Paths below `src/` are inside `packages/platform/`.

```
packages/platform/         @worca/platform (exports ., ./control, ./gate, ./providers, ./testing,
                           ./smoke; bin worca-platform)
  src/index.ts             defineConfig, definePlatform, config types, resourceNames, wranglerVars
  src/control.ts           createControl(config, extensions): the Worker and its classes
  src/gate.ts              createGate(config, extensions)
  src/providers.ts, src/testing.ts   provider interfaces and built-ins; conformance checks
  scripts/build.mjs        dist/ (tsc -p tsconfig.build.json, explicit .js specifiers)
  scripts/brand-assets.mjs a deployment's branding/ over ui/ (docs/branding.md)
  cli/                     worca-platform, the deployment's commands: configure (wrangler configs
                           from worca.config.ts + worca.resources.json), setup, deploy, dev, smoke,
                           secrets, admin, upgrade. Every wrangler call goes through cli/wrangler.mjs
  smoke/                   @worca/platform/smoke: one instance end to end, pluggable inbox
  stub/instance.mjs        local stand-in for worca instances (fake provider target), published so
                           a deployment's `npm run dev` has it
  migrations/              D1 migrations of the control plane (published)
  ui/                      the console's static files (published)
packages/create-platform/  @worca/create-platform: npm create @worca/platform <folder>
  lib/scaffold.mjs         questions (flags, env, prompts), checks, writing, repair
  templates/               what it writes into a new deployment (templates/README.md)
dev.config.ts              the contributors' stack; wrangler.{control,gate}.jsonc at the root are
                           its generated dev-only configs (worca-platform-* names, fake providers)
src/shared/contracts.ts    types shared by both Workers: RPC interfaces, KV entry, token claims
src/control/               control plane Worker
  env.ts                   bindings, vars, secrets; Hono AppContext
  index.ts                 routing, onError, scheduled
  rpc.ts                   ControlRpc entrypoint the gate calls
  keys-api.ts / keys.ts    key hierarchy and field encryption (contract / implementation)
  keys-jobs.ts             org key re-encryption job; the registry of encrypted columns
  keys-workflow.ts         KeyRotationWorkflow, drives that job
  keys-routes.ts           master key rotation routes (/api/platform/keys/...)
  auth/                    Better Auth, adapter wrapper, sign-in pages, email, rate limits, Turnstile
  tenancy/                 roles, audit, orgs/teams/members/invites, login policy, confirmations, me
  identity/                identity tokens, JWKS, /authorize, one-time codes, renewal
  instances/               instances API, tiers, provisioning Workflow, heartbeat, crons,
                           operation progress, provider status polling, platform ops routes
  system/                  mail counts, Resend webhook (Svix), provider usage for the system page
  providers/               ComputeProvider and EdgeProvider: fake, railway, cloudflare
src/gate/                  gate Worker: handler, GateObject, GateRpc, cookie, headers
test/unit/{control,gate}   vitest inside workerd, one project per Worker
test/fakes/                fake GateRpc / ControlRpc used by the unit tests
test/e2e/                  node:test suites against the running local stack
scripts/test-package.mjs   npm run test:package: pack both packages, the packed create-platform
                           into a throwaway folder, setup twice against a fake wrangler, tsc,
                           dry-run deploy, npm run dev, npm run smoke -- --env dev
test/scripts/              node:test of the scripts and CLIs (scaffold.test.mjs: create-platform,
                           configure, setup against fixtures/fake-wrangler.mjs)
scripts/pack-platform.mjs  npm run pack:platform: build and pack, prints the tarball path
```

## Running locally

```
npm install
npm run keys:dev          # writes .dev.vars (both Workers share it)
npm run migrate:local
npm run dev               # stub instance server (:9100), control (:8787), gate (:8798)
```

- Control plane: `http://app.localhost:8787`.
- Instances: `http://{slug}.run.localhost:8798`. Browsers resolve `*.localhost` to loopback;
  from Node, connect to 127.0.0.1 and send the `Host` header.
- The two Workers find each other through Wrangler's dev registry (service bindings with
  named entrypoints `ControlRpc` and `GateRpc`).
- Mail is not sent locally: it is captured in the control plane's KV under `dev:mail:<to>`.
- Compute and edge providers are `fake`: the provisioning Workflow talks to the stub instance
  server instead of Railway and Cloudflare.
- `scripts/dev.mjs` starts the control plane with `RELEASE_IMAGE_CHECK=off`, so publishing a
  worca release (`PUT /api/platform/worca-version`) doesn't look for the image on GHCR, and the
  cron doesn't enroll releases from npm (D77). The skip needs `LOCAL_DEV=1` as well; a deployed
  Worker always checks.
- `RESEND_WEBHOOK_SECRET` is not set locally, so `POST /api/webhooks/resend` answers 404.

## Tests

```
npm test                  # unit tests, both projects
npx vitest run --project control test/unit/control/keys.test.ts
npm run test:e2e          # needs `npm run dev` running
npm run check             # TypeScript
```

### End-to-end

```
E2E_FAST=1 npm run dev        # short gate timers: idle 20 s, recheck 10 s, pass 5 s
E2E_FAST=1 npm run test:e2e   # suites run one at a time; they skip when the stack is down
```

- `E2E_SLOW=1` adds the tests that wait out a real 5-minute identity token.
- The stub's admin API is at `http://127.0.0.1:9100/__admin/instances`;
  `POST …/:id/clock {offsetSeconds}` shifts one instance's clock (W7 tests).
- Ports: `CONTROL_PORT`, `GATE_PORT` and `STUB_PORT` (8787, 8798, 9100), read by `npm run dev`
  and by the e2e and UI tests alike; set the same values for both. `npm run dev` stops if a port
  is in use, and the tests only accept the gate when it answers like the gate. `PERSIST_TO` moves
  the local state.
- The superadmin's virtual passkey is kept in `.wrangler/e2e/`; delete it when you reset
  `.wrangler/state`.

The compatibility date is held at 2026-08-20, the newest the bundled workerd supports.

### Browser tests of the UI

```
npm run test:ui        # test/ui/*.test.mjs, Playwright (Chromium) against the local stack
```

Each view module has a file; `test/ui/lib.mjs` opens pages signed in as e2e people, adds virtual
WebAuthn authenticators and checks phone widths. `UI_HEADED=1` shows the browser.

### Smoke test of a deployment

`npx worca-platform smoke` (a deployment's `npm run smoke`) creates a real instance on a deployed
platform, signs in to it through the gate and deletes it, reading mail through `--inbox`, a module
exporting `getMail(to)`. Against the local stack, `npm run smoke -- --env dev` uses the mail
capture. See [Deploying your own platform](deploy.md). The e2e helpers read mail through
`E2E_INBOX_MODULE` in the same shape when they run against a deployed stack.

## Worker secrets and variables of the control plane

Required: `BETTER_AUTH_SECRET`, `MASTER_KEY`, `BLIND_INDEX_KEY`, `IDENTITY_SIGNING_JWK`
(`npm run keys:dev` writes them locally; `env.ts` lists every binding). Optional:

| Name | Kind | Purpose |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | secret | The `whsec_...` signing secret of the Resend webhook that points at `<app origin>/api/webhooks/resend`. Unset: the endpoint answers 404 and delivery events are not recorded. |
| `MASTER_KEY_PREVIOUS` | secret | The old master key, set only while a master key rotation runs (see [Security](security.md#rotating-the-master-key)). Unset otherwise. |
| `RELEASE_IMAGE_CHECK` | var | `off` skips the GHCR image check when a release is published, and only together with `LOCAL_DEV=1`. Set by `scripts/dev.mjs`; never set it in a deployed environment. |
| `NEWSLETTER_SEND` | Workflow binding | `NewsletterSendWorkflow` (`<name>-newsletter-send-<env>`). Sends a newsletter issue in batches. Optional in `env.ts`: without it the release hook answers 500 and marks the issue failed. See [Newsletter](#newsletter). |
| `KEY_ROTATION` | Workflow binding | `KeyRotationWorkflow` (`<name>-key-rotation-<env>`), next to `INSTANCE_OPS`. It re-encrypts an org's rows after the org rotates its key. Optional in `env.ts`: without it a rotation records its job but nothing runs it. |

Other optional secrets (`RESEND_API_KEY`, `TURNSTILE_*`, `GOOGLE_*`, `MICROSOFT_*`, `RAILWAY_*`,
`CF_*`, `SETUP_TOKEN`) are listed with their purpose in `env.ts`.

Turnstile: a managed widget covering the website and the app origin. The site key is public (the
website's own forms need it too); `TURNSTILE_SECRET` switches the check on. The smoke tests sign people up without a browser, so they send `TURNSTILE_BYPASS_TOKEN` (a
separate random secret of 32+ characters, read from `E2E_VARS_FILE`) in `x-turnstile-bypass`;
leave it unset anywhere the smoke tests don't run.

## Newsletter

Subscriptions, preferences and release mail (D70; code in `src/control/newsletter/` and
`src/control/public/newsletter.ts`, API in [Internal APIs](internal-apis.md#newsletter)).

| Name | Kind | Purpose |
|---|---|---|
| `RELEASE_HOOK_SECRET` | secret | Shared with worca-cc's release workflow, which signs `POST /api/hooks/release` with it. Unset: the hook answers 404 and no release mail goes out. |
| `NEWSLETTER_FROM` | var | Sender of newsletter mail: e.g. `Worca <news@news.example.com>` (`mail.newsletterFrom` in `worca.config.ts`), a Resend domain of its own (EU region, no open or click tracking) so bulk mail can't hurt delivery of sign-in codes from the main sender; replies go to `branding.contactEmail`. Unset: `EMAIL_FROM`. |
| `NEWSLETTER_POSTAL_ADDRESS` | var | The postal address line in the footer of every issue. Unset: the line is left out; set it before the first issue goes out. |

The release workflow posts `{ "version": "1.9.0", "url": "<release notes URL, https>", "notes": "<optional plain text>" }`
with the header `x-worca-signature: sha256=<hex HMAC-SHA256 of the exact body bytes, keyed with RELEASE_HOOK_SECRET>`:

```sh
body='{"version":"1.9.0","url":"https://github.com/SinishaDjukic/worca-cc/releases/tag/v1.9.0"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$RELEASE_HOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST https://app.example.com/api/hooks/release \
  -H 'content-type: application/json' -H "x-worca-signature: sha256=$sig" --data-binary "$body"
```

202: queued (`{ issueId, version, level, recipients }`); 200 `{ duplicate: true }`: that version
was announced already; 401: bad signature. Locally mail is captured as usual, and the manage
page is `http://app.localhost:8787/newsletter`.

## Email design

Every mail the control plane sends goes through one layout, `layout()` in
`src/control/auth/mail-layout.ts`, styled after Worca's website: `#ECEAE4` page, white card with
28px corners, ink headings, Poppins (JetBrains Mono for codes), the site's ink pill as the button,
a coloured kicker above the heading. The footer carries the reason line, any extra lines (the
newsletter's manage and unsubscribe links and postal address), the sender
(`branding.operatorName`, `contactEmail`) and links to the website, the app and the Privacy, Terms
and Legal pages, all from `worca.config.ts` (unset ones are left out).
Templates build their card from the blocks there (`kicker`, `h1`, `p`, `btn`, `code`, `quote`,
`fine`, `paragraphs`), re-exported by `auth/email.ts`:

- `src/control/auth/email.ts`: sign-in code, passkey added, invitation, action, confirmation
  (D30 link), sign-in reset; `noticeEmailHtml` wraps the text-only notices (instance and
  membership mail), which the tenancy and instances `sendEmail` seams use for any mail without `html`.
- `src/control/public/access-request-mail.ts`: access request confirm, granted, declined, staff notice.
- `src/control/newsletter/mails.ts`: subscription confirm, manage link, issues.

No mail builds its own HTML. Every mail also has a plain-text part (`text`) written by hand.

Client constraints the layout follows: tables with `role="presentation"` and inline styles only;
the `<style>` block adds just mobile tweaks, dark mode (`prefers-color-scheme`, plus `[data-ogsc]`
for Outlook.com) and the Google Fonts link, so a client that strips it still gets the light design.
No flex, grid or `var()`. Classic Outlook gets a VML button, a fixed 600px ghost table and Segoe UI;
rounded corners square off there. The logo is a PNG on its own pill
(`ui/assets/mail/worca-logo-{light,dark}.png`, served from `APP_ORIGIN/assets/mail/`), so it stays
legible when Gmail's apps invert the page; clients with dark-mode CSS swap to the dark pill. Muted
text is `#6B6760`, a shade darker than the site's `--ink-3`, to keep 4.5:1 contrast.

To look at the mails: `node scripts/mail-preview.mjs` renders every template with sample data into
`.mail-preview/` (gitignored; open `index.html`), and `--shots [dir]` adds Playwright screenshots,
light and dark at 600 and 375 px. A browser is not a mail client: check real clients (or a
rendering service) after larger layout changes.

## Conventions

- **Better Auth tables keep Better Auth's default names and camelCase columns**: `user`,
  `session`, `account`, `verification`, `organization`, `member`, `invitation`, `team`,
  `teamMember`, `passkey`, `ssoProvider`. Our own tables are snake_case.
- **Tenant roles** are Better Auth organization roles `tenant_admin` and `tenant_user` (D18).
- **Encrypted columns** hold `KeyRing.encrypt` output; never filter SQL on them. Lookups go
  through blind-index columns (`emailIndex`, `domainIndex`).
- **Tokens and codes** are stored only as SHA-256 hex (`sha256Hex` in `keys-api.ts`, D49).
- **Ids**: `crypto.randomUUID()`. Slugs: 10 characters of base32 without look-alikes (D8).
- **Times**: unix milliseconds in our tables unless a column name says `_s`.
- **Errors**: throw `HTTPException` from `hono/http-exception` for 4xx; `app.onError` logs the
  rest and answers `{ error: 'internal_error' }`.
- **Validation**: zod on every request body.
- **Audit**: every state change calls `auditPlatform` and/or `auditOrg` (D40).
- Cross-Worker calls only through `src/shared/contracts.ts`.

## Migrations

Numbered by area so they can be written in parallel; never edit one after it has been applied
anywhere but locally.

| File | Area |
|---|---|
| `0001_auth.sql` | Better Auth tables (generated) plus our columns on them |
| `0002_keys.sql` | `data_keys` |
| `0003_platform.sql` | `platform_roles`, `platform_settings`, `tiers`, `registration_codes`, `confirmations`, audit logs |
| `0004_policies.sql` | `org_login_policies`, `instance_login_policies`, `org_domains` |
| `0005_instances.sql` | `instances`, `instance_teams`, `heartbeats`, `cron_runs` |
| `0006_identity.sql` | `gate_codes` |
| `0007_account.sql` | `passkey.lastUsedAt` (set by the passkey sign-in hook) |
| `0008_platform.sql` | `registration_codes.note` and `uses_total`; `worca_releases` (replaces the `worca_released_versions` settings list) |
| `0009_support.sql` | `user.registrationCodeId`; `support_requests` (two-person sign-in reset) |
| `0010_ops.sql` | `instance_ops` (operation progress); `instances.health_since` |
| `0011_keys.sql` | `data_keys.master_id`, `rotated_at`, `rotated_by`; `key_rotation_jobs`; the `audit_org` update trigger now lets the re-encryption job rewrite `details` |
| `0012_mail.sql` | `mail_daily`, `mail_messages` |
| `0014_security.sql` | `ssoProvider.createdAt` |
| `0015_support_fixes.sql` | `user.disabledBy`, `user.disabledByRole` (who disabled an account, for the enable rule) |
| `0017_newsletter.sql` | `newsletter_subscribers`, `newsletter_issues` (D70) |
| `0022_remote_access.sql` | `instances.terminal_remote`, `actions_remote`, `remote_pending` (D72) |
| `0023_egress_policy.sql` | `org_egress_policies`; `instances.egress_mode`, `egress_hosts`, `egress_version`, `egress_pending` (D73) |
| `0027_release_enrollment.sql` | `worca_releases.source`, `withdrawn_at`, `withdrawn_by`, `withdrawn_reason`; `release_holds` (D77) |

`0013` is unused: there is no such file, and the sequence skips from `0012` to `0014`.
