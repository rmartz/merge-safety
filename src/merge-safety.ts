/**
 * Merge-safety predicate — "is this PR safe to merge *as it stands*, or must it
 * first be brought current against its base branch and re-run through CI?"
 *
 * This is the coordinator's `_pr_needs_branch_update` decision, lifted into a
 * pure, side-effect-free function so it can be shared by two callers: PR Shepherd
 * (which merges) and the `merge-safety` GitHub check (which *surfaces* the
 * verdict as a required status so it's visible on the PR and can gate auto-merge).
 * It knows nothing about posting, check-runs, or PR Shepherd's gate labels — it
 * maps gathered *facts* to a verdict, and the caller owns the emission channel.
 *
 * The rule (a PR **must be brought current** when it is not already current AND):
 *   1. a **breaking** commit landed on the base since the PR's merge-base **and the
 *      PR is not a (non-breaking) `docs` PR**, OR
 *   2. a **CI** commit landed on the base since merge-base — `ci`-typed, or one
 *      that changed `.github/workflows/**` / `.github/actions/**` (#67) — (the
 *      coordinator rebases in-flight PRs past CI changes, by prefix or path), OR
 *   3. the PR is **itself** a breaking change **and the base has moved by more than
 *      `docs` commits alone**, OR
 *   4. the PR is **itself** a CI change (`ci`-typed, or its diff touches those
 *      paths) **and is not a hotfix** — a CI
 *      guard is only as good as the base it last ran against, so a CI PR that was
 *      clean when it was opened must be re-tested against the current base to
 *      catch a pattern the guard protects against that has regressed on the base
 *      since (the symmetric partner to clause 2's base-side detection). The
 *      `hotfix` label exempts *this* clause — a CI fix for a base whose own CI is
 *      red can be caught in a bind (base health blocks it unless it is a hotfix,
 *      and being forced current may itself be impossible or pointless while the
 *      base is broken), so `hotfix` frees it here just as it frees the base-health
 *      axis. The exemption is deliberately *this-PR-is-itself-CI*-only: it does
 *      not touch clause 3 (`prIsBreaking`) or the base-side clauses (1, 2, 5),
 *      which guard against real incompatibilities a hotfix must still rebase past,
 *      OR
 *   5. the PR's changed files **intersect** the files changed on the base since
 *      merge-base.
 *
 * The `docs` carve-outs on clauses 1 and 3 (a breaking and a docs change interact
 * only through a shared file; CI changes get no such carve-out) are explained in
 * `staleness.ts`, which evaluates clauses 1–5.
 *
 * Clause 5 is a *narrowing* guard, not a widening one: it only ever forces more
 * PRs current. Git can merge two disjoint-looking diffs cleanly and still produce
 * invalid code (an earlier PR deletes a symbol this PR still references), so any
 * file-level overlap forces a rebase + re-CI to catch the semantic conflict a
 * clean textual merge hides.
 *
 * A hard git **conflict** is a separate axis from staleness — GitHub blocks such
 * a merge regardless — but the verdict folds it in so a single check answers "is
 * it safe to merge right now?", with a distinct label for visibility.
 *
 * **Base health** is a third, PR-independent axis: when the base branch's own CI
 * is failing, merging anything but a fix onto it only compounds a broken base, so
 * a PR is held **unless it is a hotfix** (the `hotfix` label is the escape hatch
 * that lets the fix for broken main through). "Failing CI" is read expansively —
 * any failing GitHub Actions run on the base counts — but a failing *deploy* does
 * not: a red deploy under green Actions is likelier an external/environmental
 * fault no code change can fix, so it must not wedge the whole merge queue.
 *
 * **The breaking verdict reads the title and the diff, never a label** (#82).
 * `prIsBreaking` is the PR title's `!` marker or a breaking signal in the PR's own
 * diff (`breaking-diff.ts`, #53). Whether a PR *should* carry `!` — the
 * `breaking change` label, a dependency major bump, a linter bump's `ci` type — is
 * title policy, enforced by pr-policy's title check; this check only consumes the
 * resulting title and never reads or writes a label for it.
 */

import { firstLine } from './conventional-commits.js';

export type { BaseCommit } from './reasons.js';
import { evaluateStaleness } from './staleness.js';
import { withDetail, type BaseCommit } from './reasons.js';
import type { BreakingDiffSignal } from './breaking-diff.js';

/** Labels the check drives on a PR. Structural (`as const`) per repo convention. */
export const MERGE_SAFETY_LABELS = ['update required', 'merge conflict'] as const;
export type MergeSafetyLabel = (typeof MERGE_SAFETY_LABELS)[number];

/**
 * True when a PR's state (`gh pr view --json state`: `OPEN` / `CLOSED` /
 * `MERGED`) warrants a merge-safety verdict. Only an OPEN PR can still merge, so
 * only an OPEN PR gets its check-run and labels reconciled; a closed or merged PR
 * is a deliberate skip — not the `errorMergeSafetyDecision` fail-safe, which is
 * for an OPEN PR whose facts could not be gathered. Guards against a post-merge
 * label event (e.g. a verdict label applied moments after merge) re-stamping a
 * settled PR.
 */
