import { describe, it, expect } from 'vitest';
import {
  evaluateMergeSafety,
  isDocsCommitMessage,
  isDocsTitle,
  type MergeSafetyFacts,
} from '../src/merge-safety.js';
import { evaluateStaleness } from '../src/staleness.js';

/** A stale PR with no triggers, no conflict, base CI green. Override per test. */
function staleFacts(overrides: Partial<MergeSafetyFacts> = {}): MergeSafetyFacts {
  return {
    isCurrent: false,
    baseBreakingSinceMergeBase: false,
    baseCiSinceMergeBase: false,
    prIsBreaking: false,
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
    prBreakingDiffSignals: [],
    prMayCarryBreakingMarker: false,
    ...overrides,
  };
}

const featBang = { sha: 'abcdef1234', subject: 'feat!: drop node 18' };
const ciCommit = { sha: '1234567abc', subject: 'ci: add link checker' };

describe('isDocsTitle / isDocsCommitMessage', () => {
  it('detects the docs type with and without a scope', () => {
    expect(isDocsTitle('docs: fix a typo')).toBe(true);
    expect(isDocsTitle('docs(consuming): explain the caller')).toBe(true);
    expect(isDocsCommitMessage('docs: fix a typo\n\nbody')).toBe(true);
  });

  it('is false for other types, including ones that merely mention docs', () => {
    expect(isDocsTitle('feat: generate docs')).toBe(false);
    expect(isDocsTitle('fix(docs-site): typo')).toBe(false);
    expect(isDocsCommitMessage('chore: docs: nested')).toBe(false);
  });
});

describe('evaluateStaleness — the docs carve-outs', () => {
  it('lets a breaking PR behind only docs commits through when files do not overlap', () => {
    const d = evaluateMergeSafety(
      staleFacts({ prIsBreaking: true, baseOnlyDocsSinceMergeBase: true }),
    );
    expect(d.needsUpdate).toBe(false);
    expect(d.conclusion).toBe('success');
  });

  it('still holds a breaking PR behind only docs commits when the files overlap', () => {
    const d = evaluateMergeSafety(
      staleFacts({
        prIsBreaking: true,
        baseOnlyDocsSinceMergeBase: true,
        fileOverlap: true,
        overlappingFiles: ['README.md'],
      }),
    );
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/changes files the base also changed/);
  });

  it('still holds a breaking PR when the base moved by anything beyond docs commits', () => {
    const d = evaluateMergeSafety(staleFacts({ prIsBreaking: true }));
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons[0]).toMatch(/This PR is a breaking change/);
  });

  it('lets a docs PR behind a breaking commit through when files do not overlap', () => {
    const d = evaluateMergeSafety(
      staleFacts({
        prIsDocs: true,
        baseBreakingSinceMergeBase: true,
        baseBreakingCommits: [featBang],
      }),
    );
    expect(d.needsUpdate).toBe(false);
    expect(d.conclusion).toBe('success');
  });

  it('still holds a docs PR behind a breaking commit when the files overlap', () => {
    const { needsUpdate, reasons } = evaluateStaleness(
      staleFacts({
        prIsDocs: true,
        baseBreakingSinceMergeBase: true,
        baseBreakingCommits: [featBang],
        fileOverlap: true,
        overlappingFiles: ['docs/overview.md'],
      }),
    );
    expect(needsUpdate).toBe(true);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/changes files the base also changed/);
  });

  it('gives a docs PR whose own diff is breaking no carve-out from a breaking base', () => {
    const { needsUpdate, reasons } = evaluateStaleness(
      staleFacts({
        prIsDocs: true,
        prIsBreaking: true,
        baseBreakingSinceMergeBase: true,
        baseBreakingCommits: [featBang],
      }),
    );
    expect(needsUpdate).toBe(true);
    expect(reasons[0]).toMatch(/A breaking change landed on the base/);
  });

  it('still forces a docs PR current past a CI commit on the base', () => {
    const d = evaluateMergeSafety(
      staleFacts({ prIsDocs: true, baseCiSinceMergeBase: true, baseCiCommits: [ciCommit] }),
    );
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons[0]).toMatch(/A CI change landed on the base/);
  });

  it('still forces a CI PR current when the base moved only by docs commits', () => {
    const d = evaluateMergeSafety(staleFacts({ prIsCi: true, baseOnlyDocsSinceMergeBase: true }));
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons[0]).toMatch(/This PR is a CI change/);
  });

  it('never needs an update when the PR is current', () => {
    expect(
      evaluateStaleness(
        staleFacts({ isCurrent: true, prIsBreaking: true, baseBreakingSinceMergeBase: true }),
      ),
    ).toEqual({ needsUpdate: false, reasons: [] });
  });
});
