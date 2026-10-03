---
type: Reference
title: Setting up merge-safety in a consuming repo
description: How a repo adopts merge-safety through rmartz/merge-safety-action, the labels and required check it needs, how the base-health and hotfix rules behave, and how to migrate off the deprecated reusable workflow.
tags: [consumer, setup, auto-merge]
---

# Setting up merge-safety in a consuming repo

Consumers adopt merge-safety through the composite action
[**`rmartz/merge-safety-action`**](https://github.com/rmartz/merge-safety-action),
which pins a specific `@rmartz/merge-safety` CLI version in its lockfile and is
kept current by Dependabot like the fleet's other `-action` repos. The caller
workflow, its permissions, and the step-by-step setup live in that repo's
[consumer guide](https://github.com/rmartz/merge-safety-action/blob/main/docs/consuming.md).
This page covers what the verdict expects of a consuming repo and how it behaves.

> **The reusable workflow is deprecated.** `rmartz/merge-safety/.github/workflows/merge-safety.yml`
> still works for repos pinned to it, and each run now emits a deprecation warning.
> Migrate by replacing the caller with the one in the action's
> [migration steps](https://github.com/rmartz/merge-safety-action/blob/main/docs/consuming.md#migrating-from-the-reusable-workflow).
> The check-run name, triggers and required check are unchanged.

## 1. Create the labels merge-safety manages

`evaluate` reconciles two labels on each PR — **`update required`** and
**`merge conflict`** — and honors **`hotfix`** (below). Label writes go through
`gh` and **soft-fail silently**: if a label is missing, the check-run still posts
its verdict but the human-facing label never appears, with no error surfaced.
Create all three before adopting; `ai-ensure-labels` seeds the standard roster,
which includes them.

`evaluate` reads a PR's breaking status from the title's `!` alone, so a repo
relies on pr-policy's title check to keep that `!` in step with the
`breaking change` label and to require it for a dependency major bump.

## 2. Trigger on `pull_request_target`, not `pull_request`

GitHub runs a `pull_request` workflow against the synthetic `refs/pull/N/merge`
commit, which it **cannot build for an unmergeable PR** — so on a PR that conflicts
with its base, no run is dispatched and the `merge-safety` check-run is never
posted. A required check that never appears hangs the PR forever (see
[the check-run contract](check-run-contract.md)), and a conflict is exactly when
the verdict matters most. `pull_request_target` runs in the base context and fires
even when the PR is unmergeable. It is safe because merge-safety fetches the PR
head only as git _data_ and runs the published CLI — it never executes
PR-authored code. Under `pull_request_target` the caller is read from the base
branch, so a PR that edits the caller only takes effect once merged.

> **Migrating an existing `pull_request` caller? The switch PR wedges itself —
> clear it with one `workflow_dispatch`.** Where `merge-safety` is already
> required, the PR that changes the caller from `pull_request` to
> `pull_request_target` cannot post its own check: a `pull_request` run reads the
> **head** file, which no longer subscribes to it, while `pull_request_target`
> reads the **base** file, which does not subscribe yet. Dispatch the caller once
> for that PR — `gh workflow run merge-safety.yml --repo <owner>/<repo> --ref main -f pr=<PR>`
> — and the required check turns green.

## 3. Require the check

Add `merge-safety` to the default branch's **required status checks**. The name
must be exactly `merge-safety` — see [the check-run contract](check-run-contract.md).
This is what makes native auto-merge wait for the safety verdict. GitHub only
lists a check in the picker after it has posted once, so open a PR or dispatch the
workflow first, or set the check by name through the rulesets API.

## How the verdict behaves

- **Stacked children are re-evaluated when their parent moves — if the caller
  triggers on that push.** `invalidate` fans out over the PRs based on whichever
  branch was pushed, but only for branches the caller's `push:` trigger subscribes
  to. Subscribe to `'**'` if your repo stacks PRs; a push to a branch nothing is
  based on finds no PRs and exits.
- **Base health holds PRs while the base is red.** "Red" means one of the base
  branch's **required status checks** (the contexts its ruleset declares) failed —
  not an arbitrary failing job like the native "Dependabot Updates" run.
  `evaluate` reads that set from `GET /repos/{repo}/rules/branches/{branch}`; if it
  can't (no ruleset, transient error), it falls back to a coarser heuristic — a
  failing GitHub Actions run blocks, minus the Dependabot job and non-Actions
  deploys. A push-time re-evaluation sees base CI still _pending_, so the caller's
  `check_suite: [completed]` trigger is what re-holds already-cleared PRs once the
  base goes red and releases them when it goes green. It does not loop: the
  fan-out's own runs use `GITHUB_TOKEN`, whose activity GitHub does not let
  trigger a further `check_suite` run.
- **A re-run recovers automatically.** Re-running failed base CI to green fires a
  second `check_suite: completed`; each PR re-reads the base tip with
  `?filter=latest` and is released. The exception: a re-run initiated by
  `GITHUB_TOKEN` fires no event, so release waits for the next base push or PR
  `synchronize`. A human re-run, or one via a PAT/app token, fires normally.
- **`hotfix` is the base-health escape hatch.** While the base's CI is failing,
  every open PR fails the `merge-safety` check **except** one labelled `hotfix`,
  so the fix for a broken base can still merge. The check-run reads
  `Base CI failing`, lists the failing base checks, and names the override, so the
  reason is visible at the point of failure.
- **`hotfix` also exempts a CI PR from being forced current.** A CI PR (`ci`-typed,
  or changing `.github/workflows/**` / `.github/actions/**`) is normally held until
  current with its base, so a CI guard is re-tested against the latest base. A
  `hotfix` frees it, since being forced current may be impossible while the base
  is broken. It does **not** relax the breaking-change clause or the base-side
  clauses.
- **Several overlapping `merge-safety` runs on one PR are expected.** One PR action
  can fire several `pull_request_target` events within a second (Dependabot opening
  a PR emits `opened` + one `labeled` per label + often `edited`). They overlap
  safely: `evaluate` reads the title, labels, mergeable state, head SHA and base
  checks live from the API, so concurrent runs post the same verdict, and GitHub
  gates on the latest value under the name. Runs must not share a per-PR
  `concurrency` group: GitHub cancels superseded pending runs, so a routine burst
  would leave `cancelled` runs that read as a failure on nearly every PR (removed in
  [#48](https://github.com/rmartz/merge-safety/issues/48)). That is a different case
  from the next bullet, where a cancel is rare and posts no verdict.
- **A transient GitHub API error cancels the run instead of failing it.** An
  exhausted quota, a GitHub 5xx, or a network timeout says nothing about the PR, so
  the run asks Actions to cancel itself (`POST /actions/runs/{run_id}/cancel`, using
  the `actions: write` the caller already grants) and posts **no** verdict. The PR
  keeps whatever `merge-safety` state it had, and the next event re-evaluates it; a
  head with no verdict yet stays blocked on the missing required check, which is the
  fail-safe outcome. See
  [the check-run contract](check-run-contract.md#only-the-named-context-gates--sibling-entries-do-not)
  for why the cancelled job entry does not displace an earlier verdict. **The cancel
  is run-wide:** that endpoint cancels every job in the caller's workflow run, not
  just the merge-safety step. Keep the caller workflow dedicated to merge-safety, as
  [`merge-safety-self.yml`](https://github.com/rmartz/merge-safety/blob/main/.github/workflows/merge-safety-self.yml)
  is, or an unrelated job sharing the run is cancelled along with it.

## Reusable-workflow pins

Repos still pinned to the deprecated reusable workflow keep working until they
migrate:

- It resolves the CLI version from the release tag whose commit is its pinned SHA,
  so pin a release commit with a plain `# vX.Y.Z` comment, as Dependabot does.
- Pins at v0.6.0 or earlier install from GitHub Packages and need
  `packages: read`; later versions install from npmjs with no token.
- **Do not pin v0.7.0 through v0.9.0** — those tags have no npm package, so the
  install fails with `ETARGET`.
- A caller saved under a filename other than `merge-safety.yml` must pass
  `caller-workflow: <its filename>`; the action detects this itself.
