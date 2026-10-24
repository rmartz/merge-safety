---
type: Reference
title: The two fact sources
description: Where merge-safety's git facts come from — the git-backed runner the CLI uses by default, and the API-backed runner for hosts with no checkout — how the API source maps each query to the REST API, and where it fails closed.
tags: [merge-safety, facts, github-api, library]
---

# The two fact sources

`gatherMergeSafetyFacts` (`src/merge-safety-facts.ts`) never runs `git` itself.
It asks a **`GitRunner`** — a function from a `git` argv to its stdout — for
seven queries: the merge base, the base tip, the base commits since the merge
base (messages, then each commit's files), both changed-file lists, and the PR's
`--unified=0` patch. Two runners plug into its `git` option, and both are
exported from the package root.

| Source                            | Needs                         | Used by                                                          |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `makeGitRunner(cwd)`              | a `git` binary and a checkout | the `merge-safety` CLI, always (default)                         |
| `makeApiGitRunner({ repo, api })` | a GitHub REST `GET` client    | in-process callers with no checkout, such as a hosted GitHub App |

The CLI and [merge-safety-action](consuming.md) always use the git-backed
source; nothing switches them to the API source. A caller opts in by passing the
API runner as `git`:

```ts
import {
  gatherMergeSafetyFacts,
  makeApiGitRunner,
  evaluateMergeSafety,
} from '@rmartz/merge-safety';

const git = makeApiGitRunner({
  repo: 'owner/name',
  // Return the parsed JSON body, or null on a failed read. Throwing propagates unchanged.
  api: async (path) => (await octokit.request(`GET /${path}`)).data,
});
const facts = await gatherMergeSafetyFacts(meta, {
  baseRef: 'main',
  git,
  baseChecks,
  requiredChecks,
});
const decision = evaluateMergeSafety(facts);
```

Create one API runner per evaluation: it caches the comparison it loads.

## How the API source answers each query

| `git` query                                    | REST source                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `rev-parse <base>`                             | `GET /repos/{o}/{r}/branches/{branch}` → `commit.sha`                    |
| `merge-base <head> <base>`                     | `GET /repos/{o}/{r}/compare/{head}...{tip}` → `merge_base_commit.sha`    |
| `log -z --format=%H%n%B <mb>..<base>`          | that compare's `commits[]` (`sha`, `commit.message`), newest first       |
| `log --format=%x00%H --name-only <mb>..<base>` | `GET /repos/{o}/{r}/commits/{sha}` → `files[].filename`, per base commit |
| `diff --name-only <mb> <base>`                 | the same compare's `files[].filename`                                    |
| `diff --name-only <mb> <head>`                 | `GET /repos/{o}/{r}/compare/{tip}...{head}` → `files[].filename`         |
| `diff --unified=0 <mb> <head>`                 | that compare's `files[].patch`, each under a `diff --git` header         |

Currency is still `merge base == base tip`; in the first compare that is the
same as `ahead_by == 0` (no base commits the PR lacks). The per-commit reads run
with bounded concurrency (8 by default) and skip merge commits, whose files
`git log --name-only` does not list either. The compare patches carry three
context lines rather than zero, which the breaking-diff detectors ignore: they
read only the `diff --git` headers and the `+`/`-` lines.

The test suite builds each scenario once and runs it through both sources,
asserting identical facts (`test/api-fact-source.test.ts`).

## Where the API source fails closed

The REST API truncates silently, so the API source throws — and the caller
reports the existing **Could not evaluate** failure — instead of judging partial
data:

- the base moved by more than **250 commits** (`total_commits` exceeds the
  `commits[]` returned);
- either compare lists **300 files**, the compare API's cap;
- a PR file has changed lines but **no `patch`** (GitHub omits it for an oversized
  diff). A file with no changed lines and no patch — a binary, a pure rename —
  is kept with only its header, which is all `git diff --unified=0` gives the
  detectors for it too;
- a base commit lists **300 files** (the commit API's unpaginated cap) and none of
  them is a CI path;
- an API read returns `null`, or `gatherMergeSafetyFacts` makes a `git` query the
  API source does not map.

`baseRef` must name a branch (`main`, `origin/main` or `refs/heads/main`): the
base tip is read from the branches endpoint.
