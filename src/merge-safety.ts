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
 *   1. a **breaking** commit landed on the base since the PR's merge-base, OR
 *   2. a **`ci`-typed** commit landed on the base since merge-base (the
 *      coordinator rebases in-flight PRs past CI changes — see the `ci` prefix
 *      rebase rule), OR
 *   3. the PR is **itself** a breaking change, OR
 *   4. the PR is **itself** a `ci`-typed change **and is not a hotfix** — a CI
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
 * **The breaking verdict is self-derived** (#53). `prIsBreaking` was once read
 * only from the PR title's `!` marker or a `breaking change` label an LLM turn
 * applies — a required, merge-gating check with a read-dependency on a
 * non-deterministic producer, failing *permissively* when that turn never ran.
 * It is now also derived from the PR's own diff (`breaking-diff.ts`); the title
 * and label remain accepted inputs, so this is additive and never less strict.
 *
 * A fourth axis falls out of that: a **CI-sensitive package bump** (a linter or
 * formatter whose output gates CI) must force every in-flight sibling to re-test
 * under it once merged, and only the merged subject can carry that signal — a
 * `ci` prefix, or a `!` that `merge-pr.py` stamps on functional types alone
 * (rmartz/dotfiles#1559). On a non-`ci` title there is no route, so the verdict
 * holds the PR and asks for the retitle rather than proposing a label that would
 * be stripped at merge.
 */

import { firstLine } from './conventional-commits.js';
import {
  hasSignal,
  signalDetail,
  type BreakingDiffKind,
  type BreakingDiffSignal,
} from './breaking-diff.js';

/** Human phrasing for each diff-derived breaking signal, used in the check-run reason. */
const BREAKING_DIFF_REASONS: Record<BreakingDiffKind, string> = {
  'major-version-bump': 'dependency major bump',
  'sensitive-package-bump': 'CI-sensitive package version change',
  'material-test-changes': 'existing test file modified',
};

/** Labels the check drives on a PR. Structural (`as const`) per repo convention. */
export const MERGE_SAFETY_LABELS = ['update required', 'merge conflict'] as const;
export type MergeSafetyLabel = (typeof MERGE_SAFETY_LABELS)[number];

/** Nested markdown bullets, indented two spaces so they sit under a reason's `- `. */
function nestedBullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

/** `<short-sha> <subject>` — the one-line form a base commit takes in a reason. */
function formatBaseCommit(commit: BaseCommit): string {
  return `${commit.sha.slice(0, 7)} ${commit.subject}`;
}

/** A reason sentence, with its detail list (if any) appended as nested bullets. */
function withDetail(sentence: string, detail: readonly string[]): string {
  return detail.length ? `${sentence}\n${nestedBullets(detail)}` : sentence;
}

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

/**
 * The `breaking change` label. Historically an *input* only — a human or an LLM
 * turn applies it and the check trusts it. Since #53 it is also an *output*: the
 * check adds it itself when the PR's own diff proves a breaking dependency major
 * bump. Add-only, never reconciled away (see {@link MergeSafetyDecision.labels}),
 * so an explicit human judgment is never silently reverted.
 */
export const BREAKING_LABEL = 'breaking change';

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
  mayCarryBreakingMarker,
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
  /** The PR is itself a `ci`-typed change (title `ci:` / `ci(scope):`). */
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
  /** The `ci`-typed base commits since merge-base. */
  baseCiCommits: readonly BaseCommit[];
  /** The PR's changed files that also changed on the base since merge-base. */
  overlappingFiles: readonly string[];
  /** The names of the failing base CI checks, surfaced in the base-health reason. */
  failingBaseChecks: readonly string[];
  /**
   * The breaking signals the PR's **own diff** carries (#53) — a dependency major
   * bump, a CI-sensitive linter/formatter version change, or material changes to
   * existing tests. These feed `prIsBreaking` alongside the title marker and the
   * label, so the verdict no longer depends on an LLM turn having run.
   */
  prBreakingDiffSignals: readonly BreakingDiffSignal[];
  /**
   * The PR title's conventional type is functional (`feat`/`fix`/`perf`/`revert`),
   * so a `breaking change` label on it would survive `merge-pr.py`'s #1559 check
   * and become a `!` on the squashed subject. False for `chore`/`ci`/`docs`/… —
   * where a label would be stripped at merge and the signal silently lost.
   */
  prMayCarryBreakingMarker: boolean;
}

export type MergeSafetyConclusion = 'success' | 'failure';

export interface MergeSafetyDecision {
  /** The check-run conclusion: `success` iff safe to merge as-is. */
  conclusion: MergeSafetyConclusion;
  /** The PR must be brought current before merge (the staleness axis). */
  needsUpdate: boolean;
  /** The PR has a hard git conflict (the mergeability axis). */
  hasConflict: boolean;
  /** Blocked because the base's CI is failing and this PR is not a hotfix (the base-health axis). */
  baseUnhealthy: boolean;
  /**
   * The PR bumps a CI-sensitive linter/formatter but is not `ci`-typed, so nothing
   * will force in-flight siblings to re-test under it after merge (the retitle axis,
   * #53). See the reason text for why a `breaking change` label cannot substitute.
   */
  needsCiRetitle: boolean;
  /**
   * Short state phrase for the check-run title — the verdict at a glance. One of
   * `No update required` / `Update required` / `Merge conflict` / `Base CI
   * failing` / `Retitle as a CI change` / `Could not evaluate`. The check-run
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
   *
   * `addOnly` is **never removed**. It carries `breaking change`, which is also a
   * human/agent input: the check adds it when the diff proves a breaking change,
   * but never takes one away, so an explicit human judgment is never silently
   * reverted (#53). A caller reconciling labels must not derive removals from it.
   */
  labels: { add: MergeSafetyLabel[]; remove: MergeSafetyLabel[]; addOnly: string[] };
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

  const stale = !facts.isCurrent;
  if (stale && facts.baseBreakingSinceMergeBase) {
    reasons.push(
      withDetail(
        'A breaking change landed on the base since merge-base — rebase and re-run CI:',
        facts.baseBreakingCommits.map(formatBaseCommit),
      ),
    );
  }
  if (stale && facts.prIsBreaking) {
    reasons.push(
      withDetail(
        'This PR is a breaking change — it must be current with the base before merge.',
        facts.prBreakingDiffSignals.flatMap((s) =>
          s.detail.map((d) => `${BREAKING_DIFF_REASONS[s.kind]}: ${d}`),
        ),
      ),
    );
  }
  if (stale && facts.prIsCi && !facts.prIsHotfix) {
    reasons.push(
      'This PR is a CI change — it must be current with the base before merge, so it is ' +
        're-tested against the latest base and cannot green a guard against a pattern that ' +
        'has since regressed.',
    );
  }
  if (stale && facts.baseCiSinceMergeBase) {
    reasons.push(
      withDetail(
        'A CI change landed on the base since merge-base — rebase to re-test under it:',
        facts.baseCiCommits.map(formatBaseCommit),
      ),
    );
  }
  if (stale && facts.fileOverlap) {
    reasons.push(
      withDetail(
        'This PR changes files the base also changed since merge-base — sync with base and ' +
          're-run CI before merging to ensure the changes are compatible:',
        facts.overlappingFiles,
      ),
    );
  }

  // The retitle axis (#53). A CI-sensitive linter/formatter bump must force every
  // in-flight sibling to re-test under the new tool version after this merges, and
  // that signal can only travel on the merged subject: either a `ci` prefix or a
  // `!` marker. The `!` route is unavailable here — `merge-pr.py` stamps `!` only
  // on a functional type and *strips* a `breaking change` label off anything else
  // (#1559), and the fleet's answer for exactly this case is the `ci` type, not the
  // label. So a non-`ci` title is a dead end no label can rescue: fail, and say so.
  // Unlike the staleness clauses this is not gated on `!isCurrent` — merging a
  // current PR under the wrong title loses the signal just as permanently.
  const needsCiRetitle = hasSignal(facts.prBreakingDiffSignals, 'sensitive-package-bump')
    ? !facts.prIsCi
    : false;

  const needsUpdate =
    stale &&
    (facts.baseBreakingSinceMergeBase ||
      facts.baseCiSinceMergeBase ||
      facts.prIsBreaking ||
      (facts.prIsCi && !facts.prIsHotfix) ||
      facts.fileOverlap);

  // Listed last so a PR that is also stale or conflicting leads with the reason its
  // title names — the summary takes reasons[0], and the two must agree.
  if (needsCiRetitle) {
    reasons.push(
      withDetail(
        'This PR changes a CI-sensitive package version, which can redden the format/lint ' +
          'gate on PRs that never touched the bumped file. Retitle it with the `ci` type ' +
          '(e.g. `ci(deps): …`) so merged siblings are forced to re-test under it — a ' +
          '`breaking change` label cannot carry this signal on a non-functional type:',
        signalDetail(facts.prBreakingDiffSignals, 'sensitive-package-bump'),
      ),
    );
  }

  const conclusion: MergeSafetyConclusion =
    needsUpdate || facts.hasConflict || baseUnhealthy || needsCiRetitle ? 'failure' : 'success';

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
        : needsCiRetitle
          ? 'Retitle as a CI change'
          : 'No update required';

  const add: MergeSafetyLabel[] = [];
  if (needsUpdate) add.push('update required');
  if (facts.hasConflict) add.push('merge conflict');
  const remove = MERGE_SAFETY_LABELS.filter((l) => !add.includes(l));

  // `breaking change` is proposed only for a dependency **major** bump on a
  // functional-typed PR — the one diff signal that is breaking in the sense `!`
  // means, on the one title shape where the label survives to become a `!`
  // (#1559). Deliberately NOT proposed for the other two signals: a CI-sensitive
  // bump is answered by the `ci` retitle above, and a material test change is a
  // staleness signal, not a public-API break — labelling either would stamp `!`
  // on a functional-typed PR and fire a spurious semantic-release MAJOR.
  const addOnly: string[] = [];
  if (
    hasSignal(facts.prBreakingDiffSignals, 'major-version-bump') &&
    facts.prMayCarryBreakingMarker
  )
    addOnly.push(BREAKING_LABEL);

  return {
    conclusion,
    needsUpdate,
    hasConflict: facts.hasConflict,
    baseUnhealthy,
    needsCiRetitle,
    title,
    reasons,
    summary,
    labels: { add, remove, addOnly },
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
    needsCiRetitle: false,
    title: 'Could not evaluate',
    reasons: [message],
    summary: `Could not evaluate merge safety: ${message}`,
    labels: { add: [], remove: [], addOnly: [] },
  };
}
