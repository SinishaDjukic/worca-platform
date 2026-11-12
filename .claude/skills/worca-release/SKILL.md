---
name: worca-release
description: Cut a release candidate or a stable release of @worca/platform, @worca/create-platform, or both — bumps the version, commits, tags `worca-platform-v<version>` / `worca-create-platform-v<version>`, and pushes so CI publishes to npm with provenance. Asks which package when none is given. Triggers on "cut a release", "cut an RC", "release candidate", "bump RC", "stable release", "worca-release", or any request to release @worca/platform or @worca/create-platform.
---

# Release @worca/platform and @worca/create-platform

worca-cc's `/worca-release`, changed only for two packages on separate release
lines. The git tag is the trigger and the source of truth. You bump the
version, tag it, and push; `.github/workflows/release-npm.yml` validates,
tests, and publishes with an OIDC provenance attestation. **Never run
`npm publish` by hand** — a manual publish burns the version number and
produces an unattested tarball.

The rules behind this procedure live in `docs/RELEASING.md`. Read it when
something here doesn't fit; do not restate its contents back to the user.

| Package | Directory | Tag |
| --- | --- | --- |
| `@worca/platform` | `packages/platform/` | `worca-platform-v<version>` |
| `@worca/create-platform` | `packages/create-platform/` | `worca-create-platform-v<version>` |

Each package has its own version. They meet in one place:
`worca.platformRange` in `packages/create-platform/package.json`, the
`@worca/platform` range a scaffolded deployment depends on. The workflow
refuses a create-platform release whose range matches no published
`@worca/platform`.

**Usage:**

- `/worca-release` — print status and stop
- `/worca-release --package:<platform|create-platform|both> --rc` — cut the next release candidate
- `/worca-release --package:<…> --stable` — close out the current RC line
- `/worca-release --package:<…> --version:micro` — stable release from stable, patch bump
- `/worca-release --package:<…> --version:minor` — stable release from stable, minor bump

`--version:` also accepts a **literal target** — `--version:1.0.0` — which
pairs with either mode and says the number outright instead of relying on
inferred arithmetic:

- `--rc --version:1.0.0` → `1.0.0-rc.1` (suffix appended)
- `--stable --version:1.0.0` → `1.0.0`

Prefer the literal form for any jump the defaults would not reach — a major
release, opening a patch line as an RC, or the first release after the `0.0.x`
placeholders. See Step 2 for which combinations are legal.

**When `--package:` is missing** but a mode is given, ask which package —
`platform`, `create-platform`, or `both` — with AskUserQuestion, and show each
package's current version and dist-tags in the question so the answer is
informed. Do not default. When the mode is missing too, run Step 0.

With `--package:both`, the mode and `--version:` apply to each package, and
each gets its own computed version (they may differ). The platform is released
first, end to end, then create-platform (Step 4b).

---

## Step 0: No-args mode (status)

If invoked with **no arguments**, print the usage above, then report, for each
package:

```bash
node -p "require('./packages/platform/package.json').version"
node -p "require('./packages/create-platform/package.json').version"
node -p "require('./packages/create-platform/package.json').worca?.platformRange"
npm view @worca/platform dist-tags
npm view @worca/create-platform dist-tags
git tag --sort=-v:refname | grep -E '^worca-(create-)?platform-v' | head -10
```

**Stop here.** Do not release. Tell the user to re-invoke with arguments.

---

## Step 1: Preconditions

All five must hold. Stop and report on any failure — never "fix it and
continue".

```bash
# 1. This is the public worca-platform repo, on dev. A release from anywhere else (the private
#    platform branch, a fork) would tag a commit the workflow never sees.
git remote get-url origin | grep -q 'SinishaDjukic/worca-platform' || { echo "ERROR: not the worca-platform repo"; exit 1; }
[ "$(git branch --show-current)" = "dev" ] || { echo "ERROR: not on dev"; exit 1; }

# 2. Clean working tree — the tag must describe exactly what CI will build.
[ -z "$(git status --porcelain)" ] || { echo "ERROR: working tree is dirty"; exit 1; }

# 3. The release workflow MUST exist in the commit being tagged, and know both tag prefixes.
#    Tag-triggered workflows run from the tagged ref — tagging a commit without it fires nothing.
git show HEAD:.github/workflows/release-npm.yml 2>/dev/null | grep -q 'worca-create-platform-v' \
  || { echo "ERROR: release-npm.yml is missing or predates per-package tags"; exit 1; }

# 4. Local branch is pushed and current, so the tag points at a commit that exists upstream.
git fetch --quiet origin
[ -z "$(git log @{u}..HEAD --oneline 2>/dev/null)" ] || { echo "ERROR: unpushed commits — push first"; exit 1; }
[ -z "$(git log HEAD..@{u} --oneline 2>/dev/null)" ] || { echo "ERROR: dev is behind origin/dev — pull first"; exit 1; }

# 5. Tests pass — what the release workflow runs, minus the local-stack suites. Failing here costs
#    minutes; failing there costs a permanent tag.
npm ci
npm run keys:dev
npm run check
npm test
npm run test:package
```

