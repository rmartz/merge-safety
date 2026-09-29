/**
 * The staleness axis of the merge-safety verdict — which of clauses 1–5 (see
 * `merge-safety.ts`) force a PR that is behind its base to be brought current, and
 * the reason line each one contributes.
 *
 * Split from `merge-safety.ts` when the `docs` carve-outs pushed that file past its
 * 480-line `max-lines` cap. Pure, like the verdict it feeds.
 *
 * **The `docs` carve-outs** on clauses 1 and 3 are symmetric: a breaking change and
 * a docs change do not interact by *existence* alone, only through a shared file —
 * which the file-overlap clause still catches, in either direction. So a `feat!` PR
 * behind only `docs` commits, and a `docs` PR behind a `feat!` commit, are both safe
 * when their files are disjoint. The carve-outs deliberately do **not** extend to
 * the CI clauses (2 and 4): a CI change can add a rule that enforces over docs files
 * (a link checker, a frontmatter lint), so a `ci` change still forces a `docs` PR
 * current in both directions. A `docs` base commit that touches a CI path is still
 * a CI commit, and a `docs` PR whose own diff is breaking (e.g. it rewrites a test)
 * keeps no clause-1 carve-out.
 */
import type { MergeSafetyFacts } from './merge-safety.js';
import { breakingSignalDetail, formatBaseCommit, withDetail } from './reasons.js';

export interface StalenessVerdict {
  /** The PR must be brought current before merge. */
  needsUpdate: boolean;
  /** One reason per clause that fired, in severity order. */
  reasons: string[];
}

/**
 * Evaluate clauses 1–5 against `facts`. A PR that is already current never needs
 * an update — a stale trigger can only matter when the PR is behind — so every
 * clause is gated on `!isCurrent`.
 */
export function evaluateStaleness(facts: MergeSafetyFacts): StalenessVerdict {
  const reasons: string[] = [];
  if (facts.isCurrent) return { needsUpdate: false, reasons };

  const baseBreaking = facts.baseBreakingSinceMergeBase && !(facts.prIsDocs && !facts.prIsBreaking);
  const prBreaking = facts.prIsBreaking && !facts.baseOnlyDocsSinceMergeBase;
  const prCi = facts.prIsCi && !facts.prIsHotfix;

  if (baseBreaking) {
    reasons.push(
      withDetail(
        'A breaking change landed on the base since merge-base — rebase and re-run CI:',
        facts.baseBreakingCommits.map(formatBaseCommit),
      ),
    );
  }
  if (prBreaking) {
    reasons.push(
      withDetail(
        'This PR is a breaking change — it must be current with the base before merge.',
        breakingSignalDetail(facts.prBreakingDiffSignals),
      ),
    );
  }
  if (prCi) {
    reasons.push(
      'This PR is a CI change — it must be current with the base before merge, so it is ' +
        're-tested against the latest base and cannot green a guard against a pattern that ' +
        'has since regressed.',
    );
  }
  if (facts.baseCiSinceMergeBase) {
    reasons.push(
      withDetail(
        'A CI change landed on the base since merge-base — rebase to re-test under it:',
        facts.baseCiCommits.map(formatBaseCommit),
      ),
    );
  }
  if (facts.fileOverlap) {
    reasons.push(
      withDetail(
        'This PR changes files the base also changed since merge-base — sync with base and ' +
          're-run CI before merging to ensure the changes are compatible:',
        facts.overlappingFiles,
      ),
    );
  }

  const needsUpdate =
    baseBreaking || facts.baseCiSinceMergeBase || prBreaking || prCi || facts.fileOverlap;
  return { needsUpdate, reasons };
}
