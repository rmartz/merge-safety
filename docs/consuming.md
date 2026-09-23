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
> The failure is **self-documenting**: the `merge-safety` check-run reads
> `Base CI failing` and its summary states _"only hotfix PRs may merge until it is
> green (label this PR `hotfix` to override)"_ and lists the failing base checks —
> so an investigating agent or human sees the reason and the override at the point
> of failure, without consulting these docs. (Even so, `hotfix` should exist so
> that override is actually applicable.)
>
> **`hotfix` also exempts a `ci`-typed PR from being forced current.** A `ci`-typed
> PR is normally held until it is current with its base (so a CI guard is re-tested
> against the latest base). That guard is unconditional — except for a `hotfix`,
> which frees it: a CI fix for a base whose own CI is red would otherwise be caught
> in a bind, since being forced current may be impossible or pointless while the
> base is broken. The exemption is scoped to _this PR is itself CI_; it does **not**
> relax the breaking-change clause or the base-side clauses (a hotfix that overlaps
> real base changes still needs a rebase to merge cleanly).

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
  base-health axis blocks non-hotfix PRs while the base branch's CI is red — where
  "red" means one of the base branch's **required status checks** (the contexts its
  ruleset declares) failed, not an arbitrary failing job like the native "Dependabot
  Updates" run. `evaluate` reads that required-check set from the branch's rulesets
  (`GET /repos/{repo}/rules/branches/{branch}`, covered by the `contents: read`
  scope above); if it can't be read (no ruleset / transient error), base health
  falls back to a coarser heuristic — a failing GitHub Actions run blocks, minus the
  Dependabot job and any non-Actions deploy — so a broken base is still caught. A push
  to the base re-evaluates open PRs immediately, but at that moment the base's CI
  is still _pending_ — so the reusable workflow also fans out (`invalidate`) when a
  base-branch `check_suite` **completes**, re-holding already-cleared PRs once the
  base goes red and releasing them when it goes green. It is filtered to the
  `github-actions` app on the default branch (one suite per base commit), and does
  not loop: the fan-out's own runs use `GITHUB_TOKEN`, whose activity GitHub does
  not let trigger a further `check_suite` run. (`check_suite`-triggered workflows
  only run from the default branch — exactly the base we watch.)

  A **re-run recovers automatically.** If base CI fails transiently and is then
  re-run to green, the re-run completes the _same_ check suite again, so GitHub
  fires a second `check_suite: completed` (now `success`) — `invalidate` fans out
  once more, each PR re-reads the base tip with `?filter=latest` (which returns the
  passing re-run, not the earlier failure), and the held PRs are released. The one
  gap is the recursion guard above: if the re-run is _initiated by `GITHUB_TOKEN`_,
  GitHub suppresses that `check_suite` event, so the auto-release waits for the next
  base event instead (a push to the base, or any PR `synchronize`, re-evaluates and
  picks up the now-green base — so a PR is never _permanently_ stuck, only until the
  next event). A **human** re-run, or one via a PAT/app token, fires normally.

- **Write scopes, not read-only.** Effective permissions are the intersection of
  caller-granted and workflow-declared, so the caller must grant the full
  `checks` / `pull-requests` / `actions: write` set.
- **`workflow_dispatch` `pr` threading** — the `invalidate` fan-out re-dispatches
  each PR via `workflow_dispatch`, and the `pr` input passes through `with:`. The
  re-dispatch targets the caller file named by the `caller-workflow` input, which
  defaults to `merge-safety.yml`; a caller saved under any other filename must pass
  `caller-workflow: <its filename>`. (This repo's own caller,
  [`merge-safety-self.yml`](../.github/workflows/merge-safety-self.yml), does
  exactly that, since `merge-safety.yml` here is the reusable workflow itself.)
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
`vX.Y.Z` (cut automatically by semantic-release on push to `main` — see the repo's
Releases), so the pin comment matches the tag directly: that is what Dependabot's
`github-actions` ecosystem needs to re-bump the SHA and refresh the comment together,
and the form consumer pin-linters requiring a full `vMAJOR.MINOR.PATCH` comment
accept. The reusable workflow resolves which package version to install from the
release tag at the SHA you pin, so the pinned SHA fully determines the behavior.

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

> **A cancelled "superseded" run on the checks list is expected — it is not a
> merge-safety failure.** A single PR action can fire several
> `pull_request_target` events near-simultaneously (Dependabot opening a PR emits
> `opened` + `labeled` once per label + often `edited`, all within ~1s). Those all
> share the PR's serialized `concurrency` group, so only the newest run proceeds
> and the superseded ones are **cancelled** — and a cancelled run renders red ✗ in
> `gh pr checks` and the PR UI (historically as the misleadingly-named
> `merge-safety / Invalidate open PRs (base moved)`). This is by design: cancelling
> the superseded run is what makes the **last** event — with the final
> label/title/base state — the one that posts the verdict (latest-wins). **Only the
> single check-run named `merge-safety` gates the merge** (see
> [the check-run contract](check-run-contract.md)); a cancelled superseded run is
> never a required context and never blocks. If the named `merge-safety` check-run
> is green, the safety verdict passed regardless of any cancelled sibling entries.
