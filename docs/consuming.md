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

## 1. Add the caller workflow

The [`@rmartz/bootstrap`](https://github.com/rmartz/ai-tools) `ai-ensure-project-config`
step seeds this file (policy `seed`: seeded once, then owned by Dependabot — not
re-managed by bootstrap, so the pin can move). What it seeds:

```yaml
# .github/workflows/merge-safety.yml
name: merge-safety
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]
  push:
    branches: [main]
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

Why each piece is there:

- **The caller carries the triggers.** A reusable workflow can't declare
  `on: pull_request`/`push`; the caller does and passes the event context in. The
  `evaluate`-vs-`invalidate` branch and the label-narrowing logic live inside the
  [reusable workflow](../.github/workflows/merge-safety.yml), so the caller stays
  thin.
- **Write scopes, not read-only.** Effective permissions are the intersection of
  caller-granted and workflow-declared, so the caller must grant the full
  `checks` / `pull-requests` / `actions: write` set.
- **`workflow_dispatch` `pr` threading** — the `invalidate` fan-out re-dispatches
  each PR via `workflow_dispatch`, and the `pr` input passes through `with:`.
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

## 3. Require the check

Add `merge-safety` to the repo's **required status checks** on the default branch.
The name must be exactly `merge-safety` — see
[the check-run contract](check-run-contract.md). This is what makes native
auto-merge wait for the safety verdict.

**Auth:** the published `@rmartz/merge-safety` package is **public** on GitHub
Packages, readable with the built-in `GITHUB_TOKEN` — the `packages: read`
permission above is all the install needs, no per-repo PAT.
