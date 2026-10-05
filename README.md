# @rmartz/merge-safety

The **pre-auto-merge safety verdict** for a pull request, packaged so a repo can
use GitHub's native auto-merge safely. merge-safety gathers base-currency,
breaking-change, and conflict facts for a PR, posts them as the `merge-safety`
check-run, and re-holds every open PR when the base branch moves — so a PR only
auto-merges once it is genuinely safe against the current base.

Consuming repos adopt it through the composite action
[**`rmartz/merge-safety-action`**](https://github.com/rmartz/merge-safety-action),
distributed the same way as the fleet's other `-action` repos:

1. **Updates propagate automatically.** Consuming repos pin the action by SHA;
   Dependabot's `github-actions` ecosystem opens PRs to bump that pin, and each
   action release pins a specific version of this CLI.
2. **The check-run name is a fleet contract.** Every consumer requires a status
   check named exactly `merge-safety`; see
   [docs/check-run-contract.md](docs/check-run-contract.md).

> **Status: released.** The package ships the full `evaluate` / `invalidate`
> implementation as the `merge-safety` CLI and is ready to adopt.

## Using it in a consuming repo

Add the caller workflow from the action's
[consumer guide](https://github.com/rmartz/merge-safety-action/blob/main/docs/consuming.md),
create the labels merge-safety manages, and require the `merge-safety` status
check on the default branch. See [docs/consuming.md](docs/consuming.md) for what
the verdict expects of a repo and how it behaves.

> **The reusable workflow in this repo is deprecated.** Repos pinned to
> `rmartz/merge-safety/.github/workflows/merge-safety.yml` keep working and see a
> deprecation warning on each run; migrate them to the action.

## Requirements

- Node.js >= 20.11
- pnpm 9 (pinned via `packageManager`)

Consuming repos need neither — the action runs the published CLI on a
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
and is never committed back. The version installed by the deprecated reusable
workflow is resolved at runtime from the **release tag at its own pinned commit**,
so it lives only in the git tag; the action pins the version in its own lockfile. Config: [`.releaserc.json`](.releaserc.json).

**Version mapping (v0):** `feat:` → minor; `fix:`/`perf:` → patch. Pre-1.0, a
breaking change (`!`) is **capped at minor** so it can't auto-jump to `1.0.0`;
leaving v0 (cutting `1.0.0`) is a deliberate manual act. Dependabot uses the
split-prefix convention (rmartz/ai#82): a **production** bump arrives as
`fix(deps):` → patch (it ships to users); **dev** (`chore(deps):`) and
**github-actions** (`chore(github-actions):`) bumps are release-less — as a
zero-runtime-dependency package, all Dependabot bumps are dev-only in practice.

Three guards back the automatic flow: pr-policy's `title` check, part of the
`pr-policy` check run by [`pr-policy.yml`](.github/workflows/pr-policy.yml) (pre-merge title format), [`commit-convention.yml`](.github/workflows/commit-convention.yml)
(post-merge tripwire for a non-conventional subject that would make semantic-release
silently skip), the shared [`release-check.yml`](.github/workflows/release-check.yml)
(renders the notes through the shared
[semantic-release-ci](https://github.com/rmartz/semantic-release-ci) toolchain so an
incompatible release config fails the PR), and, in [`ci.yml`](.github/workflows/ci.yml),
the `Package`
job (packs exactly what `pnpm publish` would upload and fails if the tarball is
malformed or missing an `exports`/`bin` entry point) — so both a broken release config
and a broken packaging manifest are caught before merge, not on the real release run.

---

🤖 Created by Claude Opus 4.8
