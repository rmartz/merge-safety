---
type: Reference
title: What merge-safety is
description: The pre-auto-merge safety verdict for a PR — the base-currency, self-derived breaking-change, CI-typed-PR, and conflict facts it gathers, and the check-run and labels it manages via evaluate and invalidate.
tags: [merge-safety, auto-merge, ci, overview]
---

# What merge-safety is

`@rmartz/merge-safety` computes the **pre-auto-merge safety verdict** for a pull
request and publishes it as the [`merge-safety` check-run](check-run-contract.md).
It is the gate that lets a repo use GitHub's native auto-merge safely: a PR holds
auto-merge until its `merge-safety` check clears, and a change to the base branch
re-holds every other open PR until each re-clears.

It ships as one CLI, `merge-safety`, with two operations that
[`rmartz/merge-safety-action`](consuming.md) dispatches by event:

## `evaluate` — one PR

On a pull-request event (or a `workflow_dispatch` naming a PR), `evaluate`
gathers the safety **facts** for that one PR against its base:

- **Base currency** — is the PR's branch behind its base in a way that matters?
- **Breaking change** — did something merge into the base that this PR must be
  re-tested against (a breaking-change signal, a CI change, or a real file
  overlap)? A merged base commit is a **CI change** when its subject has the `ci`
  prefix **or** it changed `.github/workflows/**` or `.github/actions/**` — the
  path form mirrors the coordinator's rebase trigger, since a release-typed
  (`feat`/`fix`/`perf`) PR may now change CI without a `ci` prefix. A shipped
  `workflow_call` workflow counts too: the extra rebase after one merges is
  unnecessary but harmless, and it avoids parsing triggers.
- **Docs carve-out** — a breaking change and a `docs` change do not force each
  other current by existence alone, only through a shared file (the file-overlap
  fact still applies either way). A `docs:`-titled PR is not held by a breaking
  commit on the base (unless its own diff is itself breaking), and a breaking PR is
  not held when every commit the base moved by is `docs`-typed. The carve-out does
  **not** reach the CI clauses: a CI change can add a rule that enforces over docs
  files, so a `ci` change still forces a `docs` PR current in both directions.
- **Breaking change, PR-side** — is _this PR_ a breaking change? Declared only
  by the PR title's `!` marker; the check never reads or writes a
  `breaking change` label. It also reads the PR's **own diff** for a dependency
  **major** version bump, a **CI-sensitive** linter/formatter version change
  (`eslint`/`black`/`pylint`/`ruff`/`prettier`, any delta, since a formatter
  release can redden the format gate on files a PR never touched), and **material
  changes to existing test files** (both added _and_ removed lines, i.e. changed
  expectations rather than appended tests). Each is a reason to re-test the PR
  against a moved base even when its title is unmarked, so the diff only ever
  adds to the staleness verdict. Whether a PR _should_ carry `!` (the label, a
  dependency major bump) or the `ci` type (a linter bump) is title policy,
  enforced by [pr-policy](https://github.com/rmartz/pr-policy)'s title check, not
  here.
- **CI PR** — is the PR's own title a `ci:`/`ci(scope):` conventional commit,
  **or** does its own diff change `.github/workflows/**` or `.github/actions/**`?
  A CI change is only as good as the base it last ran against, so a
  stale CI PR is forced current before merge, symmetric to the `prIsBreaking`
  clause — **unless it is a `hotfix`**, which exempts this clause so a CI fix for
  a base whose own CI is red is not caught in a bind (the same escape hatch as
  base health, below). The exemption is CI-clause-only: the breaking and base-side
  clauses stay in force.
- **Conflicts** — does the PR merge cleanly, or is there a conflict?
- **Base health** — is the **base branch's own CI** failing? A red base blocks
  every PR **except a `hotfix`-labelled one**, so the fix for broken main still
  gets through while nothing else piles onto it. "Failing CI" is scoped to the base
  branch's **required status checks** (the contexts its ruleset declares define a
  mergeable base): a failing check that is one of them blocks, whoever produced it,
  while an arbitrary failing job that _isn't_ a merge gate — the native "Dependabot
  Updates" run, other bots, informational checks — never wedges the queue. If the
  required-check set can't be read (no ruleset, or a transient error), base health
  falls back to a coarser heuristic: a failing **GitHub Actions** run blocks, except
  a known non-build platform job (the Dependabot job) or a non-Actions producer (a
  deploy) — so a genuinely broken base is still caught in a repo with no queryable
  ruleset, without reintroducing the #40 false positive.

It then posts the `merge-safety` check-run with the verdict, and mirrors it to a
`merge-safety` commit status, which is what the merge gate can rely on (see
[the check-run contract](check-run-contract.md#the-commit-status-is-what-the-gate-relies-on)).
The verdict has three
states: **success** (safe to merge as-is), **pending** (the PR's only problem is
that it is stale, which a branch update clears), and **failure** (anything else).
An external transient error (an API quota, a GitHub outage) is not a verdict: the
run cancels itself instead of failing, as described in
[the check-run contract](check-run-contract.md#three-verdict-states).
A pending verdict is posted as an incomplete check-run, so it blocks the merge
without showing a red ✗; see
[the check-run contract](check-run-contract.md#three-verdict-states). It also
**reconciles the
labels** that surface the reason to humans and to the coordinator — the
update-required and merge-conflict labels — adding or removing each to match the
current facts. (The base-health axis mints no label; the `hotfix` label is an
_input_ base health reads, and its outcome is carried by the check-run
title/reason.)

merge-safety never touches `breaking change`. Until #82 it added the label
itself for a dependency major bump and read it as an input; both moved to
pr-policy, whose title check keeps the label and the title's `!` in step, so the
`!` alone is enough here.

Whether a PR may merge into a **non-default base** at all — e.g. holding a
stacked PR until its parent PR lands — is merge _policy_, not merge safety, and
is out of scope here: it belongs in `pr-policy`. merge-safety evaluates a stacked
PR against its actual base like any other.

## `invalidate` — the base moved (or its CI flipped)

On a push to a branch, `invalidate` fans out across **every other open PR based
on that branch**: it flips each one's `merge-safety` check back to pending and
re-dispatches its `evaluate`. The fan-out keys on the branch that was pushed (the
CLI's `--base-branch`), not on a hard-coded `main`: a repo whose default branch is
named otherwise is invalidated correctly, and a **stacked** child is re-evaluated
when its parent PR's branch moves, rather than holding a stale green while its
actual base advances underneath it. With no `--base-branch`, the CLI resolves the
repository default branch, and refuses rather than guessing if it cannot. This is what makes a moved base hold native auto-merge until each
PR has been re-checked against the new base, rather than letting a now-stale PR
merge itself. The dispatched `evaluate` completes that same pending run in place
with its verdict, rather than posting a second one beside it (see
[the check-run contract](check-run-contract.md#one-run-per-head-completed-in-place)).

It also fans out when the **base branch's own CI concludes** (a `check_suite`
completion on the default branch). A push-time re-evaluation sees the base's CI
still _pending_, so it is the concluded-CI event that actually re-holds
already-cleared PRs once base health flips — blocking non-hotfix PRs when the base
goes red, and releasing them when it goes green again. See
[consuming](consuming.md) for the caller trigger this needs.

## How the pieces fit

- **[The check-run contract](check-run-contract.md)** — the fleet-wide meaning of
  the `merge-safety` check-run name.
- **[Setting up merge-safety in a consuming repo](consuming.md)** — adopting it
  through merge-safety-action, and how the verdict behaves.
