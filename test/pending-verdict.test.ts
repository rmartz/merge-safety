import { describe, it, expect } from 'vitest';
import { evaluateMergeSafety, type MergeSafetyFacts } from '../src/merge-safety.js';

// #58: a stale-only verdict holds the PR as `pending` (an incomplete check-run,
// yellow) rather than `failure` (red). Anything a branch update alone cannot clear
// keeps `failure`, including staleness combined with it.

function makeFacts(overrides: Partial<MergeSafetyFacts> = {}): MergeSafetyFacts {
  return {
    isCurrent: true,
    baseBreakingSinceMergeBase: false,
    baseCiSinceMergeBase: false,
    prIsBreaking: false,
    prIsCi: false,
    fileOverlap: false,
    hasConflict: false,
    baseCiFailing: false,
    prIsHotfix: false,
    baseBreakingCommits: [],
    baseCiCommits: [],
    overlappingFiles: [],
    failingBaseChecks: [],
    prBreakingDiffSignals: [],
    prMayCarryBreakingMarker: false,
    baseBranch: 'main',
    stackedOnPr: null,
    ...overrides,
  };
}

/** Stale on the file-overlap clause alone — the simplest stale-only PR. */
const stale = (overrides: Partial<MergeSafetyFacts> = {}) =>
  makeFacts({ isCurrent: false, fileOverlap: true, overlappingFiles: ['src/a.ts'], ...overrides });

describe('pending verdict (#58)', () => {
  it('keeps the Update required title, reasons, and label on a stale-only PR', () => {
    const d = evaluateMergeSafety(stale());
    expect(d.conclusion).toBe('pending');
    expect(d.title).toBe('Update required');
    expect(d.summary).toMatch(/files the base also changed/i);
    expect(d.reasons).toHaveLength(1);
    expect(d.labels.add).toEqual(['update required']);
    expect(d.labels.remove).toEqual(['merge conflict']);
  });

  it('fails a stale PR that also has a merge conflict', () => {
    const d = evaluateMergeSafety(stale({ hasConflict: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Merge conflict');
    expect(d.labels.add).toEqual(['update required', 'merge conflict']);
  });

  it('fails a stale PR whose base CI is failing', () => {
    const d = evaluateMergeSafety(stale({ baseCiFailing: true, failingBaseChecks: ['test'] }));
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Base CI failing');
  });

  it('holds a stale hotfix as pending when a failing base is its only other issue', () => {
    // hotfix exempts base health, so staleness is all that is left.
    const d = evaluateMergeSafety(
      stale({ baseCiFailing: true, failingBaseChecks: ['test'], prIsHotfix: true }),
    );
    expect(d.conclusion).toBe('pending');
    expect(d.baseUnhealthy).toBe(false);
  });

  it('fails a stale PR held behind an unmerged base PR', () => {
    const d = evaluateMergeSafety(stale({ baseBranch: 'feature-a', stackedOnPr: 12 }));
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Base PR not merged');
  });

  it('fails a stale PR that also needs a ci retitle', () => {
    const d = evaluateMergeSafety(
      stale({
        prBreakingDiffSignals: [{ kind: 'sensitive-package-bump', detail: ['prettier 3 → 4'] }],
      }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.needsCiRetitle).toBe(true);
  });

  it('fails a current PR on the non-staleness axes (never pending)', () => {
    expect(evaluateMergeSafety(makeFacts({ hasConflict: true })).conclusion).toBe('failure');
    expect(
      evaluateMergeSafety(makeFacts({ baseCiFailing: true, failingBaseChecks: ['test'] }))
        .conclusion,
    ).toBe('failure');
  });
});
