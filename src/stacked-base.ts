/**
 * The stacked-PR merge barrier — "is this PR waiting on its own base to land?"
 *
 * A PR whose base branch is the head of **another open PR** is a stacked PR. It
 * must not merge until that base PR merges, after which GitHub retargets it to the
 * default branch and it flows through the normal path. It is still reviewed and
 * fixed while it waits; only merging is held (rmartz/dotfiles#1242).
 *
 * This reads naturally as one more merge-safety fact rather than coordinator-only
 * logic: it is purely static, and "not yet — wait for your base" is exactly the
 * question this check answers. But the coordinator's version hard-codes its own
 * label vocabulary, and the check-run name is a **fleet contract**, so the policy
 * half is kept out of the fact: the *fact* is "an open, non-exempt PR heads my
 * base branch", and which labels mark a base exempt is a caller-supplied input
 * (see the reusable workflow's `stacked-base-exempt-labels`).
 */

/**
 * Labels that mark a base branch as a long-lived **accumulator** its children may
 * merge into: a `release` train, or the top of an `epic` stack that the coordinator
 * lands atomically (rmartz/dotfiles#1495). GitHub has no branch-level labels, so
 * the marker is read off the branch's tracking PR. The default matches the
 * coordinator's vocabulary; a consumer that does not run the coordinator can
 * override it.
 */
export const DEFAULT_EXEMPT_BASE_LABELS = ['release', 'epic'] as const;

/** The open PR that heads a branch, reduced to what the barrier needs. */
export interface BasePr {
  number: number;
  /** The PR's label names, matched case-insensitively against the exempt set. */
  labels: readonly string[];
}

/** True when a base PR is a long-lived accumulator its children may merge into. */
export function isExemptBasePr(basePr: BasePr, exemptLabels: readonly string[]): boolean {
  const exempt = new Set(exemptLabels.map((l) => l.trim().toLowerCase()));
  return basePr.labels.some((l) => exempt.has(l.trim().toLowerCase()));
}

export interface StackedParentInput {
  /** This PR's base branch, as a plain name (`main`, `issue-53-foo`). */
  baseBranch: string;
  /**
   * The repository default branch, or `null` when it could not be resolved. A
   * `null` **disables the barrier entirely**: better to let the other gates decide
   * than to strand every open PR behind an unresolved default branch — the same
   * never-wedge posture the base-health probes take.
   */
  defaultBranch: string | null;
  /**
   * The open PR whose head is `baseBranch`, or `null`. `null` also covers a failed
   * probe, which deliberately reads as "not stacked": an unreadable lookup must not
   * hold a PR that may not be stacked at all.
   */
  basePr: BasePr | null;
  exemptLabels: readonly string[];
}

/**
 * The number of the open PR this one is stacked behind and must wait for, or `null`
 * when it is free to merge on this axis.
 *
 * `null` when the barrier is disabled (no resolvable default branch), when the base
 * *is* the default branch (the ordinary case), when **no open PR heads the base**
 * (a long-lived integration branch with no tracking PR — barring it would strand
 * the PR forever, since nothing will ever "land" to release it), or when the base
 * PR is an exempt accumulator.
 */
export function stackedParentPr({
  baseBranch,
  defaultBranch,
  basePr,
  exemptLabels,
}: StackedParentInput): number | null {
  if (!defaultBranch) return null;
  if (!baseBranch || baseBranch === defaultBranch) return null;
  if (!basePr) return null;
  if (isExemptBasePr(basePr, exemptLabels)) return null;
  return basePr.number;
}

/** The check-run reason for a held stacked PR, naming the base and the PR to wait for. */
export function stackedBaseReason(baseBranch: string, parentPr: number): string {
  return (
    `This PR targets \`${baseBranch}\`, the head of open PR #${parentPr} — it is stacked and ` +
    `must not merge until that PR does. Once #${parentPr} merges, GitHub retargets this PR to ` +
    'the default branch and it merges normally. Review and fixes proceed meanwhile; only the ' +
    'merge is held.'
  );
}
