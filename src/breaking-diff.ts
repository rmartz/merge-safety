/**
 * Breaking-change detection over a PR's **own** unified diff (#53).
 *
 * Until now `prIsBreaking` was read entirely from the PR title's `!` marker or a
 * `breaking change` label an LLM turn applies (`/review` Step 5 in the coordinator,
 * which shells to `breaking-change.py check-diff`). That made a *required,
 * merge-gating* check depend on a non-deterministic producer, and it failed in the
 * **permissive** direction: no `/review` run, or a reviewer who misread the diff,
 * and the PR was evaluated as non-breaking. These detectors are pure functions over
 * a diff, so the check derives the fact itself; the label remains an accepted input.
 *
 * Ported from `claude/scripts/breaking_change.py` in `rmartz/dotfiles`
 * (`has_major_version_bump` / `has_sensitive_package_bump` /
 * `has_material_test_changes`). Each returns the *specific* packages or files that
 * tripped it rather than a bare boolean, so the check-run can name them — the same
 * "one computation, two views" shape the base-commit and file-overlap facts use.
 *
 * Deliberately NOT ported: `add_breaking_marker` / `remove_breaking_marker` /
 * `reconcile_breaking_title`, which rewrite the PR *title* inside the squash-merge
 * transaction (with the release-please exemption). Detection moves here; stamping
 * stays in `merge-pr.py`, at a moment a PR-event action cannot reach.
 */

/** The kinds of breaking signal a PR's own diff can carry. */
export const BREAKING_DIFF_KINDS = [
  'major-version-bump',
  'sensitive-package-bump',
  'material-test-changes',
] as const;
export type BreakingDiffKind = (typeof BREAKING_DIFF_KINDS)[number];

/** One fired detector, with the packages / files that tripped it. */
export interface BreakingDiffSignal {
  kind: BreakingDiffKind;
  /** The specific package names or file paths, surfaced in the check-run reason. */
  detail: string[];
}

/**
 * Linters/formatters whose output can change CI results on files a PR never touched
 * — a `black`/`ruff`/`prettier` bump can redden the format/lint gate on every other
 * in-flight PR. For these, ANY version change (not just a major bump) is a signal.
 */
const CI_SENSITIVE_PACKAGES = new Set(['eslint', 'black', 'pylint', 'ruff', 'prettier']);

/**
 * `package.json` keys that carry a semver value but are **not** dependencies. The
 * motivating case is the manifest's own `version`: a release PR bumping `1.9.0` →
 * `2.0.0` would otherwise read as a dependency named "version" taking a major bump,
 * marking every major release PR breaking. (The Python original has this false
 * positive; it is not reproduced here.)
 */
const NON_DEPENDENCY_NPM_KEYS = new Set(['version']);

/** A package.json dependency line: `"name": "^1.2.3"` (caret/tilde/bare). */
const NPM_DEP_RE = /"([^"]+)"\s*:\s*"[\^~]?(\d+)\.(\d+)\.(\d+)/;

/** A pip requirement line: `name==1.2.3` / `name>=1.2` / `name~=1.2.3` (PEP 508-ish). */
const PIP_DEP_RE =
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:==|~=|>=|<=|!=|<|>)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/** Test files whose modification counts toward {@link materialTestChanges}. */
const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|test_[^/]*\.py|[^/]*_test\.py)$/;

/** The `b/`-side path of a `diff --git` header. */
const DIFF_HEADER_PATH_RE = / b\/(.+)$/;

type DependencyKind = 'npm' | 'pip';

interface DependencyChange {
  kind: DependencyKind;
  /** `-` for the pre-image line, `+` for the post-image line. */
  sign: '-' | '+';
  /** The raw (un-normalized) package name as it appeared in the manifest. */
  name: string;
  major: number;
  /** `major.minor.patch`, with absent components defaulted to 0. */
  version: string;
}

/**
 * Normalize a package name for comparison (PEP 503 / npm-ish): lower-case and
 * collapse runs of `-`/`_`/`.` to a single `-`, so `Black` and `my_pkg` compare
 * equal to `black` / `my-pkg`.
 */
function normalizePackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/** Classify a `diff --git` header as a dependency-manifest kind, or `null`. */
function dependencyFileKind(diffGitLine: string): DependencyKind | null {
  if (diffGitLine.includes('package.json')) return 'npm';
  if (/requirements[\w./-]*\.txt/.test(diffGitLine)) return 'pip';
  return null;
}

/** True for the `---` / `+++` file headers, which are not content lines. */
function isFileHeader(line: string): boolean {
  return line.startsWith('---') || line.startsWith('+++');
}

/**
 * Every dependency line changed inside a recognized manifest. Lines outside
 * `package.json` / `requirements*.txt` are skipped entirely, so an unrelated file
 * that happens to contain a version-shaped string is never read as a dependency.
 */
