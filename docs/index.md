---
okf_version: 0.2
---

# Documentation

Documentation for `@rmartz/merge-safety`, written in
[Open Knowledge Format](okf-format.md).

- [What merge-safety is](overview.md) — the pre-auto-merge verdict, the
  `evaluate` / `invalidate` operations, and the check-run + labels it manages.
- [Setting up merge-safety in a consuming repo](consuming.md) — adopting it
  through merge-safety-action, the labels and required check it needs, and how
  base health and `hotfix` behave.
- [The two fact sources](fact-sources.md) — the git-backed runner the CLI uses,
  the API-backed runner for hosts with no checkout, and where the API one fails
  closed.
- [The check-run contract](check-run-contract.md) — why the check-run name
  `merge-safety` is a fleet contract that cannot be renamed locally.
- [The OKF documentation format](okf-format.md) — how these pages are structured
  and validated in this repo.
