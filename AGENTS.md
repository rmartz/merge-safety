# Agent guide — @rmartz/merge-safety

This repo is the standalone home of `@rmartz/merge-safety`: the pre-auto-merge
safety verdict for a pull request (base-currency, breaking-change, and conflict
facts), posted as the `merge-safety` check-run, plus the **reusable workflow**
(`.github/workflows/merge-safety.yml`) that distributes it to consuming repos —
pinned by version and kept current by Dependabot. See [README.md](README.md) and
the [documentation](docs/index.md).

It was extracted from `@rmartz/pr-review` per **ai-tools#247**, mirroring the
`rmartz/repo-hygiene` split. The `evaluate` / `invalidate` implementation and the
`ai-merge-safety` bin now live in `src/` alongside the package's stable public
contract (shipped in v0.1.0). The record of how it was extracted, the (now-locked)
layer-0 dependency decisions, and the ai-tools-side cutover this repo coordinates
are in [docs/migration.md](docs/migration.md).

## The check-run name is a fleet contract

The check-run this package posts is named **`merge-safety`**, and that name is a
**fleet contract**: every consumer repo has a required status check of exactly
that name and the auto-merge gate (`goldenGateChecks`) keys off it. Treat
`MERGE_SAFETY_CHECK_NAME` (`src/index.ts`) as frozen — renaming it is a
coordinated cross-repo migration, never a local refactor. See
[docs/check-run-contract.md](docs/check-run-contract.md).

## Documentation — update it as part of every task

Treat documentation as part of the change, not an afterthought. On **every**
task:

- **Read first.** Before editing code, read the relevant `docs/` page(s) and this
  file, so your change is consistent with what is already documented.
- **Update and correct in the same PR.** If your change adds, alters, or
  contradicts anything a doc says — a fact merge-safety gathers, a CLI flag, a
  workflow input, an interface — fix that doc in the same PR. An outdated doc is
  worse than no doc.
- **Correct drift you notice.** If you pass a doc that is stale or wrong while
  doing something else, fix it (or, if out of scope, note it) — do not leave
  known-wrong documentation in place.
- **Docs follow OKF.** Pages under `docs/` use Open Knowledge Format frontmatter
  (`type` required; `title`/`description`/`resource`/`tags` as applicable) and
  stay reachable from [docs/index.md](docs/index.md). The `okf` and `okf-index`
  checks enforce this in CI — see [docs/okf-format.md](docs/okf-format.md).

## Repository conformance

This repo is held to the shared
[repository checklist](https://github.com/rmartz/ai/blob/main/docs/guidance/repository-checklist.md),
and it **self-manages** its own config: fix conformance gaps directly here, in a
PR. Bootstrap (`ai-ensure-*`) is a one-time new-repo **starter**, not an ongoing
manager — do not defer a fix to a bootstrap re-run, and do not treat a `.github/`
file as off-limits just because bootstrap once seeded it.

- **Hygiene arrives the self-updating way:** this repo consumes
  `@rmartz/repo-hygiene` through the [`repo-hygiene.yml`](.github/workflows/repo-hygiene.yml)
  caller, pinned and bumped by Dependabot; it runs conflict-markers, action-pins,
  package-pins, docs-links, md-pairing, okf, okf-index, and file-caps against our
  own tree.
- **CI, releases, and labels are owned here:** typecheck / lint / format / test /
  build / package ([ci.yml](.github/workflows/ci.yml)), the PR-title lint, the
  tag-driven release ([release.yml](.github/workflows/release.yml)), and the hardened
  `dependabot.yml` are all in place. `ai-ensure-labels` / `ai-verify-squash-setting`
  remain useful one-shot helpers, but this repo owns its `.github/` config going
  forward.

## Common commands

```bash
pnpm install                 # deps (run in each worktree first)
pnpm run build               # tsup → dist (ESM + d.ts)
pnpm run typecheck           # tsc --noEmit
pnpm run lint                # eslint (incl. max-lines caps)
pnpm run format:check        # prettier --check
pnpm run test                # vitest
```

Before pushing, run `ai-pre-push-verify -C <worktree>` and fix every failure — it
re-runs the actual CI checks locally so a green result predicts CI.

## Code standards

Most are enforced by eslint; the intent:

- **Strict TypeScript.** No `any`, no `@ts-ignore` (use `@ts-expect-error` with a
  reason). Favor type inference; explicit generic args are a smell.
- **Named exports only**; no default exports. No IIFEs. Prefer `async/await` over
  `.then()`.
- **Value sets:** default to a structural string union or `as const` array over an
  `enum` (reserve `enum` for internal-only sets never serialized raw).
- **File caps:** `max-lines` 480 (src) / 720 (tests) via eslint; non-TS files are
  capped by the `file-caps` check per [`.repo-hygiene.yml`](.repo-hygiene.yml).
  The response to a cap is extraction, never terser code.
- **Pin dependencies** to full `major.minor.patch` (keep the `^`), and **SHA-pin**
  every third-party GitHub Action with a `# vX.Y.Z` comment — both dogfooded by
  the `package-pins` / `action-pins` checks the hygiene caller runs.
- **When you shell out**, wrap the subprocess (through the inlined `boundedRun`
  helper in `src/lib/`, mirroring repo-hygiene) — never call `git` ad hoc.

## Worktrees, PRs, and releases

- **Work in a dedicated worktree** under `.git-worktrees/` (`ai-new-worktree`),
  never on `main` in the root checkout. Run `pnpm install` in a fresh worktree
  before building. (The one exception was the genesis scaffold commit, which had
  no prior branch to base a worktree on.)
- **PR titles must be Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`,
  …). The repo squash-merges using the **PR title**, so it is the only subject that
  reaches `main`; a conventional title keeps `git log` and the release notes'
  auto-grouping readable. (Titles are lint-checked; nothing parses PR _body_ text.)
- **Releases are tag-driven**, not automated by a bot. Cut one with
  `pnpm version <patch|minor|major>` (bumps `package.json`, commits, tags `vX.Y.Z`)
  then `git push --follow-tags`; pushing the tag runs
  [release.yml](.github/workflows/release.yml), which publishes to GitHub Packages
  (public) and creates a GitHub Release with generated notes using only the
  built-in `GITHUB_TOKEN` (no release-please, no PAT). The version the reusable
  workflow installs is resolved at runtime from its own pinned commit
  (`job.workflow_sha` → `package.json`), so it lives only in `package.json` — never
  duplicated into a workflow file.

## Agent directive files

- **`AGENTS.md` is the single source of truth** for a directory's agent
  instructions — author directives here, never in `CLAUDE.md`.
- **Every `AGENTS.md` has a companion `CLAUDE.md`** in the same directory (and
  vice versa); the `CLAUDE.md` is a bare wrapper whose only content is
  `@AGENTS.md`. The pairing is enforced by the `md-pairing` check.
