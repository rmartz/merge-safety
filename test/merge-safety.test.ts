import { describe, it, expect } from 'vitest';
import {
  MERGE_SAFETY_LABELS,
  isBreakingCommitMessage,
  isCiCommitMessage,
  isBreakingTitle,
  isEvaluablePrState,
  hasFileOverlap,
  overlappingFiles,
  evaluateMergeSafety,
  errorMergeSafetyDecision,
  type MergeSafetyFacts,
} from '../src/merge-safety.js';

/** A safe baseline: current, no triggers, no conflict. Override per test. */
function makeFacts(overrides: Partial<MergeSafetyFacts> = {}): MergeSafetyFacts {
  return {
    isCurrent: true,
    baseBreakingSinceMergeBase: false,
    baseCiSinceMergeBase: false,
    prIsBreaking: false,
    fileOverlap: false,
    hasConflict: false,
    baseBreakingCommits: [],
    baseCiCommits: [],
    overlappingFiles: [],
    ...overrides,
  };
}

describe('isBreakingCommitMessage', () => {
  it('detects the subject `!` marker with and without a scope', () => {
    expect(isBreakingCommitMessage('feat!: drop node 18')).toBe(true);
    expect(isBreakingCommitMessage('feat(api)!: rename field')).toBe(true);
  });

  it('detects a BREAKING CHANGE footer in the body', () => {
    expect(isBreakingCommitMessage('feat: add flag\n\nBREAKING CHANGE: config renamed')).toBe(true);
    expect(isBreakingCommitMessage('fix: x\n\nBREAKING-CHANGE: y')).toBe(true);
  });

  it('is false for a plain conventional commit', () => {
    expect(isBreakingCommitMessage('feat(api): add field')).toBe(false);
    expect(isBreakingCommitMessage('fix: correct off-by-one')).toBe(false);
  });
});

describe('isCiCommitMessage', () => {
  it('detects the ci type with and without scope', () => {
    expect(isCiCommitMessage('ci: add typecheck job')).toBe(true);
    expect(isCiCommitMessage('ci(tests): shard the suite')).toBe(true);
  });

  it('is false for non-ci types, including ones that merely mention ci', () => {
    expect(isCiCommitMessage('feat: wire up cico pipeline')).toBe(false);
    expect(isCiCommitMessage('fix(ci-helper): typo')).toBe(false);
  });
});

describe('isBreakingTitle', () => {
  it('mirrors the subject-marker rule on a PR title', () => {
    expect(isBreakingTitle('feat(worktree)!: change default base')).toBe(true);
    expect(isBreakingTitle('chore: bump deps')).toBe(false);
  });
});

describe('isEvaluablePrState', () => {
  it('evaluates an OPEN PR', () => {
    expect(isEvaluablePrState('OPEN')).toBe(true);
  });

  it('skips a CLOSED or MERGED PR — no verdict belongs on a settled PR', () => {
    expect(isEvaluablePrState('CLOSED')).toBe(false);
    expect(isEvaluablePrState('MERGED')).toBe(false);
  });
});

describe('overlappingFiles', () => {
  it('returns the intersection in PR order', () => {
    expect(overlappingFiles(['b.ts', 'a.ts', 'c.ts'], ['a.ts', 'c.ts'])).toEqual(['a.ts', 'c.ts']);
  });

  it('is empty for disjoint sets and for either side empty', () => {
    expect(overlappingFiles(['a.ts'], ['b.ts'])).toEqual([]);
    expect(overlappingFiles([], ['a.ts'])).toEqual([]);
    expect(overlappingFiles(['a.ts'], [])).toEqual([]);
  });
});

describe('hasFileOverlap', () => {
  it('is true when the sets intersect', () => {
    expect(hasFileOverlap(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])).toBe(true);
  });

  it('is false for disjoint sets and for either side empty', () => {
    expect(hasFileOverlap(['a.ts'], ['b.ts'])).toBe(false);
    expect(hasFileOverlap([], ['a.ts'])).toBe(false);
    expect(hasFileOverlap(['a.ts'], [])).toBe(false);
  });
});

