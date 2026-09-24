---
type: Reference
title: The check-run contract
description: Why the check-run name `merge-safety` is a fleet contract wired into every consumer's required status checks and the auto-merge gate, and why renaming it is a coordinated fleet migration rather than a local edit.
tags: [merge-safety, auto-merge, contract, check-run]
---

# The check-run contract

merge-safety posts a check-run named literally **`merge-safety`**. That name is
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
   `goldenGateChecks = ['merge-safety']` (in ai-tools' `golden-config.ts`). The
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

## Only the named check-run gates — sibling entries do not

Because the gate matches by the single name `merge-safety`, **nothing else on the
checks list gates the merge**. A single PR action can fire several PR events at once
(a Dependabot open emits `opened` + `labeled` + `edited` within ~1s), so a burst can
leave more than one `merge-safety` run on the list. Only the named `merge-safety`
check-run is a required context, and GitHub gates on the latest run posted under that
name; a green `merge-safety` check-run is the verdict, whatever sibling entries sit
beside it — see
[Setting up merge-safety in a consuming repo](consuming.md#3-require-the-check).

Those siblings used to be **cancelled** runs, because the reusable workflow declared a
per-PR `concurrency` group and GitHub cancels any pending run a newer event supersedes.
That group was removed in
[#48](https://github.com/rmartz/merge-safety/issues/48): a cancelled run renders red ✗
and is the same conclusion a timed-out run produces, so it read as a failure to anything
inspecting check conclusions. The burst's runs now overlap and each completes normally.
