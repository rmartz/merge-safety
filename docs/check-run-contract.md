---
type: Reference
title: The check-run contract
description: Why the name `merge-safety` is a fleet contract wired into every consumer's required status checks and the auto-merge gate, why renaming it is a coordinated fleet migration rather than a local edit, why the verdict is posted as both a check-run and a commit status, and the three verdict states (success, pending, failure) consumers must tell apart.
tags: [merge-safety, auto-merge, contract, check-run, commit-status]
---

# The check-run contract

merge-safety posts its verdict under the name **`merge-safety`**, as both a
check-run and a commit status with that context (see
[below](#the-commit-status-is-what-the-gate-relies-on)). That name is
not a private implementation detail or a cosmetic label — it is a **fleet
contract** that three separate things depend on by string:

1. **Every consumer's required status check.** Each repo that uses merge-safety
   configures a _required status check_ of exactly the name `merge-safety` on its
   default branch. GitHub matches required checks by name, so the posted check-run
   and the required-check config must agree character-for-character or the gate
   silently never satisfies (a required check that never appears hangs the PR
   forever). A name mismatch is one way the check never appears; a caller triggered
   on `pull_request` rather than `pull_request_target` is another — GitHub dispatches
   no `pull_request` run for an unmergeable PR, so the check is never posted (see
   [Setting up merge-safety in a consuming repo](consuming.md)).
2. **The auto-merge gate.** The fleet's auto-merge path gates on
   `goldenGateChecks = ['merge-safety']`. The
   verifier looks up the check by that name; a mismatch means auto-merge either
   never engages or engages without the safety verdict.
3. **The gate floor.** The bootstrap/golden config that seeds each consumer's
   required-check set carries `merge-safety` as a floor.

The single source of truth for the name in this package is
`MERGE_SAFETY_CHECK_NAME` in `src/index.ts`, and a package test pins it.

## Why the name is fixed

Because the name is duplicated across every consumer's GitHub settings, the
auto-merge verifier, and the gate floor, **renaming it is a coordinated fleet
migration** — every consumer's required-check config, the verifier, and the floor
must all change at once, or some repos gate on the old name and some on the new
one during the window. A local rename in this repo would post a check no consumer
requires, quietly disabling the safety gate everywhere.

So: the repository name is a free choice, but the **check-run name stays
`merge-safety`**. Treat `MERGE_SAFETY_CHECK_NAME` as frozen; changing it is a
deliberate cross-repo project, never a refactor.

## Three verdict states

The `merge-safety` check-run ends in one of three states:

| State       | Check-run                    | Commit status | Title                                                                               | When                                                                              |
| ----------- | ---------------------------- | ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **success** | `completed` / `success`      | `success`     | `No update required`                                                                | Safe to merge as-is.                                                              |
| **pending** | `in_progress`, no conclusion | `pending`     | `Update required`                                                                   | The PR is stale and nothing else is wrong. A branch update clears it.             |
| **failure** | `completed` / `failure`      | `failure`     | `Merge conflict`, `Base CI failing`, `Retitle as a CI change`, `Could not evaluate` | Something a branch update alone cannot fix, including staleness combined with it. |

The commit status carries the title as its description, cut to GitHub's
140-character limit.

A stale-only PR used to get a red ✗ `failure`
([#58](https://github.com/rmartz/merge-safety/issues/58)). Being out of date is
routine and automation clears it, so it now gets a yellow `in_progress` check
instead. For a required check GitHub merges only on `success`, `neutral`, or
`skipped`, so an incomplete check still blocks the merge and auto-merge waits on
it, exactly as a failure would.

**An incomplete `merge-safety` check does not always mean "still evaluating".**
Two states share `in_progress` (status `pending`), and consumers tell them apart
by the check-run **title**, which is also the commit status's description:

- `Re-evaluating`: `invalidate` marked the PR pending after the base moved, and a
  verdict is on its way.
- `Update required`: the verdict is in, and it will not change until the PR's
  branch is updated. Updating the branch creates a new head SHA, which gets a fresh
  evaluation. Tooling that waits for CI must not wait on this state; the PR also
  carries the `update required` label.

GitHub marks a check-run that stays incomplete for 14 days as `stale`. That is
harmless here: a stale check still blocks the merge, and updating the branch
replaces it with a fresh evaluation.

## The commit status is what the gate relies on

Every post sets the check-run **and** a commit status with the context
`merge-safety`, both carrying the same verdict. The status exists because the
check-run alone could leave a PR `BLOCKED` while every check showed green
([#73](https://github.com/rmartz/merge-safety/issues/73)):

- A check-run created with `GITHUB_TOKEN` doesn't get a check suite of its own.
  GitHub files it into the **oldest `github-actions` suite** on the head SHA, which
  is usually some other workflow's suite, such as `bot-automerge` or `pr-policy`.
- When a **newer run of that same workflow and event** lands on the same SHA (a
  `pull_request_target` workflow fires on opened, labeled, edited, and so on),
  GitHub treats the older suite as superseded. **The merge gate ignores every
  check-run in a superseded suite.**
- The REST checks list and GraphQL's `isRequired` rollup still show the ignored run
  as `SUCCESS`, so nothing looks wrong except the `BLOCKED` merge state. Re-running
  merge-safety does not help, because the new run lands in the same old suite.

A commit status belongs to no suite, so no workflow run can supersede it. When the
check-run is in a live suite it agrees with the status, and when it is in a
superseded one the gate ignores it and the status decides. The check-run is kept for
the tooling that reads it by name, such as the auto-merge gate.

Setting the status needs `statuses: write` (see
[Setting up merge-safety](consuming.md)). If the token lacks it, the check-run still
posts and the run logs a warning, but the PR stays exposed to the superseded-suite
block.

## One run per head, completed in place

Before posting, merge-safety looks for any `merge-safety` check-run on the PR's
head SHA that is **not yet completed**. If it finds one, it updates that run in
place (`PATCH`) instead of creating a new one. It creates a run (`POST`) only when
there is nothing open to update, or when the lookup itself fails.

This matters because of `invalidate`. When the base moves, `invalidate` marks each
open PR pending by posting an `in_progress` run, then dispatches that PR's
`evaluate`. Before
[#61](https://github.com/rmartz/merge-safety/issues/61), `evaluate` posted its
verdict as a _second_ run, and nothing ever completed the pending one. The gate
still worked, since GitHub resolves a required check from the newest run, but each
base move left one run per open PR stuck `in_progress` forever. Now the verdict
lands on the pending run itself, so a head carries at most one open `merge-safety`
run at a time.

A few details:

- The lookup matches the exact name `merge-safety`, so the reusable workflow's own
  job entries (`merge-safety / Evaluate one PR`) are never touched.
- It checks every run on the head, not just the latest, so orphans that earlier
  versions left behind are completed the next time the PR is evaluated.
- A pending run that never gets a verdict (for example, the dispatch failed) stays
  `in_progress` and keeps blocking the merge, which is the fail-safe outcome. The
  next evaluation of that head, from any PR event, completes it.

## Only the named context gates — sibling entries do not

Because the gate matches by the single name `merge-safety`, **nothing else on the
checks list gates the merge**. A single PR action can fire several PR events at once
(a Dependabot open emits `opened` + `labeled` + `edited` within ~1s), so a burst can
leave more than one `merge-safety` run on the list. Only the `merge-safety` context
is required, and GitHub gates on the latest value posted under that name. The
`merge-safety` verdict holds whatever sibling entries sit beside it, except that a
check-run in a superseded suite is ignored, which is why the commit status
[exists](#the-commit-status-is-what-the-gate-relies-on). See
[Setting up merge-safety in a consuming repo](consuming.md#3-require-the-check).

Those siblings used to be **cancelled** runs, because the reusable workflow declared a
per-PR `concurrency` group and GitHub cancels any pending run a newer event supersedes.
That group was removed in
[#48](https://github.com/rmartz/merge-safety/issues/48): a cancelled run renders red ✗
and is the same conclusion a timed-out run produces, so it read as a failure to anything
inspecting check conclusions. The burst's runs now overlap and each completes normally.
