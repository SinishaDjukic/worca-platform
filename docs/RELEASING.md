# Releasing

How the platform's packages get published, and what has to be configured — once per
package, and occasionally afterwards — for that to work.

This is worca-cc's release process ([worca-cc `docs/RELEASING.md`](https://github.com/SinishaDjukic/worca-cc/blob/dev/docs/RELEASING.md)),
changed only where this repo differs: it publishes **two packages, each on its own release
line**, and it has no container image or browser extension. `/worca-release` (in
`.claude/skills/`) runs the procedure in §4. When worca-cc's process changes, this file changes
with it.

Everything here is **tag-driven**: you never run `npm publish` by hand for an
established package. You push a git tag; a GitHub Actions workflow validates,
tests, and publishes it with an OIDC-signed provenance attestation. The only
manual publish in this document is the **bootstrap** of a brand-new package
name, and it exists solely to break a chicken-and-egg problem described below.

---

## 1. Releasables in this repo

| Package | Source | Tag prefix | Workflow |
| --- | --- | --- | --- |
| `@worca/platform` | `packages/platform/` | `worca-platform-v*` | `.github/workflows/release-npm.yml` |
| `@worca/create-platform` | `packages/create-platform/` | `worca-create-platform-v*` | `.github/workflows/release-npm.yml` (the same file) |

Each package has **its own version and its own tag**, so either can be released
without the other. Tag prefixes are built the way worca-cc builds `worca-app-v*`
from `@worca/app`. One workflow file serves both prefixes, and both packages'
trusted publishers name it.

The link between them is `worca.platformRange` in create-platform's
`package.json`: the `@worca/platform` range a new deployment depends on (for
example `^1.0.0-rc.1`). A create-platform release refuses to publish when that
range matches no published `@worca/platform`, so when both are released, the
platform goes first.

---

## 2. Tag naming

```
worca-platform-v1.0.0                @worca/platform GA release
worca-platform-v1.0.0-rc.1           @worca/platform release candidate
worca-create-platform-v1.0.0-rc.1    @worca/create-platform release candidate
```

Rules:

- **`worca-<package>-v<version>`**, where `<version>` is exactly the string in
  that package's `package.json`. The workflow refuses to publish when they
  disagree, so a typo fails in CI rather than shipping the wrong number.
- The `v` is part of the prefix, not the version. `worca-platform-v1.0.0`
  publishes `1.0.0`, never `v1.0.0`.
- Pre-releases use the `-rc.N` suffix, counting from 1. The workflow keys the
  npm dist-tag off the literal substring `-rc.`, so `-beta.1` or `-rc1` will be
  published as `latest`. Use `-rc.N`.
- Versions are written by `npm version -w <package>` — see §4.

---

## 3. One-time setup for a NEW package

Do this once, when introducing a package name that has never been published.
Both packages here went through §3.3 on 2026-11-11 (`0.0.1` placeholders).

### 3.1 The npm scope

`@worca` is an **organization** scope on npmjs.com and already exists, so a new
package under it needs no scope-level work.

Note that scoped packages default to **restricted** (private), which fails on a
free org. Two independent guards, and you want both:

- `"publishConfig": { "access": "public" }` in each `package.json` — covers manual
  publishes
- `--access public` on the `npm publish` lines in the workflow — covers CI

### 3.2 `repository` must match the building repo

