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

Two dependencies came along, and how each is satisfied was decided during the
code migration. **Both decisions are now locked:**

- **`@rmartz/agent-runtime` → only `boundedRun`** (a git-subprocess wrapper used
  in `-facts.ts`). This is the same ~67-line helper repo-hygiene inlined, so
  **inlined** as `src/lib/bounded-subprocess.ts` — no dependency edge.
  _(Done: [#2](https://github.com/rmartz/merge-safety/issues/2) / PR #7.)_
- **`@rmartz/github` → `ghCall`, `resolveRepoTarget`, `addLabels`, `removeLabel`**
  (the gh REST+GraphQL transport plus label helpers). The substantial call —
  **DEPEND on the published `@rmartz/github`, pinned `^0.4.2`.** `ghCall` pulls
  the REST+GraphQL transport we don't want to reproduce, and inlining is heavier
  here than for repo-hygiene (whose github surface was smaller), so depending is
  the lighter path. `@rmartz/github` is **public** on GitHub Packages, so the
  reusable workflow's `setup-node` install resolves it transitively with the
  built-in `GITHUB_TOKEN` — no consumer PAT. It is a `dependencies` entry in
  `package.json`, imported by the `ai-merge-safety` bin.
  _(Decided in [#4](https://github.com/rmartz/merge-safety/issues/4#issuecomment-5699755986);
  end-to-end install is verified at [#5](https://github.com/rmartz/merge-safety/issues/5).)_

The `merge-safety.ts` / `merge-safety-facts.ts` slice and the `ai-merge-safety`
bin now live in `src/` alongside the package's stable public contract (the
[check-run name](check-run-contract.md) and the command surface), so the
[reusable workflow](consuming.md) is wired end to end.

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
