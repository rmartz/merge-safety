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
