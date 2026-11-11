# {{NAME_TEXT}}

A deployment of [`@worca/platform`](https://www.npmjs.com/package/@worca/platform), written by
`npm create @worca/platform`.

| Command | What |
|---|---|
| `npm run setup` | Cloudflare resources, secrets, migrations, deploy (safe to run again) |
| `npm run deploy` | migrations, then the gate, then the control plane (`-- --dry-run` bundles only) |
| `npm run dev` | the local stack with fake providers at http://app.localhost:8787 |
| `npm run smoke -- --env dev` | one instance end to end on the local stack |
| `npm run smoke -- --email you@example.com --inbox ./inbox.mjs` | the same on the deployed stack |
| `npm run admin -- you@example.com` | the first superadmin (uses `SETUP_TOKEN`) |
| `npm run secrets` | which secrets each Worker has; `-- set NAME` sets one |
| `npm run upgrade` | the latest `@worca/platform`, its changes, then deploy |

Files:

- `worca.config.ts`: this deployment's settings. Edit here, never the wrangler configs.
- `worca.resources.json`: Cloudflare ids `npm run setup` found or created. Commit it.
- `wrangler.*.jsonc`: generated from the two above.
- `.secrets.env`: the deployment's keys (mode 600, not committed). Keep a copy in a password
  manager: without `MASTER_KEY` no backup can be read.
- `branding/`: optional logo, favicon, colours (`docs/branding.md` in the same repository).

Full guide: `docs/deploy.md` in https://github.com/SinishaDjukic/worca-platform.