function dependencyChanges(diffText: string): DependencyChange[] {
  const changes: DependencyChange[] = [];
  let kind: DependencyKind | null = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      kind = dependencyFileKind(line);
      continue;
    }
    if (kind === null) continue;
    if (isFileHeader(line)) continue;
    if (!line.startsWith('-') && !line.startsWith('+')) continue;

    const sign = line[0] === '-' ? '-' : '+';
    const match = (kind === 'npm' ? NPM_DEP_RE : PIP_DEP_RE).exec(line.slice(1));
    if (!match) continue;

    const name = match[1] ?? '';
    if (kind === 'npm' && NON_DEPENDENCY_NPM_KEYS.has(name.trim().toLowerCase())) continue;

    const major = Number(match[2] ?? 0);
    const minor = Number(match[3] ?? 0);
    const patch = Number(match[4] ?? 0);
    changes.push({ kind, sign, name, major, version: `${major}.${minor}.${patch}` });
  }
  return changes;
}

/** Index dependency changes by `kind:normalized-name`, split by removed / added. */
function indexChanges(changes: readonly DependencyChange[]) {
  const removed = new Map<string, DependencyChange>();
  const added = new Map<string, DependencyChange>();
  for (const change of changes) {
    const key = `${change.kind}:${normalizePackageName(change.name)}`;
    (change.sign === '-' ? removed : added).set(key, change);
  }
  return { removed, added };
}

/**
 * Dependencies whose **major** version increased, as `name 2.x → 3.x`. Covers npm
 * (`package.json`) and pip (`requirements*.txt`) manifests. A dependency is keyed by
 * `(kind, normalized name)`, so the removed/added pair is matched regardless of the
 * surrounding diff context.
 */
export function majorVersionBumps(diffText: string): string[] {
  const { removed, added } = indexChanges(dependencyChanges(diffText));
  const bumps: string[] = [];
  for (const [key, addedChange] of added) {
    const removedChange = removed.get(key);
    if (removedChange && addedChange.major > removedChange.major) {
      bumps.push(`${addedChange.name} ${removedChange.version} → ${addedChange.version}`);
    }
  }
  return bumps;
}

/**
 * CI-sensitive linters/formatters whose version changed **at all**. Unlike
 * {@link majorVersionBumps}, any delta counts: a formatter release can change its
 * output and redden the format/lint gate on PRs that never touched the bumped file,
 * so every in-flight sibling must re-test under it after this merges.
 */
export function sensitivePackageBumps(diffText: string): string[] {
  const { removed, added } = indexChanges(dependencyChanges(diffText));
  const bumps: string[] = [];
  for (const [key, addedChange] of added) {
    if (!CI_SENSITIVE_PACKAGES.has(normalizePackageName(addedChange.name))) continue;
    const removedChange = removed.get(key);
    if (removedChange && removedChange.version !== addedChange.version) {
      bumps.push(`${addedChange.name} ${removedChange.version} → ${addedChange.version}`);
    }
  }
  return bumps;
}

/**
 * Existing test files modified with **both** added and removed lines. Pure additions
 * are new tests appended, not changed expectations; a file with both is a rewritten
 * assertion, which means the behavior it pinned moved — the same semantic-conflict
 * risk the file-overlap clause guards against.
 */
export function materialTestChanges(diffText: string): string[] {
  const changed: string[] = [];
  let file: string | null = null;
  let hasAdds = false;
  let hasRemoves = false;

  const flush = () => {
    if (file && hasAdds && hasRemoves && TEST_FILE_RE.test(file)) changed.push(file);
  };

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
      file = DIFF_HEADER_PATH_RE.exec(line)?.[1] ?? null;
      hasAdds = false;
      hasRemoves = false;
      continue;
    }
    if (isFileHeader(line)) continue;
    if (line.startsWith('+')) hasAdds = true;
    else if (line.startsWith('-')) hasRemoves = true;
  }
  flush();
  return changed;
}

/**
 * Every breaking signal the PR's own diff carries, in a stable order. An empty
 * array means the diff says nothing — the title `!` marker and the `breaking change`
 * label remain independent inputs the caller folds in.
 */
export function breakingDiffSignals(diffText: string): BreakingDiffSignal[] {
  const signals: BreakingDiffSignal[] = [];
  const major = majorVersionBumps(diffText);
  if (major.length) signals.push({ kind: 'major-version-bump', detail: major });
  const sensitive = sensitivePackageBumps(diffText);
  if (sensitive.length) signals.push({ kind: 'sensitive-package-bump', detail: sensitive });
  const tests = materialTestChanges(diffText);
  if (tests.length) signals.push({ kind: 'material-test-changes', detail: tests });
  return signals;
}

/** True when `signals` contains a signal of `kind`. */
export function hasSignal(signals: readonly BreakingDiffSignal[], kind: BreakingDiffKind): boolean {
  return signals.some((s) => s.kind === kind);
}

/** The detail list of `kind`, or `[]` when that detector did not fire. */
export function signalDetail(
  signals: readonly BreakingDiffSignal[],
  kind: BreakingDiffKind,
): readonly string[] {
  return signals.find((s) => s.kind === kind)?.detail ?? [];
}
