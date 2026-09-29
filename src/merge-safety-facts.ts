/**
 * Fact-gathering for the merge-safety verdict. Impure — it shells to `git` — but
 * the subprocess is injected as a {@link GitRunner}, so the assembly logic is
 * unit-testable with a fake and the bin wires the real runner. All *judgment*
 * stays in the pure `merge-safety` module; this file only turns `git` output into
 * the boolean facts that module consumes.
 */
import { boundedRun } from './lib/bounded-subprocess.js';
import { breakingDiffSignals } from './breaking-diff.js';
import { DEFAULT_EXEMPT_BASE_LABELS, stackedParentPr, type BasePr } from './stacked-base.js';
import {
  failingFallbackBaseChecks,
  failingRequiredBaseChecks,
  isBreakingCommitMessage,
  isBreakingTitle,
  isCiCommitMessage,
  isCiTitle,
  isDocsCommitMessage,
  isDocsTitle,
  mayCarryBreakingMarker,
  overlappingFiles,
  BREAKING_LABEL,
  HOTFIX_LABEL,
  type BaseCheckRun,
  type BaseCommit,
  type MergeSafetyFacts,
} from './merge-safety.js';

/** Runs a `git` argv and yields stdout, or `null` on non-zero exit / failure. */
export type GitRunner = (args: string[]) => Promise<string | null>;

/**
 * Fetches the base branch tip's check-runs (deduped to the latest per name) so
 * base-health can be judged. Injected like {@link GitRunner} so the assembly logic
 * stays testable with a fake and the network boundary lives in the bin. Soft-fails
 * to `[]` (an unreadable base is treated as *not* failing) so a transient `gh`
 * error never wedges the whole merge queue on a base-health false positive.
 */
export type BaseChecksProbe = (baseSha: string) => Promise<readonly BaseCheckRun[]>;

/**
 * Fetches the base branch's **required status check** contexts — the set base-health
 * scopes failures to (#40). Returns `null` when protection can't be read (transient
 * `gh` error, no ruleset, missing scope); a `null` or empty set means base-health
 * reports no failure, so a probe hiccup never wedges the merge queue. Injected like
 * {@link BaseChecksProbe}, with the network boundary in the bin.
 */
export type RequiredChecksProbe = (baseBranch: string) => Promise<readonly string[] | null>;

/**
 * Fetches the open PR whose **head** is a given branch — this PR's stacked parent
 * (#54) — or `null` when no open PR heads it. A failed probe also yields `null`,
 * which deliberately reads as "not stacked": an unreadable lookup must not hold a
 * PR that may not be stacked at all, the same never-wedge posture as the check
 * probes above. Injected like {@link BaseChecksProbe}.
 */
export type BasePrProbe = (baseBranch: string) => Promise<BasePr | null>;

const GIT_TIMEOUT_MS = 30_000;

/**
 * The plain branch name for a base ref (`origin/main` → `main`, `refs/heads/x` →
 * `x`), as the required-status-checks API keys on the branch, not a remote-qualified
 * ref. Only a leading `refs/heads/` or `origin/` is stripped — a non-`origin` remote
 * would leave its prefix, in which case the required-checks probe soft-fails to
 * `null` (no gate) rather than mis-querying.
 */
