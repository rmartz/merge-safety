/**
 * Merge-safety shared foundation — the fact model and the pure commit/file
 * predicates that fact-gathering ({@link ./merge-safety-facts.ts}) derives its
 * booleans from.
 *
 * This is the first slice of the `merge-safety.ts` extraction (ai-tools#247,
 * docs/migration.md): the side-effect-free predicates and the {@link MergeSafetyFacts}
 * / {@link BaseCommit} types are shared foundation, independent of any verdict or
 * emission logic. The verdict itself — `evaluateMergeSafety` / `errorMergeSafetyDecision`,
 * the decision types, the labels, and the report-formatting helpers — is appended
 * to this same module in the follow-up (#4), so this file grows there rather than
 * being renamed.
 */

/** Conventional-commit breaking marker in a subject: `type` / `type(scope)` + `!:`. */
const BREAKING_SUBJECT_RE = /^[a-z]+(\([^)]*\))?!:/;
/** A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer anywhere in the message. */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
/** A `ci`-typed conventional commit (with or without a scope / `!`). */
const CI_SUBJECT_RE = /^ci(\([^)]*\))?!?:/;

function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

/** True when a commit message marks a breaking change (subject `!` or footer). */
export function isBreakingCommitMessage(message: string): boolean {
  return BREAKING_SUBJECT_RE.test(firstLine(message)) || BREAKING_FOOTER_RE.test(message);
}

/** True when a commit message is a `ci`-typed conventional commit. */
export function isCiCommitMessage(message: string): boolean {
  return CI_SUBJECT_RE.test(firstLine(message));
}

/** True when a PR title carries the conventional-commit breaking `!` marker. */
export function isBreakingTitle(title: string): boolean {
  return BREAKING_SUBJECT_RE.test(title.trim());
}

/** The PR's changed files that also changed on the base, preserving PR order. */
export function overlappingFiles(
  prFiles: readonly string[],
  baseFiles: readonly string[],
): string[] {
  if (!prFiles.length || !baseFiles.length) return [];
  const base = new Set(baseFiles);
  return prFiles.filter((f) => base.has(f));
}

/** A base commit surfaced in a reason so the report names *which* commit triggered it. */
export interface BaseCommit {
  /** The full commit SHA (rendered abbreviated in the report). */
  sha: string;
  /** The commit subject (first line of its message). */
  subject: string;
}

/**
 * The gathered facts a merge-safety verdict is computed from. The `*SinceMergeBase`
 * / `fileOverlap` booleans drive the verdict; the parallel `baseBreakingCommits` /
 * `baseCiCommits` / `overlappingFiles` detail lists name *which* base commits and
 * files triggered each, so the report can surface the specifics. Each boolean is
 * exactly `list.length > 0` — the gatherer derives it from the list.
 */
export interface MergeSafetyFacts {
  /** The PR's merge-base is the current base-branch tip — nothing is stale. */
  isCurrent: boolean;
  /** A breaking commit landed on the base since the PR's merge-base. */
  baseBreakingSinceMergeBase: boolean;
  /** A `ci`-typed commit landed on the base since the PR's merge-base. */
  baseCiSinceMergeBase: boolean;
  /** The PR is itself a breaking change (title `!` marker or `breaking change` label). */
  prIsBreaking: boolean;
  /** The PR's changed files intersect the base's changed files since merge-base. */
  fileOverlap: boolean;
  /** Git reports the PR as conflicting (`mergeable === 'CONFLICTING'`). */
  hasConflict: boolean;
  /** The base commits since merge-base whose message marks a breaking change. */
  baseBreakingCommits: readonly BaseCommit[];
  /** The `ci`-typed base commits since merge-base. */
  baseCiCommits: readonly BaseCommit[];
  /** The PR's changed files that also changed on the base since merge-base. */
  overlappingFiles: readonly string[];
}