export function isEvaluablePrState(state: string): boolean {
  return state === 'OPEN';
}

/** The label a PR carries to declare itself a broken-main fix, exempt from base health. */
export const HOTFIX_LABEL = 'hotfix';

// Base health is a separate concern — and its own module since #53 pushed this
// file past the 480-line `max-lines` cap. Re-exported so `merge-safety.js` stays
// the single import surface for everything the verdict consumes.
export {
  failingFallbackBaseChecks,
  failingRequiredBaseChecks,
  isFailingCiConclusion,
  isGitHubActionsCheck,
  isNonBuildPlatformCheck,
  type BaseCheckRun,
} from './base-health.js';

// The subject predicates moved out alongside base health (#53, `max-lines`).
// Re-exported so `merge-safety.js` stays the single import surface.
export {
  isBreakingCommitMessage,
  isBreakingTitle,
  isCiCommitMessage,
  isCiTitle,
  isDocsCommitMessage,
  isDocsTitle,
} from './conventional-commits.js';

/** The PR's changed files that also changed on the base, preserving PR order. */
export function overlappingFiles(
  prFiles: readonly string[],
  baseFiles: readonly string[],
): string[] {
  if (!prFiles.length || !baseFiles.length) return [];
  const base = new Set(baseFiles);
  return prFiles.filter((f) => base.has(f));
}

/** True when the PR's changed files intersect the base's changed files. */
export function hasFileOverlap(prFiles: readonly string[], baseFiles: readonly string[]): boolean {
  return overlappingFiles(prFiles, baseFiles).length > 0;
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
  /** A CI commit (`ci`-typed, or touching a CI path) landed on the base since merge-base. */
  baseCiSinceMergeBase: boolean;
  /** The PR is itself a breaking change: its title's `!` marker or a diff-derived signal. */
  prIsBreaking: boolean;
  /**
   * The PR title is a `docs:` / `docs(scope):` conventional commit. A non-breaking
   * docs PR is exempt from the base-breaking clause (a breaking base change only
   * forces it current through a shared file, via `fileOverlap`).
   */
  prIsDocs: boolean;
  /**
   * The base moved since merge-base, and **every** commit it moved by is
   * `docs`-typed. Exempts the `prIsBreaking` clause: a breaking PR behind only docs
   * commits need not be brought current unless the files overlap.
   */
  baseOnlyDocsSinceMergeBase: boolean;
  /**
   * The PR is itself a CI change: title `ci:` / `ci(scope):`, or its own diff
   * changes `.github/workflows/**` / `.github/actions/**` (#67).
   */
  prIsCi: boolean;
  /** The PR's changed files intersect the base's changed files since merge-base. */
  fileOverlap: boolean;
  /** Git reports the PR as conflicting (`mergeable === 'CONFLICTING'`). */
  hasConflict: boolean;
  /** The base branch tip has at least one failing GitHub Actions CI check. */
  baseCiFailing: boolean;
  /**
   * The PR carries the `hotfix` label, exempting it from the base-CI-failing axis
   * *and* from the `prIsCi` update-required clause (a hotfix CI fix for a red base
   * is not forced current). It does not exempt `prIsBreaking` or the base-side
   * clauses.
   */
  prIsHotfix: boolean;
  /** The base commits since merge-base whose message marks a breaking change. */
  baseBreakingCommits: readonly BaseCommit[];
  /** The CI base commits (`ci`-typed, or touching a CI path) since merge-base. */
  baseCiCommits: readonly BaseCommit[];
  /** The PR's changed files that also changed on the base since merge-base. */
  overlappingFiles: readonly string[];
  /** The names of the failing base CI checks, surfaced in the base-health reason. */
  failingBaseChecks: readonly string[];
  /**
   * The breaking signals the PR's **own diff** carries (#53) — a dependency major
   * bump, a CI-sensitive linter/formatter version change, or material changes to
   * existing tests. These feed `prIsBreaking` alongside the title marker, so a PR
   * that changes something risky is re-tested against a moved base even when its
   * title is unmarked.
   */
  prBreakingDiffSignals: readonly BreakingDiffSignal[];
}

/**
 * `pending` is posted as an incomplete (`in_progress`) check-run: it blocks the
 * merge like `failure` but renders as a yellow dot, not a red ✗ (#58).
 */
export type MergeSafetyConclusion = 'success' | 'failure' | 'pending';

