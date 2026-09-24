# @rmartz/merge-safety

The **pre-auto-merge safety verdict** for a pull request, packaged so a repo can
use GitHub's native auto-merge safely. merge-safety gathers base-currency,
breaking-change, and conflict facts for a PR, posts them as the `merge-safety`
check-run, and re-holds every open PR when the base branch moves — so a PR only
auto-merges once it is genuinely safe against the current base.

It is distributed the same way [`@rmartz/repo-hygiene`](https://github.com/rmartz/repo-hygiene)
is:

1. **Updates propagate automatically.** Consuming repos pin one reusable workflow
   by SHA; Dependabot's `github-actions` ecosystem opens PRs to bump that pin.
2. **The check-run name is a fleet contract.** Every consumer requires a status
   check named exactly `merge-safety`; see
   [docs/check-run-contract.md](docs/check-run-contract.md).

> **Status: released.** `v0.1.0` ships the full `evaluate` / `invalidate`
> implementation and the `ai-merge-safety` CLI — the package is functional and
> ready to adopt. It was split out of `@rmartz/pr-review` per
> [ai-tools#247](https://github.com/rmartz/ai-tools/issues/247); see
> [docs/migration.md](docs/migration.md) for the record of how it was extracted.

## Using it in a consuming repo

Add one caller workflow (this is what Dependabot keeps current). Unlike a
read-only hygiene check, this caller carries the triggers, grants write scopes,
and passes secrets through — because a reusable workflow can't declare its own
triggers and runs with the intersection of granted and declared permissions:

```yaml
# .github/workflows/merge-safety.yml
name: merge-safety
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      pr:
        description: PR number to evaluate
        required: true
permissions:
  checks: write
  pull-requests: write
  contents: read
  actions: write
  packages: read
jobs:
  merge-safety:
    uses: rmartz/merge-safety/.github/workflows/merge-safety.yml@<sha> # vX.Y.Z
    with:
      pr: ${{ inputs.pr }}
    secrets: inherit
```

Then require the `merge-safety` status check on the default branch. Both the
caller and the Dependabot entry are seeded once by
[`@rmartz/bootstrap`](https://github.com/rmartz/ai-tools)
(`ai-ensure-project-config`); after that Dependabot maintains the pin. The
`@rmartz/merge-safety` CLI is public on npmjs, so installing it needs no token.
(Pins at v0.6.0 or earlier install from GitHub Packages instead, which is what the
`packages: read` permission above is for; it can be dropped once your pin is past
v0.6.0.)

> For the full walkthrough — the caller's permissions, why it isn't trigger-free,
> and how to verify the setup — see the
> [consumer setup guide](docs/consuming.md).

## Requirements

- Node.js >= 20.11
- pnpm 9 (pinned via `packageManager`)

Consuming repos need neither — the reusable workflow runs the published CLI on a
GitHub-hosted runner.

## Local development

```bash
pnpm install
pnpm run build        # tsup → dist (ESM + d.ts)
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test         # vitest
```

## Releases

Fully automatic via [`semantic-release`](https://semantic-release.gitbook.io) — no
manual `pnpm version` step. Every push to `main` runs
[`release.yml`](.github/workflows/release.yml): it analyzes the conventional-commit
subjects since the last `vX.Y.Z` tag (the squash-merged **PR title** is that subject),
computes the next version, builds and publishes the package to npmjs (public, via
OIDC trusted publishing with provenance — no npm token), and creates the git tag +
GitHub Release with generated notes — using only the built-in `GITHUB_TOKEN`, no
release-please and no PAT. There is deliberately **no
`@semantic-release/git`**: `package.json`'s `version` is a frozen `0.0.0` placeholder
and is never committed back. The version installed by the reusable workflow is
resolved at runtime from the **release tag at its own pinned commit**, so it lives
only in the git tag. Config: [`.releaserc.json`](.releaserc.json).

**Version mapping (v0):** `feat:` → minor; `fix:`/`perf:` → patch. Pre-1.0, a
breaking change (`!`) is **capped at minor** so it can't auto-jump to `1.0.0`;
leaving v0 (cutting `1.0.0`) is a deliberate manual act. Dependabot uses the
split-prefix convention (rmartz/ai#82): a **production** bump arrives as
`fix(deps):` → patch (it ships to users); **dev** (`chore(deps):`) and
**github-actions** (`chore(github-actions):`) bumps are release-less — as a
zero-runtime-dependency package, all Dependabot bumps are dev-only in practice.

Three guards back the automatic flow: [`pr-title-lint.yml`](.github/workflows/pr-title-lint.yml)
(pre-merge title format), [`commit-convention.yml`](.github/workflows/commit-convention.yml)
(post-merge tripwire for a non-conventional subject that would make semantic-release
silently skip), and, in [`ci.yml`](.github/workflows/ci.yml), the `Release notes render`
job (renders the notes through the real changelog toolchain so an incompatible
preset/writer pairing fails the PR) and the `Package`
job (packs exactly what `pnpm publish` would upload and fails if the tarball is
malformed or missing an `exports`/`bin` entry point) — so both a broken release config
and a broken packaging manifest are caught before merge, not on the real release run.

---

🤖 Created by Claude Opus 4.8
