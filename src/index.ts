/**
 * @rmartz/merge-safety — public entry point.
 *
 * SCAFFOLD: this package is being extracted from `@rmartz/pr-review` per
 * ai-tools#247. The evaluate/invalidate implementation (`merge-safety.ts` +
 * `merge-safety-facts.ts`, with their tests and the `ai-merge-safety` bin)
 * migrates in a follow-up; see docs/migration.md. Until then this module only
 * encodes the package's stable public contract so the reusable workflow and the
 * consumer wiring can be exercised end to end.
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
 * The two operations the `ai-merge-safety` CLI dispatches:
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