export function baseBranchName(baseRef: string): string {
  return baseRef.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

/** The real `git` runner, bounded and rooted at `cwd`. */
export function makeGitRunner(cwd?: string): GitRunner {
  return async (args) => {
    const r = await boundedRun('git', args, { timeoutMs: GIT_TIMEOUT_MS, cwd });
    return r.code === 0 ? r.stdout : null;
  };
}

/** PR metadata the gatherer needs beyond what git derives (from `gh pr view --json`). */
export interface PrMergeMeta {
  headSha: string;
  title: string;
  labels: readonly string[];
  /** `gh`'s `mergeable`: `MERGEABLE` | `CONFLICTING` | `UNKNOWN`. */
  mergeable: string;
}

export interface GatherOptions {
  /** Base branch ref to compare against (default `origin/main`). */
  baseRef?: string;
  git: GitRunner;
  /** Probe for the base tip's check-runs, used to judge base health. */
  baseChecks: BaseChecksProbe;
  /** Probe for the base branch's required status checks, scoping base health (#40). */
  requiredChecks: RequiredChecksProbe;
  /**
   * Probe for the open PR heading this PR's base branch, driving the barrier (#54).
   * Optional: a caller with no interest in the barrier may omit it, and the default
   * reports "nothing heads the base" — the barrier is inert rather than guessing.
   */
  basePr?: BasePrProbe;
  /**
   * The repository default branch. `null`/absent **disables the stacked barrier**
   * rather than treating every PR as stacked — an unresolved default branch must
   * never strand the whole open set.
   */
  defaultBranch?: string | null;
  /**
   * Labels on a base branch's tracking PR that exempt its children from the
   * barrier (a `release` train, an `epic` stack's top). Defaults to
   * {@link DEFAULT_EXEMPT_BASE_LABELS}; a consumer overrides it via the reusable
   * workflow's `stacked-base-exempt-labels` input.
   */
  exemptBaseLabels?: readonly string[];
}

function splitLines(out: string | null): string[] {
  return (out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parse `git log -z --format=%H%n%B` into `{ sha, message }` records. `-z`
 * NUL-terminates each commit; within a record the first line is the SHA and the
 * remainder is the full message (subject + body), so breaking-footer detection
 * still sees the whole body.
 */
function parseBaseCommits(logOut: string): { sha: string; message: string }[] {
  return logOut
    .split('\0')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const newline = record.indexOf('\n');
      const sha = (newline === -1 ? record : record.slice(0, newline)).trim();
      const message = newline === -1 ? '' : record.slice(newline + 1).trim();
      return { sha, message };
    });
}

/**
 * Paths whose change is a CI change regardless of the commit/PR title (#67): the
 * workflows and local composite actions. Mirrors the coordinator's path-based
 * `_pr_needs_branch_update` trigger (rmartz/dotfiles#1581), which lets a
 * release-typed PR change CI without a `ci` prefix. A shipped `workflow_call`
 * workflow is deliberately included — an extra sibling rebase after one merges is
 * unnecessary but harmless, and it avoids parsing triggers.
 */
const CI_PATH_RE = /^\.github\/(?:workflows|actions)\//;

/** True when a repo-relative path is a workflow or local action. */
export function isCiPath(path: string): boolean {
  return CI_PATH_RE.test(path);
}

/**
 * Parse `git log --format=%x00%H --name-only` into the SHAs of commits that
 * changed a CI path. Each NUL-led record is the SHA line followed by that
 * commit's changed files.
 */
function parseCiPathShas(logOut: string): Set<string> {
  const shas = new Set<string>();
  for (const record of logOut.split('\0')) {
    const [sha, ...files] = splitLines(record);
    if (sha && files.some(isCiPath)) shas.add(sha);
  }
  return shas;
}

/** Base commits matching `predicate`, projected to the surfaced `{ sha, subject }` shape. */
function selectCommits(
  commits: readonly { sha: string; message: string }[],
  predicate: (commit: { sha: string; message: string }) => boolean,
): BaseCommit[] {
  return commits
    .filter(predicate)
    .map((c) => ({ sha: c.sha, subject: c.message.split('\n', 1)[0] ?? '' }));
}

/**
 * Assemble {@link MergeSafetyFacts} for one PR. Throws when the merge-base or base
 * tip can't be resolved — the caller must treat an ungatherable PR as unsafe
 * (fail the check) rather than let a stale green through.
 */
export async function gatherMergeSafetyFacts(
  meta: PrMergeMeta,
  {
    baseRef = 'origin/main',
    git,
    baseChecks,
    requiredChecks,
    basePr = async () => null,
    defaultBranch = null,
    exemptBaseLabels = DEFAULT_EXEMPT_BASE_LABELS,
  }: GatherOptions,
): Promise<MergeSafetyFacts> {
  const mergeBase = (await git(['merge-base', meta.headSha, baseRef]))?.trim();
  const baseTip = (await git(['rev-parse', baseRef]))?.trim();
  if (!mergeBase || !baseTip) {
    throw new Error(`could not resolve merge-base/base tip for ${meta.headSha}..${baseRef}`);
  }

  const isCurrent = mergeBase === baseTip;

  // Base health is judged against the base *tip* (resolved above), independent of
  // this PR's diff — a red base blocks non-hotfix PRs regardless of staleness. Only
  // the base branch's *required* status checks count, so an arbitrary failing job
  // (e.g. the native "Dependabot Updates" run) never wedges the queue (#40). When
  // that required set can't be read (no ruleset / transient error), fall back to the
  // failing-Actions heuristic (minus the non-build denylist) so a genuinely broken
  // base is still caught in repos without a queryable ruleset.
  const baseBranch = baseBranchName(baseRef);
  const checks = await baseChecks(baseTip);
  const required = await requiredChecks(baseBranch);
  const failingBaseChecks =
    required && required.length > 0
      ? failingRequiredBaseChecks(checks, required)
      : failingFallbackBaseChecks(checks);

  // Capture each base commit's SHA (`%H`) alongside its body (`%B`) so a triggering
  // commit can be named in the report; `-z` NUL-terminates records for a clean split.
  const logOut = await git(['log', '-z', '--format=%H%n%B', `${mergeBase}..${baseRef}`]);
  if (logOut === null) throw new Error(`git log failed for ${mergeBase}..${baseRef}`);
  const commits = parseBaseCommits(logOut);
  const baseBreakingCommits = selectCommits(commits, (c) => isBreakingCommitMessage(c.message));

  // A base commit is a CI change by its `ci` prefix *or* by touching a CI path
  // (#67), so a release-typed commit that changed a workflow still re-tests siblings.
  const fileLogOut = await git([
    'log',
    '--format=%x00%H',
    '--name-only',
    `${mergeBase}..${baseRef}`,
  ]);
  if (fileLogOut === null) throw new Error(`git log failed for ${mergeBase}..${baseRef}`);
  const ciPathShas = parseCiPathShas(fileLogOut);
  const baseCiCommits = selectCommits(
    commits,
    (c) => isCiCommitMessage(c.message) || ciPathShas.has(c.sha),
  );

  const baseFilesOut = await git(['diff', '--name-only', mergeBase, baseRef]);
  if (baseFilesOut === null) throw new Error(`git diff failed for ${mergeBase}..${baseRef}`);
  const baseFiles = splitLines(baseFilesOut);

  const prFilesOut = await git(['diff', '--name-only', mergeBase, meta.headSha]);
  if (prFilesOut === null) throw new Error(`git diff failed for ${mergeBase}..${meta.headSha}`);
  const prFiles = splitLines(prFilesOut);
  const overlaps = overlappingFiles(prFiles, baseFiles);

  // The PR's own patch, for the diff-derived breaking signals (#53). `--unified=0`
  // drops every context line: the detectors read only `+`/`-` lines and the
  // `diff --git` headers, so it is the same answer off a fraction of the bytes —
  // which matters because `boundedRun` accumulates stdout in memory unbounded.
  const prDiff = await git(['diff', '--unified=0', mergeBase, meta.headSha]);
  if (prDiff === null) throw new Error(`git diff failed for ${mergeBase}..${meta.headSha}`);
  const diffSignals = breakingDiffSignals(prDiff);

  // Only a non-default base can be stacked, so the probe is skipped entirely in the
  // ordinary case — one fewer API call on every PR targeting the default branch.
  const parentPr = defaultBranch && baseBranch !== defaultBranch ? await basePr(baseBranch) : null;
  const stackedOnPr = stackedParentPr({
    baseBranch,
    defaultBranch,
    basePr: parentPr,
    exemptLabels: exemptBaseLabels,
  });

  const labels = meta.labels.map((l) => l.toLowerCase());

  return {
    isCurrent,
    // Each boolean is derived from its detail list — one computation, two views.
    baseBreakingSinceMergeBase: baseBreakingCommits.length > 0,
    baseCiSinceMergeBase: baseCiCommits.length > 0,
    // Additive by construction: the title marker and the label remain inputs, and
    // the diff can only ever add a reason to treat the PR as breaking (#53).
    prIsBreaking:
      isBreakingTitle(meta.title) || labels.includes(BREAKING_LABEL) || diffSignals.length > 0,
    prIsDocs: isDocsTitle(meta.title),
    baseOnlyDocsSinceMergeBase:
      commits.length > 0 && commits.every((c) => isDocsCommitMessage(c.message)),
    // Title or path (#67): a release-typed PR that changes CI is still re-tested.
    prIsCi: isCiTitle(meta.title) || prFiles.some(isCiPath),
    fileOverlap: overlaps.length > 0,
    hasConflict: meta.mergeable.toUpperCase() === 'CONFLICTING',
    baseCiFailing: failingBaseChecks.length > 0,
    prIsHotfix: labels.includes(HOTFIX_LABEL),
    baseBreakingCommits,
    baseCiCommits,
    overlappingFiles: overlaps,
    failingBaseChecks,
    prBreakingDiffSignals: diffSignals,
    prMayCarryBreakingMarker: mayCarryBreakingMarker(meta.title),
    baseBranch,
    stackedOnPr,
  };
}
