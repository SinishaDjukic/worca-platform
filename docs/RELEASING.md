# Releasing

How the platform's packages get published, and what has to be configured — once per
package, and occasionally afterwards — for that to work.

This is worca-cc's release process ([worca-cc `docs/RELEASING.md`](https://github.com/SinishaDjukic/worca-cc/blob/dev/docs/RELEASING.md)),
changed only where this repo differs: it publishes **two packages from one tag**, and it has
no container image or browser extension. When worca-cc's process changes, this file changes
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
| `@worca/create-platform` | `packages/create-platform/` | `worca-platform-v*` (the same tag) | `.github/workflows/release-npm.yml` (the same run) |

The two packages share **one version and one tag**: `create-platform@x` scaffolds
deployments that depend on `platform@^x`, so they are always released together.
The tag prefix is built the way worca-cc builds `worca-app-v*` from `@worca/app`.

---

## 2. Tag naming

```
worca-platform-v1.0.0        GA release
worca-platform-v1.0.0-rc.1   release candidate
```

Rules:

- **`worca-platform-v<version>`**, where `<version>` is exactly the string in
  **both** packages' `package.json`. The workflow refuses to publish when any of
  the three disagree, so a typo fails in CI rather than shipping the wrong number.
- The `v` is part of the prefix, not the version. `worca-platform-v1.0.0`
  publishes `1.0.0`, never `v1.0.0`.
- Pre-releases use the `-rc.N` suffix, counting from 1. The workflow keys the
  npm dist-tag off the literal substring `-rc.`, so `-beta.1` or `-rc1` will be
  published as `latest`. Use `-rc.N`.
- Versions are written by `npm version` in both workspaces — see §4.

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
| Allowed actions | `npm publish` only |

Leave **`npm stage publish`** unchecked. The OIDC credential can publish and
nothing else — it cannot move a dist-tag. See §5 for what that means for `rc`.

The registration covers **one package only**: `@worca/platform`'s publisher
grants nothing to `@worca/create-platform`, even though one workflow publishes
both. Register both.

### 3.5 Lock the bootstrap credential down

Once §3.4 is in place, CI no longer needs a token. Revoke any granular token
used in §3.3 (npmjs.com → Access Tokens), and set each package's publishing
access to **"Require two-factor authentication or trusted publishing"** so a
leaked token cannot publish it.

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
version in the same commit.

### 4.1 Release candidates

`npm version` writes both workspaces when given both; it never tags here
(`--no-git-tag-version`), and you create the prefixed tag yourself:

```bash
# first RC of a new line — `latest` is untouched, users stay on the old version
npm version 1.1.0-rc.1 --no-git-tag-version -w @worca/platform -w @worca/create-platform
git commit -am "chore(release): worca-platform 1.1.0-rc.1"
git tag -a worca-platform-v1.1.0-rc.1 -m "worca-platform 1.1.0-rc.1"
git push origin HEAD && git push origin worca-platform-v1.1.0-rc.1

# subsequent RCs — `prerelease` walks -rc.2, -rc.3, ...
npm version prerelease --no-git-tag-version -w @worca/platform -w @worca/create-platform >/dev/null
V=$(node -p "require('./packages/platform/package.json').version")
git commit -am "chore(release): worca-platform $V"
git tag -a "worca-platform-v$V" -m "worca-platform $V"
git push origin HEAD && git push origin "worca-platform-v$V"
```

Testers opt in with:

```bash
npm create @worca/platform@rc my-deploy     # scaffolds with @worca/platform@^<that rc>
npm install @worca/platform@rc              # in an existing deployment
```

### 4.2 GA release

```bash
npm version 1.1.0 --no-git-tag-version -w @worca/platform -w @worca/create-platform
git commit -am "chore(release): worca-platform 1.1.0"
git tag -a worca-platform-v1.1.0 -m "worca-platform 1.1.0"
git push origin HEAD && git push origin worca-platform-v1.1.0
```

The workflow publishes both under `latest`. It does **not** touch `rc` — see §5.

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
- **Verify after the fact**, for both packages:

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
| One package published, the other failed | Re-run the failed job: the workflow skips a version that is already on npm, so the published one is not touched |
| `provenance generation failed` / repository mismatch | `repository.url` does not point at the building repo |
| `You cannot publish over the previously published versions` | The version was already published — bump it; it cannot be reused |
| Workflow never starts | Only the commit was pushed, not the tag, or the tag does not match `worca-platform-v*` |