If any of the tests fail, **stop**. Report which tests failed. A release cannot
proceed past a red suite — the workflow will refuse it anyway.

---

## Step 2: Compute the new version (per package)

For each package being released, read its current version:

```bash
node -p "require('./packages/<dir>/package.json').version"
```

`--version:` carries one of two things, and which one decides everything
below:

- a **keyword** — `micro` or `minor` — meaning "infer the number"
- a **literal target** — anything matching `X.Y.Z` — meaning "use this number"

The current version decides which flags are legal. Reject the wrong one rather
than silently ignoring it — a flag that cannot change the outcome must not be
accepted as if it did.

### With a literal target

The target is the release line. It is honoured as given; no arithmetic.

- `--rc --version:1.0.0` → `1.0.0-rc.1`, appending the suffix. If the current
  version is already on that line (`1.0.0-rc.2`), continue it: `1.0.0-rc.3`.
  Never restart a line's numbering at `rc.1` — that number is burned.
- `--stable --version:1.0.0` → `1.0.0` exactly.

Two rejections, both hard:

1. **The target must be strictly greater than every version on npm** for that
   package (`npm view @worca/<dir> versions --json`; this includes the `0.0.1`
   placeholder and the `0.0.0-stage` holding version). Reject anything equal
   or lower: the number is burned and the publish would fail after the tag
   exists.
2. **`--stable --version:X.Y.Z` while on a pre-release of a *different* line**
   — e.g. on `1.0.0-rc.3` with `--version:2.0.0`. Stop and ask. Shipping a
   number the RCs never rehearsed defeats the point of having cut them.

`--version:<literal>` requires `--rc` or `--stable`. On its own it does not say
which one you mean; do not guess.

### Without a target

**`--rc`** (semver pre-release, `X.Y.Z-rc.N`) — legal from either state:

- Already a pre-release → increment N: `1.0.0-rc.4` → `1.0.0-rc.5`
- Stable → open the next **minor** line as an RC: `1.0.0` → `1.1.0-rc.1`

A package still on its `0.0.x` placeholder has no real line yet: stop and ask
for a literal target (`--version:1.0.0`) rather than inferring `0.1.0-rc.1`.

**`--stable`** — legal **only from a pre-release**. Strip the suffix; that is
the release:

- `1.1.0-rc.3` → `1.1.0`

If the current version is already stable, stop: there is no RC line to close
out, and the user wants a keyword or a literal target.

**`--version:micro` / `--version:minor`** — legal **only from a stable
version**:

- `micro`: `1.1.0` → `1.1.1`
- `minor`: `1.1.0` → `1.2.0`

If the current version is a pre-release, stop: the line is already set, and
neither keyword can change what ships. The user wants `--stable`.

Never compute a stable version with `npm version minor`. From `1.1.0-rc.3`,
semver makes `major`, `minor`, and `patch` all collapse to `1.1.0` — the
command doesn't say what you'll get. Always pass the literal version.

### Worked examples

| Current | Invocation | Result |
| --- | --- | --- |
| `0.0.0` (placeholder) | `--rc` | **stop** — ask for `--version:` |
| `0.0.0` (placeholder) | `--rc --version:1.0.0` | `1.0.0-rc.1` |
| `1.0.0` | `--rc` | `1.1.0-rc.1` (inferred next minor) |
| `1.0.0-rc.2` | `--rc` | `1.0.0-rc.3` |
| `1.0.0-rc.2` | `--rc --version:1.0.0` | `1.0.0-rc.3` (same line, continues) |
| `1.0.0-rc.3` | `--stable` | `1.0.0` |
| `1.0.0-rc.3` | `--stable --version:2.0.0` | **stop** — RCs rehearsed 1.0.0 |
| `1.0.0` | `--stable` | **stop** — no RC line open |
| `1.0.0-rc.3` | `--version:minor` | **stop** — line already set |
| any | `--version:0.0.1` | **stop** — already published |

### The platform range (create-platform only)

When create-platform is released, decide `worca.platformRange`:

- **`--package:both`**: set it to `^<the platform version computed above>`.
- **create-platform alone**: keep it, and check it resolves:
  `npm view "@worca/platform@<range>" version`. Empty output means no
  published platform matches — stop and say so (release the platform first,
  or pass `--package:both`).
- Stable create-platform with a pre-release range (`^1.1.0-rc.2`): ask whether
  to move the range to the platform's stable version first. A stable scaffolder
  pointing new deployments at an RC is rarely what's meant.

**Print, per package, the computed version (and for create-platform the range)
and confirm with the user before proceeding.**

---

## Step 3: Check the tarball contents

The `files` allowlist in each `package.json` decides what ships. Compare
against the last release so nothing sneaks in or drops out:

```bash
(cd packages/<dir> && npm pack --dry-run 2>&1 | tail -8)
npm view @worca/<dir> dist.fileCount dist.unpackedSize
```

