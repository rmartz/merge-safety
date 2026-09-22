import { describe, it, expect } from 'vitest';
import {
  MERGE_SAFETY_LABELS,
  isBreakingCommitMessage,
  isCiCommitMessage,
  isBreakingTitle,
  isCiTitle,
  isEvaluablePrState,
  mayCarryBreakingMarker,
  isFailingCiConclusion,
  isGitHubActionsCheck,
  isNonBuildPlatformCheck,
  failingRequiredBaseChecks,
  failingFallbackBaseChecks,
  hasFileOverlap,
  overlappingFiles,
  evaluateMergeSafety,
  errorMergeSafetyDecision,
  type BaseCheckRun,
  type MergeSafetyFacts,
} from '../src/merge-safety.js';

/** A safe baseline: current, no triggers, no conflict, base CI green. Override per test. */
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

/** A base check-run; defaults to a passing GitHub Actions run named `test`. Override per test. */
function check(overrides: Partial<BaseCheckRun> = {}): BaseCheckRun {
  return { name: 'test', conclusion: 'success', appSlug: 'github-actions', ...overrides };
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

  it('accepts the pre-scope `!` form the coordinator has always accepted (#53)', () => {
    // `feat!(scope):` is not the spec form, but a hand-typed title can take it and
    // the Python `_BREAKING_RE` matches it — reading it as non-breaking here was a
    // live permissive drift between the two implementations.
    expect(isBreakingTitle('feat!(worktree): change default base')).toBe(true);
    expect(isBreakingTitle('feat!: change default base')).toBe(true);
  });
});

