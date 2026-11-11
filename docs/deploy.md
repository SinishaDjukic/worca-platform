# Deploying your own platform

How to run your own deployment of `@worca/platform`: the console, the control plane and the gate
on Cloudflare Workers, Worca instances on a compute provider (Railway built in). Plan for about an
hour, most of it account setup and DNS.

```sh
npm create @worca/platform my-platform   # answers: names, domains, ids (or flags, see below)
cd my-platform
npm run dev                              # try it locally first: fake providers, no accounts
npx wrangler login
npm run setup                            # Cloudflare resources, secrets, migrations, deploy
npm run admin -- you@example.com         # the first superadmin
npm run smoke -- --email you+smoke@example.com --inbox ./inbox.mjs   # one real instance, end to end
```

## Accounts

| Account | What for | Notes |
|---|---|---|
| **Cloudflare, Workers Paid** | The control plane, the gate, D1, KV, Durable Objects, Workflows | Workers Paid is required: Durable Objects and Workflows aren't on the free plan |
| **Two zones** on that account | One for the console (`app.example.com`), one for instances (`example-instances.net`) | Instances live at `<slug>.<instance domain>`. The console must not be on the instance domain: instances would be the same site as the console. The instance domain is the zone apex; the gate takes `*.<domain>`, the apex and `www` |
| **Railway, Pro** (or another compute provider) | One project per instance: Worca, its credential broker, cloudflared | A workspace only for this platform, with a workspace token. Hobby works for a trial; Pro for volumes over 5 GB and real customers |
| **Resend** | Sign-in codes, invitations, confirmations, newsletter | Verify the sender's domain (`mail.from` in `worca.config.ts`) before inviting anyone |

Optional: Cloudflare Turnstile (`TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`), Google and Microsoft
sign-in (client ids and secrets). Each switches on when its secrets are set (`npm run secrets -- set NAME`).

## Tokens and their scopes

| Token | Where | Scopes |
|---|---|---|
| Deploys | `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` in CI | Account: Workers Scripts, D1, Workers KV Storage, Workers Routes: Edit; Account Settings: Read. Zones (both): Zone: Read, DNS: Edit (custom domains), Workers Routes: Edit |
| `CF_API_TOKEN` (control plane secret) | `npm run setup` asks | Account › Cloudflare Tunnel › Edit; Zone › DNS › Edit and Zone › Zone › Read on the **instance** zone only. Nothing else: it lives in the control plane |
| `RAILWAY_TOKEN` | `npm run setup` asks | A workspace token of the platform's workspace (Railway: workspace settings → Tokens) |
| `RESEND_API_KEY` | `npm run setup` asks | Sending access, the sender's domain only |

`npm run setup` reads each credential from an environment variable of the same name, else asks;
skipped ones are listed at the end. `npm run secrets` shows what each Worker has.

## What setup does

1. Finds or creates the D1 database (`<name>-db-prod`; placed by `database.jurisdiction` or
   `database.location` in `worca.config.ts` when set, e.g. `{ jurisdiction: 'eu' }`) and two KV namespaces
   (`<name>-control-kv-prod`, `<name>-hosts-prod`); their ids go into `worca.resources.json`
   (commit it) and the wrangler configs.
2. Applies the migrations.
3. Generates the platform's own keys (`BETTER_AUTH_SECRET`, `MASTER_KEY`, `BLIND_INDEX_KEY`,
   `GATE_COOKIE_KEY`, `IDENTITY_SIGNING_JWK`, `SETUP_TOKEN`) only when neither `.secrets.env`
   nor the Worker has them, writes them to `.secrets.env` (mode 600, gitignored) first, then
   uploads them and the provider credentials over stdin.
4. Deploys the gate, then the control plane (its service binding needs the gate).

Run it again whenever you like: it creates nothing that exists and regenerates no key.

**Keep `.secrets.env` in a password manager.** `MASTER_KEY` encrypts tenant data: without it no
backup of the database can be read (D36). The keys can't be read back from Cloudflare.

## Costs

- Cloudflare Workers Paid: the monthly minimum covers a small deployment; Durable Object and
  Workflow usage beyond the included amounts is billed by use. Zones can stay on the Free plan.
- Railway: the plan fee plus each instance's CPU, memory and volume. Instances idle-suspend after
  24 hours without use, which is most of the saving.
- Resend: the free tier covers a small deployment's sign-in and notice mail.

Check each provider's current pricing; these change.

## Two things to know before you open it to others

**Railway's terms.** Railway's Acceptable Use Policy forbids "reselling compute resources". A
platform that gives each customer a dedicated instance can look like that. Sell Worca as a
product (seats, instances, features), not vCPU and memory, and ask Railway support to confirm in
writing that your use is fine on your plan before you take customers. Or use another compute
provider (docs/providers.md).

**The Public Suffix List (D12).** Until your instance domain is on the [Public Suffix
List](https://publicsuffix.org/submit/), browsers treat all instances as one site: only the gate
keeps their cookies and storage apart. Request it as soon as the domain is registered (it needs
more than two years of registration left and takes weeks to months to reach browsers).

## Day to day

| | |
|---|---|
| `npm run deploy` | after editing `worca.config.ts`: migrations, gate, control plane. `-- --dry-run` bundles only |
| `npm run upgrade` | the latest `@worca/platform`, its changes, then deploy. `-- --tag rc` for release candidates |
| `npm run smoke` | one instance end to end. Locally: `-- --env dev` against `npm run dev`. Deployed: `-- --email … --inbox ./inbox.mjs`, a module exporting `getMail(to)` that reads that address's mail (your mail provider's API); it creates a real instance and deletes it |
| `npm run secrets -- set NAME` | put one secret on the Worker that reads it (and keep it in `.secrets.env`) |
| `npm run configure` | regenerate the wrangler configs only |

## Creating a deployment in CI

Every question has a flag and an environment variable; `--yes` never asks:

```sh
npm create @worca/platform my-platform -- --yes \
  --instance-domain example-instances.net --app-origin https://app.example.com \
  --account-id <32 hex> --zone-id <32 hex> --compute railway --railway-workspace <id> \
  --mail-from 'Example <no-reply@example.com>' --features newsletter,accessRequests,tiers
```

`npm create @worca/platform -- --help` lists them with their variables (`WORCA_APP_ORIGIN`, …).
In an existing deployment folder, `--repair` writes only the files that are missing.