A sudden jump usually means test fixtures or build artifacts entered the
allowlist; a sudden drop means a runtime directory left it. Report either and
stop. The `0.0.1` placeholders are a few files each, so the first real release
has nothing to compare with: report the numbers instead (the platform was
about 720 kB packed when this was written).

---

## Step 4: Bump, commit, tag, push

`npm version`'s own tagging writes a bare `v1.0.0`, which is the wrong shape
for this repo — bump without a tag and create the prefixed tag yourself.

The version bump belongs on `dev`, because the next release computes its
number from `package.json`. `dev` takes pull requests only, but repository
admins and maintainers bypass that rule; release commits are pushed directly,
as in worca-cc. If the push is refused, stop and tell the user — do not open a
PR for a release commit and tag before it is merged.

Move the **Unreleased** entries of `CHANGELOG.md` under a heading for this
release in the same commit — `## @worca/platform <V>` — unless a heading for
it is already there (then leave it). With `--package:both`, one heading names
both: `## @worca/platform <V1>, @worca/create-platform <V2>`, written in the
platform's commit.

### 4a: One package

```bash
npm version <VERSION> --no-git-tag-version -w @worca/<dir>
# create-platform only, when the range changes:
npm pkg set worca.platformRange='<RANGE>' -w @worca/create-platform
git add packages/<dir>/package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): @worca/<dir> <VERSION>"
git tag -a worca-<dir>-v<VERSION> -m "@worca/<dir> <VERSION>"
git push origin HEAD
git push origin worca-<dir>-v<VERSION>
```

Substitute the literals — e.g. `npm version 1.0.0-rc.1 --no-git-tag-version -w
@worca/platform`, `git tag -a worca-platform-v1.0.0-rc.1 -m "@worca/platform
1.0.0-rc.1"`. End the commit message with the attribution lines this session's
instructions give.

**The tag must be annotated (`-a`) and pushed explicitly.** `git push` alone
pushes no tags, and `--follow-tags` pushes *only annotated* ones — so the
obvious-looking `git tag <name>` + `git push --follow-tags` reports success,
pushes the commit, silently leaves the tag local, and fires no workflow.

Confirm the tag actually landed before moving on:

```bash
git ls-remote --tags origin "worca-<dir>-v<VERSION>"
```

### 4b: Both packages

1. Run 4a for **`platform`**, then Steps 5 and 6 for it. Do not continue until
   `npm view @worca/platform@<V1> version` answers: create-platform's release
   checks its range against the registry.
2. Run 4a for **`create-platform`**, with `worca.platformRange` set to
   `^<V1>`, as a second commit and a second tag. Then Steps 5 and 6 for it.

If the platform's release fails, stop there: do not release create-platform
against a platform that is not on npm.

---

## Step 5: Watch the release

The workflow derives the package from the tag prefix and the npm dist-tag from
the version: `-rc.` → `rc`, otherwise `latest`. Nobody has to remember a flag.
It runs the unit, e2e and UI suites before publishing, so expect several
minutes.

```bash
gh run watch "$(gh run list --workflow=release-npm.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

If the job fails **before** the publish step, fix it and re-tag with the next
version — the burned number cannot be reused. If it fails **after** publish,
the package is already live; treat it as a post-release fix, not a retry.

---

## Step 6: Verify the published result

Three checks per released package. All three matter; report each.

```bash
# 1. The version is serving under the expected dist-tag.
npm view @worca/<dir> dist-tags

# 2. Provenance was attested. A missing `attestations` field means the trusted
#    publisher is misconfigured and the tarball is unverifiable — investigate
#    before telling anyone to install it.
npm view @worca/<dir>@<VERSION> dist.attestations

# 3. Both pointers read as expected.
npm dist-tag ls @worca/<dir>
```

For create-platform, also check that what it scaffolds installs:

```bash
npm view "@worca/platform@$(npm view @worca/create-platform@<VERSION> worca.platformRange)" version
```

After a GA release `rc` still points at the last release candidate, and that is
correct — the OIDC credential is granted `npm publish` only and cannot move a
dist-tag, so nothing promotes it. Report it as expected, not as a fault. The
next `--rc` moves it ahead of `latest` again.

The first release through each package's trusted publisher also validates it
on npmjs.com ("Pending validation" → "Valid").

---

## Step 7: Print the summary

```
Release complete

  @worca/platform:         <OLD> → <NEW>   (dist-tag: rc | latest)   tag worca-platform-v<NEW>
  @worca/create-platform:  <OLD> → <NEW>   (dist-tag: rc | latest)   tag worca-create-platform-v<NEW>
                           scaffolds @worca/platform@<RANGE>
  Provenance:              attested | MISSING — investigate   (per package)

  Try it:
    npm create @worca/platform@<NEW or rc> my-deploy
    npm install @worca/platform@<NEW or rc>      # in an existing deployment
```

List only the packages released. Only claim `attested` when Step 6 actually
showed an `attestations` field.

Each release also gets a GitHub Release (a pre-release for an RC) with
generated notes, created by the workflow's last job.
