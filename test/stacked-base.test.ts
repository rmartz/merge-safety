import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXEMPT_BASE_LABELS,
  isExemptBasePr,
  stackedBaseReason,
  stackedParentPr,
  type BasePr,
} from '../src/stacked-base.js';

const parent: BasePr = { number: 42, labels: [] };
const exempt = [...DEFAULT_EXEMPT_BASE_LABELS];

/** The barrier inputs for a child of `parent` on a non-default base. */
function stacked(over: Partial<Parameters<typeof stackedParentPr>[0]> = {}) {
  return {
    baseBranch: 'issue-53-foo',
    defaultBranch: 'main',
    basePr: parent,
    exemptLabels: exempt,
    ...over,
  };
}

describe('isExemptBasePr', () => {
  it('matches an exempt label case-insensitively and ignoring surrounding space', () => {
    expect(isExemptBasePr({ number: 1, labels: ['Release'] }, exempt)).toBe(true);
    expect(isExemptBasePr({ number: 1, labels: [' epic '] }, exempt)).toBe(true);
  });

  it('is false for an unrelated label set, and for no labels at all', () => {
    expect(isExemptBasePr({ number: 1, labels: ['enhancement', 'UI'] }, exempt)).toBe(false);
    expect(isExemptBasePr({ number: 1, labels: [] }, exempt)).toBe(false);
  });

  it('honours an overridden exempt set, including an empty one', () => {
    expect(isExemptBasePr({ number: 1, labels: ['train'] }, ['train'])).toBe(true);
    expect(isExemptBasePr({ number: 1, labels: ['release'] }, [])).toBe(false);
  });
});

describe('stackedParentPr', () => {
  it('names the parent PR a stacked child must wait for', () => {
    expect(stackedParentPr(stacked())).toBe(42);
  });

  it('is null for the ordinary case — a PR based on the default branch', () => {
    expect(stackedParentPr(stacked({ baseBranch: 'main' }))).toBeNull();
  });

  it('is null when no open PR heads the base — nothing will ever land to release it', () => {
    // A long-lived integration branch with no tracking PR. Barring it would strand
    // the PR forever, so the barrier deliberately does not apply.
    expect(stackedParentPr(stacked({ basePr: null }))).toBeNull();
  });

  it('is null when the base PR is an exempt accumulator', () => {
    expect(stackedParentPr(stacked({ basePr: { number: 7, labels: ['release'] } }))).toBeNull();
    expect(stackedParentPr(stacked({ basePr: { number: 8, labels: ['epic'] } }))).toBeNull();
  });

  it('bars an otherwise-exempt base once the exempt set is overridden to empty', () => {
    expect(
      stackedParentPr(stacked({ basePr: { number: 9, labels: ['release'] }, exemptLabels: [] })),
    ).toBe(9);
  });

  it('is disabled entirely when the default branch could not be resolved', () => {
    // Never-wedge: an unresolved default branch must not strand every open PR.
    expect(stackedParentPr(stacked({ defaultBranch: null }))).toBeNull();
    expect(stackedParentPr(stacked({ defaultBranch: '' }))).toBeNull();
  });

  it('is null for an empty base branch rather than treating it as non-default', () => {
    expect(stackedParentPr(stacked({ baseBranch: '' }))).toBeNull();
  });
});

describe('stackedBaseReason', () => {
  it('names the base branch and the PR to wait for, and says merge alone is held', () => {
    const reason = stackedBaseReason('issue-53-foo', 42);
    expect(reason).toContain('`issue-53-foo`');
    expect(reason).toContain('#42');
    expect(reason).toContain('only the merge is held');
  });
});
