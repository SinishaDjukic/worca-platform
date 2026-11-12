> [!NOTE]
> This project will soon move to a new organization: [github.com/worca-org](https://github.com/worca-org).

# Contributing to the Worca platform

Thanks for your interest in contributing! This document covers developing the
platform from source: setup, testing, the PR workflow, and how releases are
cut.

Everyone taking part in this project is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to
[conduct@worca.dev](mailto:conduct@worca.dev).

> Just want to **run** a platform? You don't need this repo at all: start from
> `npm create @worca/platform my-deploy`, as described in
> [Deploying your own platform](docs/deploy.md).

This repository publishes two npm packages, each released on its own line:

| Package | Source | What it is |
| --- | --- | --- |
| [`@worca/platform`](https://www.npmjs.com/package/@worca/platform) | `packages/platform/` | The control plane, the gate, the console, the providers, the deployment CLI (`worca-platform`) |
| [`@worca/create-platform`](https://www.npmjs.com/package/@worca/create-platform) | `packages/create-platform/` | `npm create @worca/platform`: writes a new deployment |

Worca itself, the product the platform hosts, lives in
[worca-cc](https://github.com/SinishaDjukic/worca-cc). What an instance is made
of and what the platform sets on it is its
[instance contract](https://github.com/SinishaDjukic/worca-cc/blob/dev/docs/instance-contract.md).

## Development setup

Requirements:

- **Node.js >= 22.19.0**. Run `nvm use` to pick up the bundled `.nvmrc`
  (Node 24): CI and the release run that major, and CI's tests also run the
  exact floor and the newest LTS.
- No Cloudflare, Railway or Resend account. The local stack runs both Workers
  in `wrangler dev` with fake compute and edge providers and a stub instance
  server.

```bash
git clone https://github.com/SinishaDjukic/worca-platform.git
cd worca-platform     # the default branch is dev
npm install
npm run keys:dev      # writes .dev.vars (both Workers share it)
npm run dev           # stub (:9100), control plane (:8787), gate (:8798)
```

The console is at `http://app.localhost:8787`; instances at
`http://{slug}.run.localhost:8798`. Mail isn't sent: it is captured at
`http://app.localhost:8787/__dev/mail?to=<email>`. More in
[Development](docs/development.md).

## Testing

```bash
npm run check          # TypeScript
npm test               # unit tests (vitest in workerd) and the script tests
npm run test:e2e       # needs `npm run dev` running; E2E_FAST=1 on both for short gate timers
npm run test:ui        # Playwright against the running stack
npm run test:package   # pack both packages, scaffold a deployment, set it up against a
                       # fake wrangler, dry-run deploy, run it, smoke it
```

CI runs all of them on every pull request and every push to `dev`. Run the
ones your change touches locally before opening or updating a PR, and say so
in the PR description.

## Project structure

```
packages/platform/         @worca/platform: src/ (control plane, gate, shared), migrations/, ui/,
                           cli/ (worca-platform), smoke/, stub/
packages/create-platform/  @worca/create-platform: lib/scaffold.mjs, templates/
dev.config.ts              the contributors' stack; the root wrangler.*.jsonc are generated from it
scripts/                   dev stack, keys, mail preview, pack and package tests
test/                      unit/, e2e/, ui/, scripts/
docs/                      design, decisions, deploying, providers, branding, releasing
```

## Compute providers

A new compute provider (Kubernetes, Fly, Azure Container Apps, …) implements
the interface in [Compute providers](docs/providers.md) and passes the
conformance checks exported as `@worca/platform/testing`. Providers can live in
their own package; one in this repo needs the checks in `test/unit/` and a
fake-HTTP test like Railway's.

## Pull request workflow

- Branch from `dev`, open the PR with **base `dev`**.
- PRs are integrated with **merge commits** (no squash, no rebase-merge).
- Once a PR is under review, **never rebase or force-push it** — reviewers'
  context must stay valid. To pick up newer `dev`, **merge `dev` into your
  branch** instead.
- Stacked PRs are fine: base the child PR on the parent's branch
  (`--base feat/<parent>`) and retarget it to `dev` after the parent merges.
- Run the tests locally first (see [Testing](#testing)); CI runs too.
- A change to the database adds a new migration
  (`packages/platform/migrations/NNNN_description.sql`); released migrations
  are never edited or renamed (see [Versioning](README.md#versioning)).
- Add an entry to [CHANGELOG.md](CHANGELOG.md) under **Unreleased**.

## Releasing

Releases are **tag-driven**: pushing an annotated `worca-platform-v<version>`
or `worca-create-platform-v<version>` tag triggers the GitHub Actions workflow
that tests and publishes that package to npm with provenance. Nobody runs
`npm publish` by hand for an established package. Maintainers run
`/worca-release` in Claude Code, which asks which package to release.

See [`docs/RELEASING.md`](docs/RELEASING.md) for the full process, including
release candidates (`-rc.N`), dist-tags, and the one-time setup for new
package names.

## Keeping in step with worca-cc

This project follows worca-cc's conventions: the license, the contributor
terms, the code of conduct, the security policy, the PR and issue templates and
the release process. When worca-cc changes one of them, the same change is made
here.

## Contributor terms

Opening a pull request means you accept the
[Developer Certificate of Origin 1.1](DCO) (DCO) for that contribution. In
short, you confirm that you have the right to submit the work.

- **License.** Your contribution is accepted under the project's
  [MIT License](LICENSE).
- **No extra setup.** You don't need a `Signed-off-by` line, `git commit -s`,
  or any special Git setup. Opening the pull request is enough.
- **AI help is fine.** AI agents may help write a contribution. The person who
  opens the pull request, or on whose behalf it is opened, is responsible for
  it.
- **Only submit what you may submit.** Don't submit code you don't have the
  right to submit.
- **Employers and others.** If your employer or anyone else may hold rights in
  your contribution, get their permission before you submit it.
- **Unclear origin.** If the origin or licensing of a contribution is unclear,
  maintainers may ask for more information, request changes, or remove it.

This section explains how the project accepts contributions. It is not legal
advice.
