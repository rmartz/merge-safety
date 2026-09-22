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
 */

/** Labels the check drives on a PR. Structural (`as const`) per repo convention. */
export const MERGE_SAFETY_LABELS = ['update required', 'merge conflict'] as const;
export type MergeSafetyLabel = (typeof MERGE_SAFETY_LABELS)[number];

/** Conventional-commit breaking marker in a subject: `type` / `type(scope)` + `!:`. */
const BREAKING_SUBJECT_RE = /^[a-z]+(\([^)]*\))?!:/;
/** A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer anywhere in the message. */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
/** A `ci`-typed conventional commit (with or without a scope / `!`). */
const CI_SUBJECT_RE = /^ci(\([^)]*\))?!?:/;

function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

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

/** True when a PR title is a `ci`-typed conventional commit. */
export function isCiTitle(title: string): boolean {
  return CI_SUBJECT_RE.test(title.trim());
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

/**
 * Check-run conclusions that count as a *failing* CI run. Expansive — a genuine
 * red, a timeout, or a startup failure all block — but deliberately excludes
 * `cancelled` (typically a superseded / re-run duplicate, not a real failure) and
 * the non-failing `neutral` / `skipped` / `success` / `action_required` / null.
 */
const FAILING_CI_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'] as const;

/** The label a PR carries to declare itself a broken-main fix, exempt from base health. */
export const HOTFIX_LABEL = 'hotfix';

/** The GitHub App slug that produces GitHub Actions check-runs (i.e. CI). */
const GITHUB_ACTIONS_APP_SLUG = 'github-actions';

/**
 * Check-run names that are GitHub Actions runs but *not* build/merge gates, so the
 * {@link failingFallbackBaseChecks} heuristic never treats them as a broken base.
 * The native "Dependabot Updates" job (posted as a check-run named `Dependabot`) is
 * the motivating case (#40): it fails on dependency-resolution errors unrelated to
 * whether the base builds. Matched case-insensitively.
 */
const NON_BUILD_PLATFORM_CHECKS = new Set(['dependabot', 'dependabot updates']);

/**
 * A base-tip check-run reduced to what base-health classification needs: its name
 * (matched against the base branch's required status checks), its conclusion, and
 * the slug of the producing GitHub App (used by the fallback heuristic to tell a
 * GitHub Actions CI run from an external deploy integration).
 */
export interface BaseCheckRun {
  /** The check-run name (e.g. the workflow / job name), matched to a required context. */
  name: string;
  /** The check-run conclusion, or `null` while still in progress. */
  conclusion: string | null;
  /** The producing GitHub App's slug (e.g. `github-actions`, `vercel`), or `null`. */
  appSlug: string | null;
}

/** True when a base check-run was produced by GitHub Actions (CI), not a deploy app. */
export function isGitHubActionsCheck(check: BaseCheckRun): boolean {
  return check.appSlug === GITHUB_ACTIONS_APP_SLUG;
}

/** True when a check-run's name is a known non-build platform job (e.g. Dependabot). */
export function isNonBuildPlatformCheck(name: string): boolean {
  return NON_BUILD_PLATFORM_CHECKS.has(name.trim().toLowerCase());
}

/** True when a check-run's conclusion counts as a CI failure. */
export function isFailingCiConclusion(conclusion: string | null): boolean {
  return conclusion !== null && (FAILING_CI_CONCLUSIONS as readonly string[]).includes(conclusion);
}

/**
 * The names of base checks that count as **failing CI**: a check whose name is one
 * of the base branch's **required status checks** AND that concluded in a failing
 * state. Scoping to required contexts is the crux of base-health (#40): only the
 * checks the repo has *declared* define a mergeable base can wedge the queue, so an
 * arbitrary failing Actions run that isn't a merge gate — the native "Dependabot
 * Updates" job, other bots, informational checks — never blocks unrelated PRs.
 *
 * `requiredContexts` is the set the repo requires; `null` (unreadable protection /
 * no ruleset) or `[]` (no required status checks) means nothing is declared to gate,
 * so base-health reports **no** failure — the same never-wedge posture the base-checks
 * probe takes on a transient read error. Callers pass the base tip's checks already
 * deduped to the latest run per name (the Checks API `?filter=latest`).
 */
export function failingRequiredBaseChecks(
  checks: readonly BaseCheckRun[],
  requiredContexts: readonly string[] | null,
): string[] {
  if (!requiredContexts || requiredContexts.length === 0) return [];
  const required = new Set(requiredContexts);
  return checks
    .filter((c) => required.has(c.name) && isFailingCiConclusion(c.conclusion))
    .map((c) => c.name);
}

/**
 * The fallback base-health classifier, used when the base branch's required-status-check
 * set can't be read ({@link failingRequiredBaseChecks} preferred whenever it can).
 * Without a declared gate set to intersect, it approximates one: a failing **GitHub
 * Actions** run counts, except a known non-build platform job (the Dependabot job —
 * the #40 false positive this whole change targets) and any non-Actions producer (an
 * external deploy), so a red deploy under green Actions still doesn't wedge the queue.
 * Coarser than the required-check test, but it keeps a genuinely broken base caught in
 * repos with no queryable ruleset. Callers pass the base tip's checks deduped to the
 * latest run per name (the Checks API `?filter=latest`).
 */
export function failingFallbackBaseChecks(checks: readonly BaseCheckRun[]): string[] {
  return checks
    .filter(
      (c) =>
        isGitHubActionsCheck(c) &&
        isFailingCiConclusion(c.conclusion) &&
        !isNonBuildPlatformCheck(c.name),
    )
    .map((c) => c.name);
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
   * Short state phrase for the check-run title — the verdict at a glance. One of
   * `No update required` / `Update required` / `Merge conflict` / `Base CI
   * failing` / `Could not evaluate`. The check-run *name* stays the stable
   * `merge-safety` (so branch
   * protection can match it); this varies with the outcome instead.
   */
  title: string;
  /** Ordered most→least severe, human-readable — the check-run output detail. */
  reasons: string[];
  /** One-line check-run summary. */
  summary: string;
  /** Labels to reconcile: `add` the ones that now apply, `remove` the rest. */
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
    reasons.push('This PR is a breaking change — it must be current with the base before merge.');
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

  const needsUpdate =
    stale &&
    (facts.baseBreakingSinceMergeBase ||
      facts.baseCiSinceMergeBase ||
      facts.prIsBreaking ||
      (facts.prIsCi && !facts.prIsHotfix) ||
      facts.fileOverlap);

  const conclusion: MergeSafetyConclusion =
    needsUpdate || facts.hasConflict || baseUnhealthy ? 'failure' : 'success';

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
