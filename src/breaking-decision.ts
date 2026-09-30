/**
 * The breaking-decision axis of the merge-safety verdict (#82) — whether a PR must
 * carry an explicit release-type decision before it can merge.
 *
 * A dependency **major** bump in the PR's own diff is a fact static code reads
 * reliably; whether it breaks *this* package's consumers is a judgment it cannot
 * make (a wrapper such as an Action often absorbs its wrapped CLI's major without
 * any change to its own interface). So the check does not decide — it requires the
 * decision be recorded, and then honors it:
 *
 *   - `breaking change` label (or a title `!`) — the break reaches consumers;
 *     `merge-pr.py` stamps `!` and the release is a major.
 *   - `breaking isolated` label — a reviewer confirmed the break stays inside the
 *     dependency; the PR ships at its title's own release type.
 *
 * The check never writes either label, so a human decision is never reverted. And
 * it fails closed rather than open: an undecided major bump blocks, instead of
 * silently merging as non-breaking (the #53 failure mode) or being silently
 * labelled breaking (the #82 one).
 *
 * The axis applies only to a functional-typed title (`prMayCarryBreakingMarker`) —
 * the one shape where `breaking change` survives to become a `!` (#1559). Holding
 * both labels (or `breaking isolated` with a title `!`) is contradictory and blocks
 * regardless of the diff. Split out of `merge-safety.ts` to keep it under its
 * 480-line `max-lines` cap. Pure, like the verdict it feeds.
 */
import { signalDetail } from './breaking-diff.js';
import type { MergeSafetyFacts } from './merge-safety.js';
import { withDetail } from './reasons.js';

/** The label a human (or reviewer agent) applies to declare the PR breaking. */
export const BREAKING_LABEL = 'breaking change';

/**
 * The label that records a reviewed dependency major bump as **not** reaching this
 * package's consumers — the counterpart of {@link BREAKING_LABEL} (#82).
 */
export const BREAKING_ISOLATED_LABEL = 'breaking isolated';

export interface BreakingDecisionVerdict {
  /** The PR must carry (exactly one) explicit breaking decision before merge. */
  needsBreakingDecision: boolean;
  /** The reason line, when the axis fired. */
  reasons: string[];
}

export function evaluateBreakingDecision(facts: MergeSafetyFacts): BreakingDecisionVerdict {
  if (facts.prDeclaresBreaking && facts.prDeclaresBreakingIsolated) {
    return {
      needsBreakingDecision: true,
      reasons: [
        `This PR is marked both breaking (\`${BREAKING_LABEL}\` label or title \`!\`) and ` +
          `\`${BREAKING_ISOLATED_LABEL}\` — keep exactly one so the release type is unambiguous.`,
      ],
    };
  }

  const majorBumps = signalDetail(facts.prBreakingDiffSignals, 'major-version-bump');
  const undecided =
    majorBumps.length > 0 &&
    facts.prMayCarryBreakingMarker &&
    !facts.prDeclaresBreaking &&
    !facts.prDeclaresBreakingIsolated;
  if (!undecided) return { needsBreakingDecision: false, reasons: [] };

  return {
    needsBreakingDecision: true,
    reasons: [
      withDetail(
        'This PR bumps a dependency major version. Decide whether that reaches this ' +
          `package's consumers: label it \`${BREAKING_LABEL}\` if it does (released as a ` +
          `major), or \`${BREAKING_ISOLATED_LABEL}\` if the break stays inside the dependency:`,
        majorBumps,
      ),
    ],
  };
}
