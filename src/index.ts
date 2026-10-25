/**
 * @rmartz/merge-safety — public entry point.
 *
 * Encodes the package's stable public contract: the `merge-safety` check-run
 * name and the CLI command surface. The evaluate/invalidate implementation
 * (`merge-safety.ts` + `merge-safety-facts.ts` and the `merge-safety` bin)
 * lives alongside it. The check-run name and command surface below are frozen;
 * the re-exported library surface lets a consumer run the verdict in-process.
 */

/**
 * The name of the check-run merge-safety posts for each PR.
 *
 * This is a **fleet contract**, not an internal label: every consumer repo
 * configures a *required status check* of exactly this name, and the auto-merge
 * gate (`goldenGateChecks`) keys off it. Renaming it is a coordinated fleet
 * migration (every consumer's required-check config + the auto-merge verifier +
 * the gate floor, all at once), never a local edit. See
 * docs/check-run-contract.md.
 */
export const MERGE_SAFETY_CHECK_NAME = 'merge-safety';

/**
 * The library surface for running merge-safety in-process (e.g. from a hosted
 * GitHub App) instead of through the CLI: gather the facts with a fact source,
 * then judge them. Two fact sources plug into `gatherMergeSafetyFacts`'s `git`
 * option — the git-backed {@link makeGitRunner} (the CLI's default, needs a
 * checkout) and the API-backed {@link makeApiGitRunner} (needs only a GitHub API
 * client). See docs/fact-sources.md.
 */
export {
  gatherMergeSafetyFacts,
  makeGitRunner,
  type BaseChecksProbe,
  type GatherOptions,
  type GitRunner,
  type PrMergeMeta,
  type RequiredChecksProbe,
} from './merge-safety-facts.js';
export {
  makeApiGitRunner,
  COMPARE_MAX_COMMITS,
  COMPARE_MAX_FILES,
  COMMIT_MAX_FILES,
  type ApiGitRunnerOptions,
  type GitHubApiGet,
} from './api-fact-source.js';
export {
  evaluateMergeSafety,
  errorMergeSafetyDecision,
  failingBaseChecks,
  type BaseCheckRun,
  type MergeSafetyDecision,
  type MergeSafetyFacts,
} from './merge-safety.js';

/**
 * The two operations the `merge-safety` CLI dispatches:
 * - `evaluate` — gather base-currency + breaking-change + conflict facts for one
 *   PR, post the `merge-safety` check-run, and reconcile the update-required /
 *   merge-conflict labels.
 * - `invalidate` — on a push to the base branch, flip every *other* open PR's
 *   check to pending and re-dispatch its `evaluate`, so a moved base holds native
 *   auto-merge until each PR re-clears.
 */
export const MERGE_SAFETY_COMMANDS = ['evaluate', 'invalidate'] as const;

export type MergeSafetyCommand = (typeof MERGE_SAFETY_COMMANDS)[number];

/** Type guard for the CLI command surface. */
export function isMergeSafetyCommand(value: string | undefined): value is MergeSafetyCommand {
  return value !== undefined && (MERGE_SAFETY_COMMANDS as readonly string[]).includes(value);
}
