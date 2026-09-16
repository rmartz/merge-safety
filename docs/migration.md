---
type: Reference
title: The extraction migration
description: How @rmartz/merge-safety is being split out of @rmartz/pr-review per ai-tools#247 — what moves, the depend-vs-inline decision for its layer-0 deps, and the ai-tools-side cutover this repo coordinates.
tags: [migration, extraction, ai-tools]
---

# The extraction migration

This repo is the standalone home of the merge-safety slice of
`@rmartz/pr-review`. It is being extracted so that consumers pin a **reusable
workflow by SHA** (Dependabot-bumped) instead of a bootstrap-seeded workflow that
hard-installs `@rmartz/pr-review@${MERGE_SAFETY_VERSION}` — an `env`-pin invisible
to Dependabot. The precedent is the `rmartz/repo-hygiene` split; the ai-tools-side
reference is **ai-tools#247**, and this repo's agent coordinates the cutover
against it.

## What moves here

A clean, self-contained slice of `@rmartz/pr-review`:

- `merge-safety.ts` + `merge-safety-facts.ts` and their tests.
- The `ai-merge-safety` bin (`src/bin/merge-safety.ts` — the `evaluate` /
  `invalidate` CLI).

The review-craft modules (`review-records`, `dependabot-risk`,
`context-helpers`) **stay** in `@rmartz/pr-review`; merge-safety is independent of
them.

## The layer-0 dependencies

Two dependencies come along, and how each is satisfied is an **open decision**
resolved during the code migration:

- **`@rmartz/agent-runtime` → only `boundedRun`** (a git-subprocess wrapper used
  in `-facts.ts`). This is the same ~67-line helper repo-hygiene inlined
  (`src/lib/bounded-subprocess.ts`), so **inlining is the expected path** —
  trivial to copy, no dependency edge.
- **`@rmartz/github` → `ghCall`, `resolveRepoTarget`, `addLabels`, `removeLabel`**
  (the gh REST+GraphQL transport plus label helpers). This is the substantial
  one — the real **depend-vs-inline** call. `ghCall` pulls transport machinery,
  so **depending on the published `@rmartz/github`** (install-auth'd like
  repo-hygiene's own deps) is the lighter path; inlining the ~4-function surface
  is the alternative. Decide during migration and record the choice here.

Until that lands, `src/` carries only the package's stable public contract (the
[check-run name](check-run-contract.md) and the command surface) so the
[reusable workflow](consuming.md) can be wired end to end.

## The ai-tools-side cutover (coordinated, not owned here)

Tracked in ai-tools#247; this repo's agent coordinates it with the ai-tools
agent once `@rmartz/merge-safety` publishes its first release:

- Split `merge-safety.ts` / `-facts.ts` (+ tests + the `ai-merge-safety` bin) out
  of `@rmartz/pr-review`; leave the review-craft modules. Flag to PR Shepherd (it
  imports `@rmartz/pr-review`) before removing the merge-safety exports.
- Convert bootstrap's golden `merge-safety.yml` (`golden-workflows.ts`) to the
  thin caller in [consuming.md](consuming.md); flip its policy `manage` → `seed`;
  drop `MERGE_SAFETY_VERSION`.
- Rewire ai-tools' own `merge-safety.yml` to the new consumption path.
- Update `ensure-workflow-files` tests + `docs/packages/bootstrap.md`.

## The check-run name is not part of the migration

The check-run name `merge-safety` is a fleet contract and stays fixed regardless
of the repo name or the package split — see
[the check-run contract](check-run-contract.md).
