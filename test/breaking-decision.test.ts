import { describe, it, expect } from 'vitest';
import { evaluateMergeSafety, type MergeSafetyFacts } from '../src/merge-safety.js';
import { evaluateBreakingDecision } from '../src/breaking-decision.js';

// #82: a dependency major bump on a functional-typed PR is held until it carries an
// explicit `breaking change` or `breaking isolated` label. The check reads both
// labels and never writes either, so a human decision is never reverted.

const majorBump = ['@rmartz/pr-lifecycle 9.2.1 → 10.0.0'];

/** A current, clean, functional-typed PR whose diff bumps a dependency major. */
function bumpFacts(overrides: Partial<MergeSafetyFacts> = {}): MergeSafetyFacts {
  return {
    isCurrent: true,
    baseBreakingSinceMergeBase: false,
    baseCiSinceMergeBase: false,
    prIsBreaking: true,
    prDeclaresBreaking: false,
    prDeclaresBreakingIsolated: false,
    prIsDocs: false,
    baseOnlyDocsSinceMergeBase: false,
    prIsCi: false,
    fileOverlap: false,
    hasConflict: false,
    baseCiFailing: false,
    prIsHotfix: false,
    baseBreakingCommits: [],
    baseCiCommits: [],
    overlappingFiles: [],
    failingBaseChecks: [],
    prBreakingDiffSignals: [{ kind: 'major-version-bump', detail: majorBump }],
    prMayCarryBreakingMarker: true,
    ...overrides,
  };
}

describe('evaluateMergeSafety — the breaking-decision axis (#82)', () => {
  it('fails an undecided major bump and names the bumped package', () => {
    const d = evaluateMergeSafety(bumpFacts());
    expect(d.needsBreakingDecision).toBe(true);
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Breaking decision required');
    expect(d.summary).toContain('bumps a dependency major version');
    expect(d.reasons.join('\n')).toContain('@rmartz/pr-lifecycle 9.2.1 → 10.0.0');
  });

  it('proposes no labels — the decision is never written by the check', () => {
    const d = evaluateMergeSafety(bumpFacts());
    expect(d.labels.add).toEqual([]);
    expect(d.labels.remove).not.toContain('breaking change');
    expect(d.labels.remove).not.toContain('breaking isolated');
  });

  it('passes once the PR is labelled `breaking change` (or titled with `!`)', () => {
    const d = evaluateMergeSafety(bumpFacts({ prDeclaresBreaking: true }));
    expect(d.needsBreakingDecision).toBe(false);
    expect(d.conclusion).toBe('success');
  });

  it('passes once the PR is labelled `breaking isolated`', () => {
    const d = evaluateMergeSafety(bumpFacts({ prDeclaresBreakingIsolated: true }));
    expect(d.needsBreakingDecision).toBe(false);
    expect(d.conclusion).toBe('success');
  });

  it('keeps `breaking isolated` out of the staleness axis — a stale bump still updates', () => {
    const d = evaluateMergeSafety(
      bumpFacts({ prDeclaresBreakingIsolated: true, isCurrent: false }),
    );
    expect(d.needsUpdate).toBe(true);
    expect(d.conclusion).toBe('pending');
  });

  it('fails a PR carrying both decisions, even without a major bump', () => {
    const d = evaluateMergeSafety(
      bumpFacts({
        prDeclaresBreaking: true,
        prDeclaresBreakingIsolated: true,
        prBreakingDiffSignals: [],
      }),
    );
    expect(d.needsBreakingDecision).toBe(true);
    expect(d.conclusion).toBe('failure');
    expect(d.summary).toContain('keep exactly one');
  });

  it('skips a non-functional type, where merge would strip the label anyway', () => {
    const d = evaluateMergeSafety(bumpFacts({ prMayCarryBreakingMarker: false }));
    expect(d.needsBreakingDecision).toBe(false);
  });

  it('ignores the other diff signals — only a major bump asks for a decision', () => {
    const verdict = evaluateBreakingDecision(
      bumpFacts({
        prBreakingDiffSignals: [{ kind: 'material-test-changes', detail: ['a.test.ts'] }],
      }),
    );
    expect(verdict).toEqual({ needsBreakingDecision: false, reasons: [] });
  });

  it('leads with a conflict when the PR also conflicts', () => {
    const d = evaluateMergeSafety(bumpFacts({ hasConflict: true }));
    expect(d.title).toBe('Merge conflict');
    expect(d.reasons.join('\n')).toContain('bumps a dependency major version');
  });
});
