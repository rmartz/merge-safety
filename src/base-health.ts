/**
 * Base-health classification — "is the base branch's own CI failing?", the
 * PR-independent axis of the merge-safety verdict.
 *
 * Extracted from `merge-safety.ts` when the self-derived breaking-change signal
 * (#53) pushed that file past its 480-line cap. It is a genuinely separate
 * concern: every other clause of the verdict reads *this PR* against *its base*,
 * while these functions read only the base tip's check-runs and know nothing
 * about any PR. Pure — the network boundary stays in the bin's probes.
 */

/**
 * Check-run conclusions that count as a *failing* CI run. Expansive — a genuine
 * red, a timeout, or a startup failure all block — but deliberately excludes
 * `cancelled` (typically a superseded / re-run duplicate, not a real failure) and
 * the non-failing `neutral` / `skipped` / `success` / `action_required` / null.
 */
const FAILING_CI_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'] as const;

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
