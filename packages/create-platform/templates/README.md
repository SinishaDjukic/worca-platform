# Deployment templates

What `@worca/create-platform` writes into a new deployment. `{{NAME}}` placeholders are replaced
when the deployment is written; values marked literal are inserted as TypeScript literals.

| File | Written as |
|---|---|
| `package.json` | `package.json`: scripts call `worca-platform` (the CLI in `@worca/platform`) |
| `worca.config.ts` | `worca.config.ts` |
| `src/control.ts`, `src/gate.ts` | the Workers' entry modules (class names are permanent) |
| `tsconfig.json` | `tsconfig.json` |
| `gitignore` | `.gitignore` (npm drops files named `.gitignore` from packages) |
| `DEPLOYMENT.md` | `README.md` |

| Placeholder | Value |
|---|---|
| `{{PACKAGE_NAME}}` | npm name of the deployment folder |
| `{{NAME_TEXT}}` | the deployment name as plain text |
| `{{PLATFORM_VERSION}}` | `@worca/platform` range, `^` + this package's version (or `--platform-version`) |
| `{{NAME}}`, `{{APP_ORIGIN}}`, `{{INSTANCE_DOMAIN}}`, `{{MAIL_FROM}}`, `{{COMPUTE}}` | literal: the answers, as quoted strings |
| `{{FEATURES}}` | literal: `{ newsletter: …, accessRequests: …, tiers: … }` |

The wrangler configs aren't templates: `worca-platform configure` generates them from
`worca.config.ts` and `worca.resources.json` (ids `npm run setup` finds or creates).
