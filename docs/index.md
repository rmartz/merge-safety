---
okf_version: 0.2
---

# Documentation

Documentation for `@rmartz/merge-safety`, written in
[Open Knowledge Format](okf-format.md).

- [What merge-safety is](overview.md) — the pre-auto-merge verdict, the
  `evaluate` / `invalidate` operations, and the check-run + labels it manages.
- [Setting up merge-safety in a consuming repo](consuming.md) — the thin caller
  workflow, the write scopes it grants, and how the pin stays current.
- [The check-run contract](check-run-contract.md) — why the check-run name
  `merge-safety` is a fleet contract that cannot be renamed locally.
- [The extraction migration](migration.md) — how this package was split out
  of `@rmartz/pr-review` (ai-tools#247) and the now-locked layer-0 decisions.
- [The OKF documentation format](okf-format.md) — how these pages are structured
  and validated in this repo.
