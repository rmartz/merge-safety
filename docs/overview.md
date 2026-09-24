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

It ships as one CLI, `ai-merge-safety`, with two operations that the
[reusable workflow](consuming.md) dispatches by event:

## `evaluate` — one PR

On a pull-request event (or a `workflow_dispatch` naming a PR), `evaluate`
gathers the safety **facts** for that one PR against its base:

- **Base currency** — is the PR's branch behind its base in a way that matters?
- **Breaking change** — did something merge into the base that this PR must be
  re-tested against (a breaking-change signal or a real file overlap)?
- **Breaking change, PR-side — self-derived** — is _this PR_ a breaking change?
  The PR title's `!` marker and a `breaking change` label are still read, but the
  verdict no longer depends on them: it also reads the PR's **own diff** for a
  dependency **major** version bump, a **CI-sensitive** linter/formatter version
  change (`eslint`/`black`/`pylint`/`ruff`/`prettier` — any delta, since a
  formatter release can redden the format gate on files a PR never touched), and
  **material changes to existing test files** (both added _and_ removed lines,
  i.e. changed expectations rather than appended tests). Before this, a required,
  merge-gating check read that fact from a label an LLM turn writes, and failed
  **permissively** when that turn had not run. The diff can only ever _add_ a
  reason to treat a PR as breaking, so this is strictly additive.
- **CI-sensitive bump without the `ci` type** — a linter/formatter bump must force
  every in-flight sibling to re-test under it after merge, and only the merged
  subject can carry that: a `ci` prefix, or a `!` marker. The `!` route is closed
  here — merge stamps `!` only on functional types (`feat`/`fix`/`perf`/`revert`)
  and **strips** a `breaking change` label off anything else — so on a non-`ci`
  title there is no route at all. The check holds the PR and asks for the retitle
  rather than applying a label that would be removed at merge. Unlike the staleness
  clauses this applies even to an already-current PR: merging under the wrong title
  loses the signal just as permanently.
- **CI-typed PR** — is the PR's own title a `ci:`/`ci(scope):` conventional
  commit? A CI change is only as good as the base it last ran against, so a
  stale CI PR is forced current before merge, symmetric to the `prIsBreaking`
  clause — **unless it is a `hotfix`**, which exempts this clause so a CI fix for
  a base whose own CI is red is not caught in a bind (the same escape hatch as
  base health, below). The exemption is CI-clause-only: the breaking and base-side
  clauses stay in force.
- **Conflicts** — does the PR merge cleanly, or is there a conflict?
- **Stacked base** — is the PR's base branch the head of **another open PR**? Such
  a PR is _stacked_: it must not merge until its base PR does, after which GitHub
  retargets it to the default branch and it merges normally. Review and fixes carry
  on meanwhile — only the merge is held. Two deliberate narrowings keep this from
  stranding anything: a base branch with **no open PR** is never barred (nothing
  will ever land to release it), and a base PR labelled as a long-lived
  **accumulator** — a `release` train, the top of an `epic` stack — exempts its
  children, since those are designed to be merged into. The exempt vocabulary is a
  workflow input (`stacked-base-exempt-labels`), not a hard-coded label set, because
  the check-run is a fleet contract and that policy belongs to the caller. An
  unresolvable default branch disables the axis rather than holding every PR.
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

It then posts the `merge-safety` check-run with the verdict and **reconciles the
labels** that surface the reason to humans and to the coordinator — the
update-required and merge-conflict labels — adding or removing each to match the
current facts. (The base-health and stacked-base axes mint no
label; the `hotfix` label is an _input_ base health reads, and both outcomes are
carried by the check-run title/reason.)

One label is handled differently. **`breaking change` is add-only**: the check
applies it when the diff proves a dependency **major** bump _and_ the PR's title
type is functional, so the label will survive to become a `!` on the squashed
subject — and it **never removes it**, so a human's or an agent's explicit
judgment is never silently reverted. It is deliberately _not_ applied for the
other two diff signals: a CI-sensitive bump is answered by the `ci` retitle
above, and a changed test expectation is a staleness signal rather than a public
API break. Labelling either would stamp `!` on a functional-typed PR and fire a
spurious semantic-release **major**. (Detection lives here; the title stamping
stays in the coordinator's merge transaction, which is the only place that can
rewrite a subject and holds the release-please exemption.)

One label is handled differently. **`breaking change` is add-only**: the check
applies it when the diff proves a dependency **major** bump _and_ the PR's title
type is functional, so the label will survive to become a `!` on the squashed
subject — and it **never removes it**, so a human's or an agent's explicit
judgment is never silently reverted. It is deliberately _not_ applied for the
other two diff signals: a CI-sensitive bump is answered by the `ci` retitle
above, and a changed test expectation is a staleness signal rather than a public
API break. Labelling either would stamp `!` on a functional-typed PR and fire a
spurious semantic-release **major**. (Detection lives here; the title stamping
stays in the coordinator's merge transaction, which is the only place that can
rewrite a subject and holds the release-please exemption.)

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