`npm publish --provenance` refuses to run unless `package.json` `repository.url`
points at the same GitHub repository as the workflow generating the
attestation. Both packages live in subdirectories, so each also sets
`directory`:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/SinishaDjukic/worca-platform.git",
  "directory": "packages/platform"
}
```

A stale `repository` field is the single most common cause of a first release
failing at the very last step. When the repo moves to
[github.com/worca-org](https://github.com/worca-org), change it in both packages
and in both trusted publishers (§6).

### 3.3 Bootstrap the name (the one manual publish)

npm's Trusted Publishing is configured **per package**, under that package's
Settings tab — which means the package has to exist before you can point an
OIDC publisher at it. So the first version goes up with a token:

```bash
npm login                       # or: set a granular token in ~/.npmrc
npm publish --access public     # version 0.0.1, no --provenance
```

That first tarball is unattested and that is expected; it exists to claim the
name. Publish `0.0.1` — a deliberately inert placeholder — rather than a version
anyone might install.

### 3.4 Configure the trusted publisher on npmjs.com

For **each** package: npmjs.com → the package → **Settings** → **Trusted
Publisher** → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization / user | `SinishaDjukic` |
| Repository | `worca-platform` (the GitHub repo name, as-is) |
| Workflow filename | `release-npm.yml` |
| Environment | *(leave empty unless the job declares one)* |
| Label | `release-npm` |
| Allowed actions | tick **Allow npm publish**; leave **Allow npm dist-tag** unticked |

`npm stage publish` is always allowed and cannot be unticked. This is the setup
`@worca/app` uses. The OIDC credential can publish and nothing else — it cannot
move a dist-tag. See §5 for what that means for `rc`. A new connection shows
"Pending validation" until the first publish through it, which has to happen
within about two days.

The registration covers **one package only**: `@worca/platform`'s publisher
grants nothing to `@worca/create-platform`, even though one workflow publishes
both. Register both.

### 3.5 Lock the bootstrap credential down

Once §3.4 is in place, CI no longer needs a token. Revoke any granular token
used in §3.3 (npmjs.com → Access Tokens), and set each package's publishing
access the way `@worca/app` has it: **"Require two-factor authentication or a
granular access token with bypass 2fa enabled"**. Trusted publishing works with
either option.

### 3.6 GitHub side

Nothing to configure beyond the workflow file itself. There is no `NPM_TOKEN`
secret in this repo and there should not be one. What the publishing job needs:

```yaml
permissions:
  id-token: write   # mints the OIDC token npm verifies
  contents: read
```

`id-token: write` must be on the **job**, not only at workflow level.

### 3.7 Checklist

- [ ] `name`, `version`, `license`, `repository` (with `directory`), `publishConfig.access` in both packages
- [ ] `files` allowlists verified with `npm pack --dry-run` in both packages (no tests, `.dev.vars`, `.wrangler`, deployment configs)
- [ ] Release workflow added, with its tag prefix and `id-token: write`
- [ ] Bootstrap publish of `0.0.1` done for both
- [ ] Trusted publisher registered on npmjs.com for both (repo + workflow filename)
- [ ] Bootstrap token revoked; publishing access requires 2FA or trusted publishing
- [ ] First tag-driven release published with provenance, for both

---

## 4. Regular release procedure

Assumes §3 is done. Release commits land on `dev` itself: the version bump has
to be on the released branch, because the next release computes its number from
`package.json`.

Move the **Unreleased** entries of `CHANGELOG.md` under a heading for the
release in the same commit: `## @worca/platform 1.1.0-rc.1`, or, when both go
out together, `## @worca/platform 1.1.0-rc.1, @worca/create-platform 1.1.0-rc.1`.

`/worca-release --package:platform|create-platform|both --rc|--stable
[--version:…]` does all of §4; below is what it runs.

### 4.1 One package

`npm version` never tags here (`--no-git-tag-version`); you create the
prefixed tag yourself. For `@worca/platform`:

```bash
npm version 1.1.0-rc.1 --no-git-tag-version -w @worca/platform
git add packages/platform/package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): @worca/platform 1.1.0-rc.1"
git tag -a worca-platform-v1.1.0-rc.1 -m "@worca/platform 1.1.0-rc.1"
git push origin HEAD && git push origin worca-platform-v1.1.0-rc.1
```

For `@worca/create-platform` the same with `-w @worca/create-platform`,
`packages/create-platform/package.json` and the tag
`worca-create-platform-v<version>`. Check first that its `worca.platformRange`
matches a published `@worca/platform`
(`npm view "@worca/platform@<range>" version`); the workflow refuses it
otherwise.

Testers opt in with:

```bash
npm create @worca/platform@rc my-deploy     # create-platform's rc, scaffolding its platformRange
npm install @worca/platform@rc              # in an existing deployment
```

### 4.2 Both packages

Release `@worca/platform` first and wait for its workflow to publish it. Then
point create-platform at it and release create-platform:

```bash
# 1. the platform, as in §4.1; wait until `npm view @worca/platform@1.1.0 version` answers
# 2. create-platform, in a second commit
npm version 1.1.0 --no-git-tag-version -w @worca/create-platform
npm pkg set worca.platformRange='^1.1.0' -w @worca/create-platform
git add packages/create-platform/package.json package-lock.json
git commit -m "chore(release): @worca/create-platform 1.1.0"
git tag -a worca-create-platform-v1.1.0 -m "@worca/create-platform 1.1.0"
git push origin HEAD && git push origin worca-create-platform-v1.1.0
```

A GA release publishes under `latest` and does **not** touch `rc` — see §5.

> **Do not use `npm version minor` to close out an RC line.** From
> `1.1.0-rc.3`, semver's rules make `major`, `minor`, and `patch` all collapse
> to `1.1.0`. Always type the target version literally.

