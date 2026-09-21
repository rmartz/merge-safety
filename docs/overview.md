---
type: Reference
title: What merge-safety is
description: The pre-auto-merge safety verdict for a PR — the base-currency, breaking-change, and conflict facts it gathers, and the check-run and labels it manages via evaluate and invalidate.
tags: [merge-safety, auto-merge, ci, overview]
---

# What merge-safety is

`@rmartz/merge-safety` computes the **pre-auto-merge safety verdict** for a pull
request and publishes it as the [`merge-safety` check-run](check-run-contract.md).
It is the gate that lets a repo use GitHub's native auto-merge safely: a PR holds
auto-merge until its `merge-safety` check clears, and a change to the base branch
re-holds every other open PR until each re-clears.

It ships as one CLI, `ai-merge-safety`, with two operations that the
[reusable workflow](consuming.md) dispatches by event:

## `evaluate` — one PR

On a pull-request event (or a `workflow_dispatch` naming a PR), `evaluate`
gathers the safety **facts** for that one PR against its base:

- **Base currency** — is the PR's branch behind its base in a way that matters?
- **Breaking change** — did something merge into the base that this PR must be
  re-tested against (a breaking-change signal or a real file overlap)?
- **Conflicts** — does the PR merge cleanly, or is there a conflict?
- **Base health** — is the **base branch's own CI** failing? A red base blocks
  every PR **except a `hotfix`-labelled one**, so the fix for broken main still
  gets through while nothing else piles onto it. "Failing CI" is read expansively
  — any failing GitHub Actions run on the base counts — but a failing _deploy_
  does not: a red deploy under green Actions is likelier an external fault no code
  change can fix, so it must not wedge the whole queue.

It then posts the `merge-safety` check-run with the verdict and **reconciles the
labels** that surface the reason to humans and to the coordinator — the
update-required and merge-conflict labels — adding or removing each to match the
current facts. (The base-health axis mints no label; the `hotfix` label is an
_input_ it reads, and its outcome is carried by the check-run title/reason.)

## `invalidate` — the base moved (or its CI flipped)

On a push to the base branch, `invalidate` fans out across **every other open
PR**: it flips each one's `merge-safety` check back to pending and re-dispatches
its `evaluate`. This is what makes a moved base hold native auto-merge until each
PR has been re-checked against the new base, rather than letting a now-stale PR
merge itself.

It also fans out when the **base branch's own CI concludes** (a `check_suite`
completion on the default branch). A push-time re-evaluation sees the base's CI
still _pending_, so it is the concluded-CI event that actually re-holds
already-cleared PRs once base health flips — blocking non-hotfix PRs when the base
goes red, and releasing them when it goes green again. See
[consuming](consuming.md) for the caller trigger this needs.

## How the pieces fit

- **[The check-run contract](check-run-contract.md)** — the fleet-wide meaning of
  the `merge-safety` check-run name.
- **[Setting up merge-safety in a consuming repo](consuming.md)** — the caller
  workflow and its permissions.
- **[The extraction migration](migration.md)** — how it was split out of
  `@rmartz/pr-review` and the locked layer-0 dependency decisions behind the CLI.
