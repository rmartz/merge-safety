/**
 * Fact-gathering for the merge-safety verdict. Impure — it shells to `git` — but
 * the subprocess is injected as a {@link GitRunner}, so the assembly logic is
 * unit-testable with a fake and the bin wires the real runner. All *judgment*
 * stays in the pure `merge-safety` module; this file only turns `git` output into
 * the boolean facts that module consumes.
 */
import { boundedRun } from './lib/bounded-subprocess.js';
import {
  failingBaseCiCheckNames,
  isBreakingCommitMessage,
  isBreakingTitle,
  isCiCommitMessage,
  overlappingFiles,
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

const GIT_TIMEOUT_MS = 30_000;

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
}

/** The `breaking change` label forces `prIsBreaking` regardless of the title. */
const BREAKING_LABEL = 'breaking change';

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

/** Base commits matching `predicate`, projected to the surfaced `{ sha, subject }` shape. */
function selectCommits(
  commits: readonly { sha: string; message: string }[],
  predicate: (message: string) => boolean,
): BaseCommit[] {
  return commits
    .filter((c) => predicate(c.message))
    .map((c) => ({ sha: c.sha, subject: c.message.split('\n', 1)[0] ?? '' }));
}

/**
 * Assemble {@link MergeSafetyFacts} for one PR. Throws when the merge-base or base
 * tip can't be resolved — the caller must treat an ungatherable PR as unsafe
 * (fail the check) rather than let a stale green through.
 */
export async function gatherMergeSafetyFacts(
  meta: PrMergeMeta,
  { baseRef = 'origin/main', git, baseChecks }: GatherOptions,
): Promise<MergeSafetyFacts> {
  const mergeBase = (await git(['merge-base', meta.headSha, baseRef]))?.trim();
  const baseTip = (await git(['rev-parse', baseRef]))?.trim();
  if (!mergeBase || !baseTip) {
    throw new Error(`could not resolve merge-base/base tip for ${meta.headSha}..${baseRef}`);
  }

  const isCurrent = mergeBase === baseTip;

  // Base health is judged against the base *tip* (resolved above), independent of
  // this PR's diff — a red base blocks non-hotfix PRs regardless of staleness.
  const failingBaseChecks = failingBaseCiCheckNames(await baseChecks(baseTip));

  // Capture each base commit's SHA (`%H`) alongside its body (`%B`) so a triggering
  // commit can be named in the report; `-z` NUL-terminates records for a clean split.
  const logOut = await git(['log', '-z', '--format=%H%n%B', `${mergeBase}..${baseRef}`]);
  if (logOut === null) throw new Error(`git log failed for ${mergeBase}..${baseRef}`);
  const commits = parseBaseCommits(logOut);
  const baseBreakingCommits = selectCommits(commits, isBreakingCommitMessage);
  const baseCiCommits = selectCommits(commits, isCiCommitMessage);

  const baseFilesOut = await git(['diff', '--name-only', mergeBase, baseRef]);
  if (baseFilesOut === null) throw new Error(`git diff failed for ${mergeBase}..${baseRef}`);
  const baseFiles = splitLines(baseFilesOut);

  const prFilesOut = await git(['diff', '--name-only', mergeBase, meta.headSha]);
  if (prFilesOut === null) throw new Error(`git diff failed for ${mergeBase}..${meta.headSha}`);
  const prFiles = splitLines(prFilesOut);
  const overlaps = overlappingFiles(prFiles, baseFiles);

  const labels = meta.labels.map((l) => l.toLowerCase());

  return {
    isCurrent,
    // Each boolean is derived from its detail list — one computation, two views.
    baseBreakingSinceMergeBase: baseBreakingCommits.length > 0,
    baseCiSinceMergeBase: baseCiCommits.length > 0,
    prIsBreaking: isBreakingTitle(meta.title) || labels.includes(BREAKING_LABEL),
    fileOverlap: overlaps.length > 0,
    hasConflict: meta.mergeable.toUpperCase() === 'CONFLICTING',
    baseCiFailing: failingBaseChecks.length > 0,
    prIsHotfix: labels.includes(HOTFIX_LABEL),
    baseBreakingCommits,
    baseCiCommits,
    overlappingFiles: overlaps,
    failingBaseChecks,
  };
}
