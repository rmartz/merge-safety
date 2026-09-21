---
type: Reference
title: Setting up merge-safety in a consuming repo
description: How to add the thin merge-safety caller workflow to a repo, why it carries triggers and write scopes rather than being trigger-free, and how the SHA pin stays current via Dependabot.
tags: [consumer, setup, auto-merge]
---

# Setting up merge-safety in a consuming repo

This is the consumer-facing guide: how a repository adopts `@rmartz/merge-safety`.
Unlike a read-only hygiene check, merge-safety's caller is **not** trigger-free —
it carries the event triggers, grants write scopes, and passes secrets through —
because a reusable workflow cannot declare its own `on:` triggers and runs with
the _intersection_ of the caller-granted and workflow-declared permissions.

> **Prerequisite — the labels merge-safety manages must already exist in the repo.**
> `evaluate` reconciles two labels on each PR — **`update required`** and
> **`merge conflict`** — and reads a **`breaking change`** label as a
> breaking-change input where the repo uses that convention. Label reconciliation
> goes through `gh` and **soft-fails silently**: if `update required` /
> `merge conflict` do not exist in the repo, the check-run still posts its verdict
> but those human-facing labels never appear, with no error surfaced. Create them
> before adopting — `ai-ensure-labels` seeds the standard roster (which includes
> these), or create them by hand — so the labels track the verdict from the first
> run.
>
> **The `hotfix` label is the base-health escape hatch.** When the base branch's
> own CI is failing, `evaluate` fails the `merge-safety` check for every open PR
> **except** one labelled **`hotfix`**, so the fix for broken main can still merge
> while nothing else piles onto it. `hotfix` is in the standard `ai-ensure-labels`
> roster; make sure it exists so a genuine broken-main fix can override the gate.

## 1. Add the caller workflow

On a new repo the [`@rmartz/bootstrap`](https://github.com/rmartz/ai-tools)
`ai-ensure-project-config` step seeds this file (policy `seed`: seeded once, then
owned by Dependabot — not re-managed by bootstrap, so the pin can move). **Existing
repos consume merge-safety through this same caller**, so adopt the form below
directly — do not wait for a bootstrap re-run, which only touches greenfield repos.

```yaml
# .github/workflows/merge-safety.yml
name: merge-safety
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]
  push:
    branches: [main]
  check_suite:
    types: [completed]
  workflow_dispatch:
    inputs:
      pr:
        description: PR number to evaluate
        required: true
permissions:
  checks: write # post/flip the merge-safety check-run
  pull-requests: write # reconcile update-required / merge-conflict labels
  contents: read
  actions: write # dispatch per-PR evaluate runs on the push fan-out
  packages: read # install the CLI from GitHub Packages
jobs:
  merge-safety:
    uses: rmartz/merge-safety/.github/workflows/merge-safety.yml@<sha> # vX.Y.Z
    with:
      pr: ${{ inputs.pr }} # thread the workflow_dispatch input through
    secrets: inherit
```

> **Trigger on `pull_request_target`, not `pull_request`.** GitHub runs a
> `pull_request` workflow against the synthetic `refs/pull/N/merge` commit, which it
> **cannot build for an unmergeable PR** — so on a PR that conflicts with its base,
> no `pull_request` run is ever dispatched and the `merge-safety` check-run is never
> posted. A required check that never appears hangs the PR forever (see
> [the check-run contract](check-run-contract.md)), and a conflict is exactly when
> the merge-safety verdict matters most. `pull_request_target` runs in the base
> context and needs no merge commit, so it fires even when the PR is unmergeable.
> This is safe here because the reusable `evaluate` job checks out the **base ref**,
> fetches the PR head only as git _data_, and runs the published `ai-merge-safety`
> CLI — it never executes PR-authored code. (One trade-off: under
> `pull_request_target` the caller definition is read from the base branch, so a PR
> that edits this workflow only takes effect once merged — fine for a
> Dependabot-owned pin.) Greenfield bootstrap seeding is being moved to
> `pull_request_target` in
> [ai-tools#272](https://github.com/rmartz/ai-tools/issues/272); repos already seeded
> with `pull_request` should switch their caller now.

Why each piece is there:

- **The caller carries the triggers.** A reusable workflow can't declare its own
  `on:` triggers; the caller does and passes the event context in. Use
  `pull_request_target` (see the callout above) plus `push` on the default branch,
  the `check_suite` completion (below), and thread the `workflow_dispatch` input.
  The `evaluate`-vs-`invalidate` branch and the label-narrowing logic live inside
  the [reusable workflow](../.github/workflows/merge-safety.yml), so the caller
  stays thin.
- **`check_suite: [completed]` re-holds PRs when the base's CI flips.** The
  base-health axis blocks non-hotfix PRs while the base branch's CI is red. A push
  to the base re-evaluates open PRs immediately, but at that moment the base's CI
  is still _pending_ — so the reusable workflow also fans out (`invalidate`) when a
  base-branch `check_suite` **completes**, re-holding already-cleared PRs once the
  base goes red and releasing them when it goes green. It is filtered to the
  `github-actions` app on the default branch (one suite per base commit), and does
  not loop: the fan-out's own runs use `GITHUB_TOKEN`, whose activity GitHub does
  not let trigger a further `check_suite` run. (`check_suite`-triggered workflows
  only run from the default branch — exactly the base we watch.)
- **Write scopes, not read-only.** Effective permissions are the intersection of
  caller-granted and workflow-declared, so the caller must grant the full
  `checks` / `pull-requests` / `actions: write` set.
- **`workflow_dispatch` `pr` threading** — the `invalidate` fan-out re-dispatches
  each PR via `workflow_dispatch`, and the `pr` input passes through `with:`.
- **`secrets: inherit`** — a safe default; the built-in `GITHUB_TOKEN`
  (via `packages: read`) covers the public CLI install.

## 2. Keep the pin current

The `@<sha>` pin is bumped by Dependabot's `github-actions` ecosystem, the same
channel every reusable-workflow consumer uses:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

**Use a plain `# vX.Y.Z` version comment** on the pin — e.g.
`…/merge-safety.yml@<sha> # v0.1.0`. This repo's releases are **tagged** plain
`vX.Y.Z` (tag-driven — see the repo's Releases), so the pin comment matches the tag
directly: that is what Dependabot's `github-actions` ecosystem needs to re-bump the
SHA and refresh the comment together, and the form consumer pin-linters requiring a
full `vMAJOR.MINOR.PATCH` comment accept.

> The very first release (`v0.1.0`) predates this and was tagged `merge-safety-v0.1.0`
> (a release-please component tag); every release from `v0.1.1` on is a plain
> `vX.Y.Z` tag.

## 3. Require the check

Add `merge-safety` to the repo's **required status checks** on the default branch.
The name must be exactly `merge-safety` — see
[the check-run contract](check-run-contract.md). This is what makes native
auto-merge wait for the safety verdict.

> **First run — trigger the check once before requiring it.** GitHub's
> branch-protection UI only lists a check in the required-checks picker after it has
> posted at least once, so on a fresh repo `merge-safety` won't be selectable yet.
> Let the workflow run one time first — open a PR, or dispatch it via
> `workflow_dispatch` (the `pr` input) — then add `merge-safety` to the required
> checks. (Alternatively, set it by name through the branch-protection API before it
> has ever run.)

**Auth:** the published `@rmartz/merge-safety` package is **public** on GitHub
Packages, readable with the built-in `GITHUB_TOKEN` — the `packages: read`
permission above is all the install needs, no per-repo PAT.
