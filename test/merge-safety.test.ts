import { describe, it, expect } from 'vitest';
import {
  isBreakingCommitMessage,
  isCiCommitMessage,
  isBreakingTitle,
  overlappingFiles,
} from '../src/merge-safety.js';

// Coverage for the shared predicates this module carries. The verdict logic
// (evaluateMergeSafety / errorMergeSafetyDecision) and its tests land in #4.

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