export interface MergeSafetyDecision {
  /**
   * The check-run conclusion: `success` iff safe to merge as-is; `pending` when the
   * only problem is staleness, which a branch update clears; otherwise `failure`.
   */
  conclusion: MergeSafetyConclusion;
  /** The PR must be brought current before merge (the staleness axis). */
  needsUpdate: boolean;
  /** The PR has a hard git conflict (the mergeability axis). */
  hasConflict: boolean;
  /** Blocked because the base's CI is failing and this PR is not a hotfix (the base-health axis). */
  baseUnhealthy: boolean;
  /**
   * Short state phrase for the check-run title — the verdict at a glance. One of
   * `No update required` / `Update required` / `Merge conflict` / `Base CI
   * failing` / `Could not evaluate`. The check-run
   * *name* stays the stable `merge-safety` (so branch
   * protection can match it); this varies with the outcome instead.
   */
  title: string;
  /** Ordered most→least severe, human-readable — the check-run output detail. */
  reasons: string[];
  /** One-line check-run summary. */
  summary: string;
  /**
   * Labels the check drives.
   *
   * `add` / `remove` are **reconciled**: the check owns `update required` and
   * `merge conflict` outright, adding the ones that apply and removing the rest.
   */
  labels: { add: MergeSafetyLabel[]; remove: MergeSafetyLabel[] };
}

/**
 * Map gathered {@link MergeSafetyFacts} to a {@link MergeSafetyDecision}. Pure:
 * the same facts always yield the same verdict. A PR that is already current is
 * always safe on the staleness axis — a stale trigger can only matter when the
 * PR is behind — so the update clauses are gated on `!isCurrent`.
 */
export function evaluateMergeSafety(facts: MergeSafetyFacts): MergeSafetyDecision {
  const reasons: string[] = [];

  if (facts.hasConflict) {
    reasons.push('Git reports a merge conflict against the base — resolve it before merging.');
  }

  // Base health is PR-independent: a red base blocks everything but a hotfix. It
  // sits right after conflict (the other PR-independent block) and above the
  // staleness reasons so its headline drives the summary when it is the top issue.
  const baseUnhealthy = facts.baseCiFailing && !facts.prIsHotfix;
  if (baseUnhealthy) {
    reasons.push(
      withDetail(
        "The base branch's CI is failing — only hotfix PRs may merge until it is green " +
          '(label this PR `hotfix` to override):',
        facts.failingBaseChecks,
      ),
    );
  }

  // The staleness axis (clauses 1–5): what forces a behind PR to be brought current.
  const { needsUpdate, reasons: stalenessReasons } = evaluateStaleness(facts);
  reasons.push(...stalenessReasons);

  // Split the blocking verdict by what clears it (#58). Staleness alone is routine
  // and a branch update fixes it, so it holds the PR as `pending` without reading as
  // broken; everything else needs a person (or the base CI) to act, so it
  // stays `failure`, including staleness combined with any of those.
  const needsAction = facts.hasConflict || baseUnhealthy;
  const conclusion: MergeSafetyConclusion = needsAction
    ? 'failure'
    : needsUpdate
      ? 'pending'
      : 'success';

  // A reason may now carry nested detail bullets; the one-line summary takes only
  // its headline sentence, leaving the specifics to the full reasons list.
  const summary =
    conclusion === 'success'
      ? 'No update required: current, or no breaking/overlapping changes on the base, no conflict, and the base CI is green.'
      : firstLine(reasons[0] ?? 'Not safe to merge as-is.');

  // Conflict is the more blocking, concrete problem, so it wins the title when a
  // PR is both conflicting and stale; base health (also PR-independent) comes next,
  // then staleness. The summary still lists every reason.
  const title = facts.hasConflict
    ? 'Merge conflict'
    : baseUnhealthy
      ? 'Base CI failing'
      : needsUpdate
        ? 'Update required'
        : 'No update required';

  const add: MergeSafetyLabel[] = [];
  if (needsUpdate) add.push('update required');
  if (facts.hasConflict) add.push('merge conflict');
  const remove = MERGE_SAFETY_LABELS.filter((l) => !add.includes(l));

  return {
    conclusion,
    needsUpdate,
    hasConflict: facts.hasConflict,
    baseUnhealthy,
    title,
    reasons,
    summary,
    labels: { add, remove },
  };
}

/**
 * The verdict for a PR whose facts could not be gathered (bad merge-base, a git
 * command that failed, an unreadable PR). Fail-safe: `failure`, so a consumer
 * that trusts the verdict treats an ungatherable PR as unsafe rather than green.
 * `needsUpdate` / `hasConflict` stay `false` because they are genuinely unknown —
 * the `failure` conclusion is what carries the safety, not a fabricated axis. No
 * labels are proposed: an ungatherable state is not evidence for adding or
 * removing either label.
 */
export function errorMergeSafetyDecision(message: string): MergeSafetyDecision {
  return {
    conclusion: 'failure',
    needsUpdate: false,
    hasConflict: false,
    baseUnhealthy: false,
    title: 'Could not evaluate',
    reasons: [message],
    summary: `Could not evaluate merge safety: ${message}`,
    labels: { add: [], remove: [] },
  };
}
