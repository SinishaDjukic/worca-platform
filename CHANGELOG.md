# Changelog

## Unreleased

## @worca/platform 1.0.0-rc.1, @worca/create-platform 1.0.0-rc.1

The first release of the Worca platform as open source: the management platform behind hosted
Worca (control plane, gate, console, providers), packaged for anyone to deploy on Cloudflare.

### Packages

- `@worca/platform`: the control plane and gate Workers (`createControl`, `createGate`), the
  console, the D1 migrations, the compute and edge providers, the deployment CLI
  (`worca-platform`: `setup`, `deploy`, `dev`, `smoke`, `secrets`, `admin`, `upgrade`) and the
  portable smoke test (`@worca/platform/smoke`).
- `@worca/create-platform`: `npm create @worca/platform my-deploy` writes a deployment, asks for
  (or reads from flags and environment variables) its domains, Cloudflare ids, compute provider
  and mail sender, and installs it. `npm run setup` then creates the D1 database and KV
  namespaces, generates and uploads the secrets, applies the migrations and deploys both Workers.
  Re-running it changes nothing that exists.

### Configuration

- One typed, validated `worca.config.ts` per deployment: names, domains, mail, providers,
  branding, gate timings, optional modules, instance images and the D1 placement
  (`database.jurisdiction` / `database.location`).
- Optional modules, off by default: the newsletter, public access requests, and tiers (plans with
  instance and member limits, edited in the console). A module that is off answers 404 and is not
  shown in the console.
- Branding: product and service names, logo, mark, favicon, mail logos and colours from the
  deployment's `branding/` folder (docs/branding.md).

### Providers

- Compute providers describe themselves (sizes, regions, capacity, status, egress enforcement,
  settings fields the console renders) and are registered through `definePlatform`. Built in:
  `railway` and `fake`. Edge: `cloudflare` and `fake`. Conformance checks for third-party
  providers: `@worca/platform/testing` (docs/providers.md).

### Supported Worca versions

- Instances run `@worca/app` 1.9.0 or newer (the instance image the platform deploys).