describe('evaluateMergeSafety', () => {
  it('passes a current PR even when the base has breaking + overlapping changes', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: true,
        baseBreakingSinceMergeBase: true,
        fileOverlap: true,
        prIsBreaking: true,
      }),
    );
    expect(d.conclusion).toBe('success');
    expect(d.needsUpdate).toBe(false);
    expect(d.labels.add).toEqual([]);
    expect(d.labels.remove).toEqual([...MERGE_SAFETY_LABELS]);
  });

  it('fails a stale PR when a breaking change landed on the base', () => {
    const d = evaluateMergeSafety(
      makeFacts({ isCurrent: false, baseBreakingSinceMergeBase: true }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.labels.add).toEqual(['update required']);
    expect(d.reasons[0]).toMatch(/breaking change landed on the base/i);
  });

  it('fails a stale PR that is itself breaking', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false, prIsBreaking: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons.some((r) => /this pr is a breaking change/i.test(r))).toBe(true);
  });

  it('fails a stale PR when a ci change landed on the base', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false, baseCiSinceMergeBase: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
  });

  it('fails a stale PR only via file overlap (the narrowing clause)', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false, fileOverlap: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons[0]).toMatch(/files the base also changed since merge-base/i);
  });

  it('lists the overlapping files as nested bullets under the overlap reason', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: false,
        fileOverlap: true,
        overlappingFiles: ['src/shared.ts', 'docs/x.md'],
      }),
    );
    expect(d.reasons[0]).toContain('\n  - src/shared.ts\n  - docs/x.md');
  });

  it('names the base commit (abbreviated sha + subject) that landed a breaking change', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: false,
        baseBreakingSinceMergeBase: true,
        baseBreakingCommits: [{ sha: 'abcdef1234567890', subject: 'feat(api)!: rename field' }],
      }),
    );
    expect(d.reasons[0]).toContain('\n  - abcdef1 feat(api)!: rename field');
  });

  it('names the base commit that landed a ci change', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: false,
        baseCiSinceMergeBase: true,
        baseCiCommits: [{ sha: '1234567abcdef', subject: 'ci: add typecheck job' }],
      }),
    );
    expect(d.reasons.some((r) => r.includes('\n  - 1234567 ci: add typecheck job'))).toBe(true);
  });

  it('keeps the summary to one line even when a reason carries nested detail', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: false,
        fileOverlap: true,
        overlappingFiles: ['src/shared.ts', 'src/other.ts'],
      }),
    );
    expect(d.summary).not.toContain('\n');
    expect(d.summary).toMatch(/files the base also changed since merge-base/i);
  });

  it('passes a stale PR with no breaking/ci/overlap triggers', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false }));
    expect(d.conclusion).toBe('success');
    expect(d.needsUpdate).toBe(false);
    expect(d.labels.add).toEqual([]);
  });

  it('flags a conflict on its own axis, independent of staleness', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: true, hasConflict: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(false);
    expect(d.hasConflict).toBe(true);
    expect(d.labels.add).toEqual(['merge conflict']);
    expect(d.labels.remove).toEqual(['update required']);
  });

  it('adds both labels when a stale PR needs update and also conflicts', () => {
    const d = evaluateMergeSafety(
      makeFacts({ isCurrent: false, prIsBreaking: true, hasConflict: true }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.labels.add).toEqual(['update required', 'merge conflict']);
    expect(d.labels.remove).toEqual([]);
    // Conflict is the most severe reason, listed first.
    expect(d.reasons[0]).toMatch(/merge conflict/i);
  });
});

describe('evaluateMergeSafety title', () => {
  it('reads "No update required" when safe', () => {
    expect(evaluateMergeSafety(makeFacts({ isCurrent: false })).title).toBe('No update required');
  });

  it('reads "Update required" when stale with a trigger', () => {
    expect(evaluateMergeSafety(makeFacts({ isCurrent: false, fileOverlap: true })).title).toBe(
      'Update required',
    );
  });

  it('reads "Merge conflict", which wins over a co-occurring update trigger', () => {
    const d = evaluateMergeSafety(
      makeFacts({ isCurrent: false, fileOverlap: true, hasConflict: true }),
    );
    expect(d.title).toBe('Merge conflict');
    expect(d.needsUpdate).toBe(true); // still flagged in the labels/summary, just not the title
  });
});

describe('errorMergeSafetyDecision', () => {
  it('is a fail-safe failure verdict carrying the message and proposing no labels', () => {
    const d = errorMergeSafetyDecision('git log failed for BASE..origin/main');
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Could not evaluate');
    expect(d.needsUpdate).toBe(false); // genuinely unknown — safety rides on `failure`
    expect(d.hasConflict).toBe(false);
    expect(d.reasons).toEqual(['git log failed for BASE..origin/main']);
    expect(d.labels).toEqual({ add: [], remove: [] });
  });
});
