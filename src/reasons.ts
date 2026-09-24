/**
 * Reason presentation for the merge-safety check-run — how a verdict's facts are
 * rendered as the human-readable lines the check-run output carries.
 *
 * Split from `merge-safety.ts` (the verdict *logic*) so each stays under its
 * `max-lines` cap as axes accumulate: #53 added the diff-derived breaking signals
 * and #54 the stacked-base barrier. Presentation is a genuinely separate concern —
 * nothing here decides anything, it only formats.
 */
import type { BreakingDiffKind, BreakingDiffSignal } from './breaking-diff.js';

/** A base commit surfaced in a reason so the report names *which* commit triggered it. */
export interface BaseCommit {
  /** The full commit SHA (rendered abbreviated in the report). */
  sha: string;
  /** The commit subject (first line of its message). */
  subject: string;
}

/** Human phrasing for each diff-derived breaking signal, used in the check-run reason. */
const BREAKING_DIFF_REASONS: Record<BreakingDiffKind, string> = {
  'major-version-bump': 'dependency major bump',
  'sensitive-package-bump': 'CI-sensitive package version change',
  'material-test-changes': 'existing test file modified',
};

/** Nested markdown bullets, indented two spaces so they sit under a reason's `- `. */
function nestedBullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

/** `<short-sha> <subject>` — the one-line form a base commit takes in a reason. */
export function formatBaseCommit(commit: BaseCommit): string {
  return `${commit.sha.slice(0, 7)} ${commit.subject}`;
}

/** A reason sentence, with its detail list (if any) appended as nested bullets. */
export function withDetail(sentence: string, detail: readonly string[]): string {
  return detail.length ? `${sentence}\n${nestedBullets(detail)}` : sentence;
}

/** Every diff-derived breaking signal as `<phrase>: <package or file>` detail lines. */
export function breakingSignalDetail(signals: readonly BreakingDiffSignal[]): string[] {
  return signals.flatMap((s) => s.detail.map((d) => `${BREAKING_DIFF_REASONS[s.kind]}: ${d}`));
}