describe('isCiTitle', () => {
  it('detects a ci-typed PR title with and without a scope', () => {
    expect(isCiTitle('ci: add typecheck job')).toBe(true);
    expect(isCiTitle('ci(tests): shard the suite')).toBe(true);
  });

  it('is false for non-ci titles, including ones that merely mention ci', () => {
    expect(isCiTitle('feat: wire up cico pipeline')).toBe(false);
    expect(isCiTitle('fix(ci-helper): typo')).toBe(false);
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

describe('isGitHubActionsCheck', () => {
  it('is true only for the github-actions app slug', () => {
    expect(isGitHubActionsCheck(check({ appSlug: 'github-actions' }))).toBe(true);
    expect(isGitHubActionsCheck(check({ appSlug: 'vercel' }))).toBe(false);
    expect(isGitHubActionsCheck(check({ appSlug: null }))).toBe(false);
  });
});

describe('isNonBuildPlatformCheck', () => {
  it('matches the Dependabot job case-insensitively, and nothing else', () => {
    expect(isNonBuildPlatformCheck('Dependabot')).toBe(true);
    expect(isNonBuildPlatformCheck('dependabot')).toBe(true);
    expect(isNonBuildPlatformCheck('Dependabot Updates')).toBe(true);
    expect(isNonBuildPlatformCheck('typecheck')).toBe(false);
    expect(isNonBuildPlatformCheck('Build')).toBe(false);
  });
});

describe('isFailingCiConclusion', () => {
  it('treats failure / timed_out / startup_failure as failing (expansive)', () => {
    expect(isFailingCiConclusion('failure')).toBe(true);
    expect(isFailingCiConclusion('timed_out')).toBe(true);
    expect(isFailingCiConclusion('startup_failure')).toBe(true);
  });

  it('does not treat success, a pending null, or a cancelled/skipped run as failing', () => {
    expect(isFailingCiConclusion('success')).toBe(false);
    expect(isFailingCiConclusion(null)).toBe(false);
    expect(isFailingCiConclusion('cancelled')).toBe(false);
    expect(isFailingCiConclusion('skipped')).toBe(false);
    expect(isFailingCiConclusion('neutral')).toBe(false);
  });
});

describe('failingRequiredBaseChecks', () => {
  const required = ['typecheck', 'test', 'lint'];

  it('returns the names of failing checks that are required contexts', () => {
    expect(
      failingRequiredBaseChecks(
        [
          check({ name: 'typecheck', conclusion: 'failure' }),
          check({ name: 'test', conclusion: 'success' }),
          check({ name: 'lint', conclusion: 'timed_out' }),
        ],
        required,
      ),
    ).toEqual(['typecheck', 'lint']);
  });

  it('ignores a failing check that is NOT a required context (e.g. the Dependabot job)', () => {
    // The crux of #40: a failing job the repo hasn't declared a merge gate — the
    // native "Dependabot Updates" run, other bots, informational checks — must not
    // wedge the queue, so it is never a failing-CI signal.
    expect(
      failingRequiredBaseChecks(
        [
          check({ name: 'Dependabot', conclusion: 'failure' }),
          check({ name: 'test', conclusion: 'success' }),
        ],
        required,
      ),
    ).toEqual([]);
  });

  it('counts a failing required check regardless of its producer (e.g. a required deploy)', () => {
    // A required context is a declared merge gate whoever produces it — so a failing
    // *required* deploy blocks, unlike an unrequired one.
    expect(
      failingRequiredBaseChecks([check({ name: 'Vercel', conclusion: 'failure' })], ['Vercel']),
    ).toEqual(['Vercel']);
  });

  it('reports no failure when the required set is null (unreadable protection)', () => {
    expect(
      failingRequiredBaseChecks([check({ name: 'typecheck', conclusion: 'failure' })], null),
    ).toEqual([]);
  });

  it('reports no failure when no status checks are required', () => {
    expect(
      failingRequiredBaseChecks([check({ name: 'typecheck', conclusion: 'failure' })], []),
    ).toEqual([]);
  });

  it('is empty when every required check is green', () => {
    expect(
      failingRequiredBaseChecks([check({ name: 'test', conclusion: 'success' })], required),
    ).toEqual([]);
  });
});

describe('failingFallbackBaseChecks', () => {
  it('returns the names of failing GitHub Actions checks', () => {
    expect(
      failingFallbackBaseChecks([
        check({ name: 'typecheck', conclusion: 'failure' }),
        check({ name: 'test', conclusion: 'success' }),
        check({ name: 'lint', conclusion: 'timed_out' }),
      ]),
    ).toEqual(['typecheck', 'lint']);
  });

  it('ignores a failing DEPLOY (non-Actions producer) even when it is red', () => {
    // A red deploy under green Actions is likely external and must not wedge the queue.
    expect(
      failingFallbackBaseChecks([
        check({ name: 'Vercel', conclusion: 'failure', appSlug: 'vercel' }),
        check({ name: 'test', conclusion: 'success' }),
      ]),
    ).toEqual([]);
  });

  it('ignores a failing non-build platform job (the Dependabot false positive from #40)', () => {
    expect(
      failingFallbackBaseChecks([
        check({ name: 'Dependabot', conclusion: 'failure' }),
        check({ name: 'typecheck', conclusion: 'failure' }),
      ]),
    ).toEqual(['typecheck']);
  });

  it('is empty when every Actions check is green', () => {
    expect(failingFallbackBaseChecks([check({ conclusion: 'success' })])).toEqual([]);
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

  it('fails a stale PR that is itself a ci change', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false, prIsCi: true }));
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons.some((r) => /this pr is a ci change/i.test(r))).toBe(true);
  });

  it('passes a current PR that is itself a ci change', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: true, prIsCi: true }));
    expect(d.conclusion).toBe('success');
    expect(d.needsUpdate).toBe(false);
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

describe('evaluateMergeSafety base health', () => {
  it('fails a non-hotfix PR when the base CI is failing', () => {
    const d = evaluateMergeSafety(
      makeFacts({ baseCiFailing: true, failingBaseChecks: ['typecheck'] }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.baseUnhealthy).toBe(true);
    expect(d.title).toBe('Base CI failing');
    expect(d.reasons[0]).toMatch(/base branch's CI is failing/i);
    // Base health mints no label — the check-run title/reason carries it.
    expect(d.labels.add).toEqual([]);
  });

  it('exempts a hotfix PR from the base-CI-failing axis', () => {
    const d = evaluateMergeSafety(
      makeFacts({ baseCiFailing: true, prIsHotfix: true, failingBaseChecks: ['typecheck'] }),
    );
    expect(d.conclusion).toBe('success');
    expect(d.baseUnhealthy).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('still holds a hotfix PR on the staleness axis — hotfix exempts only base health', () => {
    const d = evaluateMergeSafety(
      makeFacts({ baseCiFailing: true, prIsHotfix: true, isCurrent: false, fileOverlap: true }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.baseUnhealthy).toBe(false); // exempt on base health…
    expect(d.reasons[0]).toMatch(/files the base also changed since merge-base/i); // …but not staleness
  });

  it('exempts a stale hotfix PR that is itself a ci change from the prIsCi clause', () => {
    const d = evaluateMergeSafety(makeFacts({ isCurrent: false, prIsCi: true, prIsHotfix: true }));
    expect(d.conclusion).toBe('success');
    expect(d.needsUpdate).toBe(false);
    expect(d.labels.add).toEqual([]);
    expect(d.reasons.some((r) => /this pr is a ci change/i.test(r))).toBe(false);
  });

  it('holds a stale hotfix ci PR when a base-side clause also fires — hotfix exempts only prIsCi', () => {
    const d = evaluateMergeSafety(
      makeFacts({
        isCurrent: false,
        prIsCi: true,
        prIsHotfix: true,
        baseCiSinceMergeBase: true,
        baseCiCommits: [{ sha: '1234567abcdef', subject: 'ci: add typecheck job' }],
      }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    // The prIsCi reason is suppressed, but the base-side ci clause still fires.
    expect(d.reasons.some((r) => /this pr is a ci change/i.test(r))).toBe(false);
    expect(d.reasons.some((r) => /a ci change landed on the base/i.test(r))).toBe(true);
  });

  it('still holds a stale hotfix PR that is itself a breaking change — hotfix does not exempt prIsBreaking', () => {
    const d = evaluateMergeSafety(
      makeFacts({ isCurrent: false, prIsBreaking: true, prIsHotfix: true }),
    );
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons.some((r) => /this pr is a breaking change/i.test(r))).toBe(true);
  });

  it('lists the failing base checks as nested bullets under the base-health reason', () => {
    const d = evaluateMergeSafety(
      makeFacts({ baseCiFailing: true, failingBaseChecks: ['typecheck', 'lint'] }),
    );
    expect(d.reasons[0]).toContain('\n  - typecheck\n  - lint');
  });

  it('lets a conflict win the title but still surfaces the base-health reason', () => {
    const d = evaluateMergeSafety(
      makeFacts({ baseCiFailing: true, failingBaseChecks: ['test'], hasConflict: true }),
    );
    expect(d.title).toBe('Merge conflict');
    expect(d.baseUnhealthy).toBe(true);
    expect(d.reasons[0]).toMatch(/merge conflict/i);
    expect(d.reasons.some((r) => /base branch's CI is failing/i.test(r))).toBe(true);
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
    expect(d.baseUnhealthy).toBe(false);
    expect(d.reasons).toEqual(['git log failed for BASE..origin/main']);
    expect(d.labels).toEqual({ add: [], remove: [], addOnly: [] });
  });
});

describe('mayCarryBreakingMarker', () => {
  it('accepts the functional conventional types, with or without scope/marker', () => {
    expect(mayCarryBreakingMarker('feat: add')).toBe(true);
    expect(mayCarryBreakingMarker('fix(auth): repair')).toBe(true);
    expect(mayCarryBreakingMarker('perf!: speed up')).toBe(true);
    expect(mayCarryBreakingMarker('revert(x)!: undo')).toBe(true);
  });

  it('rejects every non-functional type — a label there is stripped at merge (#1559)', () => {
    expect(mayCarryBreakingMarker('chore(deps): bump prettier')).toBe(false);
    expect(mayCarryBreakingMarker('ci(deps): bump black')).toBe(false);
    expect(mayCarryBreakingMarker('docs: clarify')).toBe(false);
    expect(mayCarryBreakingMarker('refactor(core): extract')).toBe(false);
  });

  it('rejects a non-conventional title', () => {
    expect(mayCarryBreakingMarker('just some words')).toBe(false);
    expect(mayCarryBreakingMarker('')).toBe(false);
  });
});

/** A facts fixture carrying one diff-derived breaking signal. */
function withSignal(
  kind: 'major-version-bump' | 'sensitive-package-bump' | 'material-test-changes',
  detail: string[],
  over: Partial<MergeSafetyFacts> = {},
): MergeSafetyFacts {
  return makeFacts({
    prIsBreaking: true,
    prBreakingDiffSignals: [{ kind, detail }],
    ...over,
  });
}

describe('evaluateMergeSafety — the diff-derived breaking signals (#53)', () => {
  it('names the triggering signal in the breaking reason of a stale PR', () => {
    const d = evaluateMergeSafety(
      withSignal('major-version-bump', ['left-pad 2.1.0 → 3.0.0'], { isCurrent: false }),
    );
    expect(d.needsUpdate).toBe(true);
    expect(d.reasons.join('\n')).toContain('dependency major bump: left-pad 2.1.0 → 3.0.0');
  });

  it('proposes `breaking change` for a major bump on a functional-typed PR', () => {
    const d = evaluateMergeSafety(
      withSignal('major-version-bump', ['left-pad 2.1.0 → 3.0.0'], {
        prMayCarryBreakingMarker: true,
      }),
    );
    expect(d.labels.addOnly).toEqual(['breaking change']);
    // Add-only: it never appears in the reconciled removals.
    expect(d.labels.remove).toEqual([...MERGE_SAFETY_LABELS]);
  });

  it('withholds the label on a non-functional type, where merge would strip it', () => {
    const d = evaluateMergeSafety(
      withSignal('major-version-bump', ['left-pad 2.1.0 → 3.0.0'], {
        prMayCarryBreakingMarker: false,
      }),
    );
    expect(d.labels.addOnly).toEqual([]);
  });

  it('never proposes the label for a test-only signal — that would fire a spurious major', () => {
    const d = evaluateMergeSafety(
      withSignal('material-test-changes', ['a.test.ts'], { prMayCarryBreakingMarker: true }),
    );
    expect(d.labels.addOnly).toEqual([]);
    expect(d.needsCiRetitle).toBe(false);
  });

  it('never proposes the label for a CI-sensitive bump, even on a functional type', () => {
    const d = evaluateMergeSafety(
      withSignal('sensitive-package-bump', ['prettier 3.9.7 → 3.9.8'], {
        prMayCarryBreakingMarker: true,
      }),
    );
    expect(d.labels.addOnly).toEqual([]);
  });
});

describe('evaluateMergeSafety — the retitle axis (#53)', () => {
  const sensitive = ['prettier 3.9.7 → 3.9.8'];

  it('fails a current, conflict-free PR that bumps a linter without the `ci` type', () => {
    const d = evaluateMergeSafety(withSignal('sensitive-package-bump', sensitive));
    expect(d.needsCiRetitle).toBe(true);
    expect(d.conclusion).toBe('failure');
    expect(d.needsUpdate).toBe(false);
    expect(d.title).toBe('Retitle as a CI change');
    expect(d.summary).toContain('CI-sensitive package version');
    expect(d.reasons.join('\n')).toContain('prettier 3.9.7 → 3.9.8');
  });

  it('clears once the PR is `ci`-typed — the prefix carries the sibling rebase', () => {
    const d = evaluateMergeSafety(
      withSignal('sensitive-package-bump', sensitive, { prIsCi: true }),
    );
    expect(d.needsCiRetitle).toBe(false);
    expect(d.conclusion).toBe('success');
    expect(d.title).toBe('No update required');
  });

  it('does not fire for the other diff signals', () => {
    expect(
      evaluateMergeSafety(withSignal('major-version-bump', ['x 1.0.0 → 2.0.0'])).needsCiRetitle,
    ).toBe(false);
    expect(
      evaluateMergeSafety(withSignal('material-test-changes', ['a.test.ts'])).needsCiRetitle,
    ).toBe(false);
  });

  it('yields the title to staleness, and its reason stays last so the summary agrees', () => {
    const d = evaluateMergeSafety(
      withSignal('sensitive-package-bump', sensitive, {
        isCurrent: false,
        fileOverlap: true,
        overlappingFiles: ['src/a.ts'],
      }),
    );
    expect(d.needsCiRetitle).toBe(true);
    expect(d.title).toBe('Update required');
    expect(firstLineOf(d.summary)).toBe(firstLineOf(d.reasons[0] ?? ''));
    expect(d.reasons[d.reasons.length - 1]).toContain('Retitle it with the `ci` type');
  });

  it('yields the title to a conflict and to a red base', () => {
    const conflicting = evaluateMergeSafety(
      withSignal('sensitive-package-bump', sensitive, { hasConflict: true }),
    );
    expect(conflicting.title).toBe('Merge conflict');
    const redBase = evaluateMergeSafety(
      withSignal('sensitive-package-bump', sensitive, { baseCiFailing: true }),
    );
    expect(redBase.title).toBe('Base CI failing');
  });
});

/** The headline sentence of a reason, which is all the one-line summary carries. */
function firstLineOf(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

describe('evaluateMergeSafety — the stacked-base barrier (#54)', () => {
  const child = (over: Partial<MergeSafetyFacts> = {}) =>
    makeFacts({ baseBranch: 'issue-53-foo', stackedOnPr: 42, ...over });

  it('holds a stacked PR that is otherwise perfectly mergeable', () => {
    const d = evaluateMergeSafety(child());
    expect(d.stackedBarred).toBe(true);
    expect(d.conclusion).toBe('failure');
    expect(d.title).toBe('Base PR not merged');
    expect(d.needsUpdate).toBe(false);
    expect(d.summary).toContain('#42');
  });

  it('mints no label — the outcome rides on the title and reason, like base health', () => {
    const d = evaluateMergeSafety(child());
    expect(d.labels.add).toEqual([]);
    expect(d.labels.addOnly).toEqual([]);
    expect(d.labels.remove).toEqual([...MERGE_SAFETY_LABELS]);
  });

  it('passes a PR that is not stacked', () => {
    const d = evaluateMergeSafety(makeFacts({ stackedOnPr: null }));
    expect(d.stackedBarred).toBe(false);
    expect(d.conclusion).toBe('success');
  });

  it('yields the title to a conflict — the more concrete blocker still leads', () => {
    const d = evaluateMergeSafety(child({ hasConflict: true }));
    expect(d.title).toBe('Merge conflict');
    expect(d.stackedBarred).toBe(true);
  });

  it('outranks base health and staleness in the title', () => {
    const d = evaluateMergeSafety(
      child({ baseCiFailing: true, isCurrent: false, fileOverlap: true }),
    );
    expect(d.title).toBe('Base PR not merged');
    // Every axis still reports independently, and the summary tracks reasons[0].
    expect(d.baseUnhealthy).toBe(true);
    expect(d.needsUpdate).toBe(true);
    expect(firstLineOf(d.summary)).toBe(firstLineOf(d.reasons[0] ?? ''));
  });

  it('is reported false on the ungatherable fail-safe verdict', () => {
    expect(errorMergeSafetyDecision('boom').stackedBarred).toBe(false);
  });
});