### 4.3 Rules that are not negotiable

- **Versions are permanent.** A published `1.1.0-rc.2` can never be reused, even
  after unpublishing — the number is burned. Burn RC numbers freely; never try
  to republish over one.
- **Release from a clean tree.** `--no-git-tag-version` skips npm's own
  clean-tree check, so this one is on you: the tag must describe exactly what
  CI will build.
- **Push the tag explicitly, and make it annotated.** `git push` alone pushes
  no tags. Use `git tag -a … -m …` plus `git push origin <tag>`, then verify with
  `git ls-remote --tags origin`.
- **Verify after the fact**, for each package released:

  ```bash
  npm view @worca/platform dist-tags
  npm view @worca/platform@<version> dist.attestations
  npm view @worca/create-platform dist-tags
  npm view @worca/create-platform@<version> dist.attestations
  ```

  A missing `attestations` field means the tarball published without
  provenance — treat it as a misconfiguration and investigate before anyone
  installs it.
- **Release notes** are GitHub's generated notes, counted from the previous
  **stable** release, for an RC as well as a stable release.

### 4.4 Trying a change before a release

`npm run pack:platform` builds and packs `@worca/platform` and prints the
tarball path. In a deployment, `npm i <path>/worca-platform-<version>.tgz`
installs exactly what npm would ship; deploy it to a non-production environment
and run `npm run smoke`. Don't commit the tarball dependency. Production runs
published releases only.

---

## 5. dist-tags and rc semantics

A dist-tag is a **mutable named pointer to one published version**. Only
`latest` has behaviour wired into the npm client: bare `npm install` resolves
it, and `npm publish` writes it **unless** `--tag` is passed.

| Tag | Meaning |
| --- | --- |
| `latest` | Stable. What a bare `npm install` (and a bare `npm create @worca/platform`) gives you. |
| `rc` | The **most recent release candidate**. Ahead of `latest` while a line is baking; behind it in the window between a GA release and the next RC. |

`rc` sitting behind `latest` for a while is expected: the OIDC credential is
granted `npm publish` and nothing else, so no workflow can promote `rc` on a GA
release. Cutting the next RC moves it ahead again.

- **Semver ranges never match pre-releases** of another core version. `^1.0.0`
  will not resolve to `1.1.0-rc.1`.
- **`npm publish` does not detect pre-releases.** Publishing `1.1.0-rc.1`
  without `--tag` moves `latest` to it. This is why the workflow derives the
  dist-tag from the git tag instead of trusting anyone to remember a flag.

---

## 6. Configuration that may be needed later

| Change | What it requires |
| --- | --- |
| **Renaming the workflow file** | Update the workflow filename in **both** packages' trusted publisher settings. |
| **Renaming or transferring the repo** (the move to worca-org) | Update `repository.url` in both `package.json` files *and* both trusted publishers' org/repo fields. Both are checked. |
| **Moving the job into a GitHub Environment** | Add the environment name to both trusted publisher configs. |
| **Adding another package** | A full pass of §3 for it. If it is released on its own line, it gets its own tag prefix and workflow. |
| **npm/Node upgrade in CI** | Trusted Publishing needs npm >= 11.5.1 (bundled with Node >= 24.5). The workflow asserts this. |
| **Adding a maintainer** | npmjs.com → org → members, then grant the team write access to both packages. |
| **A release that must go out with the pipeline broken** | Mint a short-lived granular token scoped to the packages, publish locally with `--access public`, revoke it immediately. Do not add a long-lived `NPM_TOKEN` secret to the repo. |
| **Deprecating a bad version** | `npm deprecate @worca/platform@<version> "<reason>"` (and the same for create-platform). Prefer this to unpublishing. |

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `npm error code ENEEDAUTH` in CI | Trusted publisher not registered for that package, or workflow filename/repo mismatch, or missing `id-token: write` on the job |
| `404 Not Found - PUT https://registry.npmjs.org/@worca%2f…` after "Signed provenance statement" | That package has no trusted publisher any more. Register it again (§3.4), then re-run the failed job: nothing was published for it |
| create-platform refused: `@worca/platform@<range> matches no published version` | Release `@worca/platform` first (§4.2), or fix `worca.platformRange`; the create-platform tag is burned, so bump to the next version |
| `provenance generation failed` / repository mismatch | `repository.url` does not point at the building repo |
| `You cannot publish over the previously published versions` | The version was already published — bump it; it cannot be reused |
| Workflow never starts | Only the commit was pushed, not the tag, or the tag does not match `worca-platform-v*` |
