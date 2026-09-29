import { describe, it, expect } from 'vitest';
import {
  gatherMergeSafetyFacts,
  baseBranchName,
  type BaseChecksProbe,
  type GitRunner,
  type PrMergeMeta,
  type RequiredChecksProbe,
} from '../src/merge-safety-facts.js';
import type { BaseCheckRun } from '../src/merge-safety.js';

/** A fake `git` keyed by argv joined with spaces; missing keys return `null`. */
function fakeGit(responses: Record<string, string>): GitRunner {
  return async (args) => responses[args.join(' ')] ?? null;
}

/** A base-checks probe that always returns the same list (base CI green by default). */
function fakeChecks(checks: readonly BaseCheckRun[] = []): BaseChecksProbe {
  return async () => checks;
}

/** A required-checks probe returning a fixed set (default `null` → nothing gates). */
function fakeRequired(contexts: readonly string[] | null = null): RequiredChecksProbe {
  return async () => contexts;
}

const meta: PrMergeMeta = {
  headSha: 'HEAD1',
  title: 'feat: add a thing',
  labels: [],
  mergeable: 'MERGEABLE',
};

/** The git responses for a stale PR whose base has no breaking/ci/overlap triggers. */
function cleanStaleGit(): GitRunner {
  return fakeGit({
    'merge-base HEAD1 origin/main': 'BASE',
    'rev-parse origin/main': 'TIP',
    'log -z --format=%H%n%B BASE..origin/main': 'sha-fix\nfix: small',
    'log --format=%x00%H --name-only BASE..origin/main': '',
    'diff --name-only BASE origin/main': 'src/a.ts',
    'diff --name-only BASE HEAD1': 'src/b.ts',
    'diff --unified=0 BASE HEAD1': '',
  });
}

describe('gatherMergeSafetyFacts', () => {
  it('assembles stale facts from git output — breaking base commit + file overlap', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP', // != BASE → stale
      'log -z --format=%H%n%B BASE..origin/main':
        'sha-break\nfeat(api)!: rename field\0sha-ci\nci: add job',
      'log --format=%x00%H --name-only BASE..origin/main': '',
      'diff --name-only BASE origin/main': 'src/a.ts\nsrc/shared.ts',
      'diff --name-only BASE HEAD1': 'src/shared.ts\nsrc/b.ts',
      'diff --unified=0 BASE HEAD1': '',
    });

    const facts = await gatherMergeSafetyFacts(meta, {
      git,
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    });

    expect(facts.isCurrent).toBe(false);
    expect(facts.baseBreakingSinceMergeBase).toBe(true);
    expect(facts.baseCiSinceMergeBase).toBe(true);
    expect(facts.fileOverlap).toBe(true); // src/shared.ts on both sides
    expect(facts.prIsBreaking).toBe(false);
    expect(facts.hasConflict).toBe(false);
    // The detail lists name which commits / files triggered each verdict.
    expect(facts.baseBreakingCommits).toEqual([
      { sha: 'sha-break', subject: 'feat(api)!: rename field' },
    ]);
    expect(facts.baseCiCommits).toEqual([{ sha: 'sha-ci', subject: 'ci: add job' }]);
    expect(facts.overlappingFiles).toEqual(['src/shared.ts']);
  });

  it('detects a breaking-change footer in a multi-line base commit body', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main':
        'sha-foot\nfeat: add flag\n\nBREAKING CHANGE: config renamed',
      'log --format=%x00%H --name-only BASE..origin/main': '',
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
      'diff --unified=0 BASE HEAD1': '',
    });

    const facts = await gatherMergeSafetyFacts(meta, {
      git,
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    });

    // Subject is the first line; the footer on a later line still trips detection.
    expect(facts.baseBreakingCommits).toEqual([{ sha: 'sha-foot', subject: 'feat: add flag' }]);
  });

  it('reports current + no triggers when merge-base equals the base tip', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'TIP',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B TIP..origin/main': '',
      'log --format=%x00%H --name-only TIP..origin/main': '',
      'diff --name-only TIP origin/main': '',
      'diff --name-only TIP HEAD1': 'src/b.ts',
      'diff --unified=0 TIP HEAD1': '',
    });

    const facts = await gatherMergeSafetyFacts(meta, {
      git,
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    });

    expect(facts.isCurrent).toBe(true);
    expect(facts.baseBreakingSinceMergeBase).toBe(false);
    expect(facts.fileOverlap).toBe(false);
    expect(facts.baseBreakingCommits).toEqual([]);
    expect(facts.overlappingFiles).toEqual([]);
  });

  it('honors the breaking-change label and a CONFLICTING mergeable state', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Breaking Change'], mergeable: 'conflicting' },
      { git: cleanStaleGit(), baseChecks: fakeChecks(), requiredChecks: fakeRequired() },
    );

    expect(facts.prIsBreaking).toBe(true);
    expect(facts.hasConflict).toBe(true);
  });

  it('flags prIsCi from a ci-typed PR title (and not from a plain feat title)', async () => {
    const ci = await gatherMergeSafetyFacts(
      { ...meta, title: 'ci(tests): shard the suite' },
      { git: cleanStaleGit(), baseChecks: fakeChecks(), requiredChecks: fakeRequired() },
    );
    expect(ci.prIsCi).toBe(true);

    const feat = await gatherMergeSafetyFacts(meta, {
      git: cleanStaleGit(),
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    });
    expect(feat.prIsCi).toBe(false);
  });

  it('throws when the per-commit file log returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha-fix\nfix: small',
      // `log --name-only` key absent → null
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
      'diff --unified=0 BASE HEAD1': '',
    });
    await expect(
      gatherMergeSafetyFacts(meta, {
        git,
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      }),
    ).rejects.toThrow(/git log failed/);
  });

  it('flags base CI failing from a failing required base check, probing the base tip + branch', async () => {
    let probedSha: string | undefined;
    let probedBranch: string | undefined;
    const baseChecks: BaseChecksProbe = async (sha) => {
      probedSha = sha;
      return [{ name: 'typecheck', conclusion: 'failure', appSlug: 'github-actions' }];
    };
    const requiredChecks: RequiredChecksProbe = async (branch) => {
      probedBranch = branch;
      return ['typecheck'];
    };

    const facts = await gatherMergeSafetyFacts(meta, {
      git: cleanStaleGit(),
      baseChecks,
      requiredChecks,
    });

    expect(probedSha).toBe('TIP'); // judged against the base tip, not the merge-base
    expect(probedBranch).toBe('main'); // required checks keyed on the plain branch name
    expect(facts.baseCiFailing).toBe(true);
    expect(facts.failingBaseChecks).toEqual(['typecheck']);
    expect(facts.prIsHotfix).toBe(false);
  });

  it('does not flag base CI failing for a failing check that is not a required context', async () => {
    // A failing job the repo hasn't declared a merge gate (e.g. the native
    // "Dependabot Updates" run) must not wedge the queue.
    const baseChecks = fakeChecks([
      { name: 'Dependabot', conclusion: 'failure', appSlug: 'github-actions' },
      { name: 'test', conclusion: 'success', appSlug: 'github-actions' },
    ]);

    const facts = await gatherMergeSafetyFacts(meta, {
      git: cleanStaleGit(),
      baseChecks,
      requiredChecks: fakeRequired(['test']),
    });

    expect(facts.baseCiFailing).toBe(false);
    expect(facts.failingBaseChecks).toEqual([]);
  });

  it('falls back to the failing-Actions heuristic when the required set is unreadable', async () => {
    // No queryable ruleset (requiredChecks → null): a failing Actions build still
    // blocks, but the non-build Dependabot job is excluded by the denylist (#40).
    const baseChecks = fakeChecks([
      { name: 'Dependabot', conclusion: 'failure', appSlug: 'github-actions' },
      { name: 'typecheck', conclusion: 'failure', appSlug: 'github-actions' },
      { name: 'Vercel', conclusion: 'failure', appSlug: 'vercel' },
    ]);

    const facts = await gatherMergeSafetyFacts(meta, {
      git: cleanStaleGit(),
      baseChecks,
      requiredChecks: fakeRequired(null),
    });

    expect(facts.baseCiFailing).toBe(true);
    expect(facts.failingBaseChecks).toEqual(['typecheck']);
  });

  it('reads the hotfix label case-insensitively', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Hotfix'] },
      { git: cleanStaleGit(), baseChecks: fakeChecks(), requiredChecks: fakeRequired() },
    );

    expect(facts.prIsHotfix).toBe(true);
  });

  it('throws when the merge-base cannot be resolved (caller must fail the check)', async () => {
    const git = fakeGit({ 'rev-parse origin/main': 'TIP' });
    await expect(
      gatherMergeSafetyFacts(meta, {
        git,
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      }),
    ).rejects.toThrow(/merge-base/);
  });

  it('throws when git log returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      // log key absent → null
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
      'diff --unified=0 BASE HEAD1': '',
    });
    await expect(
      gatherMergeSafetyFacts(meta, {
        git,
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      }),
    ).rejects.toThrow(/git log failed/);
  });

  it('throws when git diff returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha1\nfeat!: breaking',
      'log --format=%x00%H --name-only BASE..origin/main': '',
      // diff keys absent → null
    });
    await expect(
      gatherMergeSafetyFacts(meta, {
        git,
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      }),
    ).rejects.toThrow(/git diff failed/);
  });
});

describe('baseBranchName', () => {
  it('strips a remote or refs/heads prefix to the plain branch name', () => {
    expect(baseBranchName('origin/main')).toBe('main');
    expect(baseBranchName('refs/heads/release/1.x')).toBe('release/1.x');
    expect(baseBranchName('main')).toBe('main');
  });
});

describe('gatherMergeSafetyFacts — the diff-derived breaking signals (#53)', () => {
  /** A stale-PR git fake whose PR patch is `prDiff`. */
  function gitWithPrDiff(prDiff: string): GitRunner {
    return fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha-fix\nfix: small',
      'log --format=%x00%H --name-only BASE..origin/main': '',
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'package.json',
      'diff --unified=0 BASE HEAD1': prDiff,
    });
  }

  const prettierBump = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1 @@',
    '-    "prettier": "^3.9.7",',
    '+    "prettier": "^3.9.8",',
  ].join('\n');

  it('derives prIsBreaking from the diff when the title and labels say nothing', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, title: 'chore(deps): bump prettier' },
      {
        git: gitWithPrDiff(prettierBump),
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      },
    );

    expect(facts.prIsBreaking).toBe(true);
    expect(facts.prBreakingDiffSignals.map((s) => s.kind)).toEqual(['sensitive-package-bump']);
    expect(facts.prBreakingDiffSignals[0]?.detail).toEqual(['prettier 3.9.7 → 3.9.8']);
  });

  it('leaves prIsBreaking false when the diff, title and labels all say nothing', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      git: gitWithPrDiff(''),
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    });

    expect(facts.prIsBreaking).toBe(false);
    expect(facts.prBreakingDiffSignals).toEqual([]);
  });

  it('keeps the label as an independent input — it still forces prIsBreaking alone', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Breaking Change'] },
      { git: gitWithPrDiff(''), baseChecks: fakeChecks(), requiredChecks: fakeRequired() },
    );

    expect(facts.prIsBreaking).toBe(true);
    expect(facts.prBreakingDiffSignals).toEqual([]);
  });

  it('records whether the title type could carry a `!` marker', async () => {
    const opts = {
      git: gitWithPrDiff(''),
      baseChecks: fakeChecks(),
      requiredChecks: fakeRequired(),
    };
    const functional = await gatherMergeSafetyFacts({ ...meta, title: 'fix: repair' }, opts);
    expect(functional.prMayCarryBreakingMarker).toBe(true);

    const nonFunctional = await gatherMergeSafetyFacts({ ...meta, title: 'chore: tidy' }, opts);
    expect(nonFunctional.prMayCarryBreakingMarker).toBe(false);
  });

  it('throws when the PR patch cannot be read — an ungatherable PR is never green', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha-fix\nfix: small',
      'log --format=%x00%H --name-only BASE..origin/main': '',
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
      // no `diff --unified=0` key → the runner yields null
    });

    await expect(
      gatherMergeSafetyFacts(meta, {
        git,
        baseChecks: fakeChecks(),
        requiredChecks: fakeRequired(),
      }),
    ).rejects.toThrow('git diff failed');
  });
});

describe('gatherMergeSafetyFacts — the stacked-base barrier (#54)', () => {
  /** A clean current-PR git fake on `baseRef`. */
  function gitOn(baseRef: string): GitRunner {
    return fakeGit({
      [`merge-base HEAD1 ${baseRef}`]: 'TIP',
      [`rev-parse ${baseRef}`]: 'TIP',
      [`log -z --format=%H%n%B TIP..${baseRef}`]: '',
      [`log --format=%x00%H --name-only TIP..${baseRef}`]: '',
      [`diff --name-only TIP ${baseRef}`]: '',
      'diff --name-only TIP HEAD1': 'src/b.ts',
      'diff --unified=0 TIP HEAD1': '',
    });
  }

  const base = {
    baseChecks: fakeChecks(),
    requiredChecks: fakeRequired(),
    defaultBranch: 'main',
  };

  it('records the parent PR when the base is another open PR head', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      ...base,
      baseRef: 'origin/issue-53-foo',
      git: gitOn('origin/issue-53-foo'),
      basePr: async () => ({ number: 42, labels: [] }),
    });

    expect(facts.baseBranch).toBe('issue-53-foo');
    expect(facts.stackedOnPr).toBe(42);
  });

  it('skips the probe entirely for a PR based on the default branch', async () => {
    let probed = 0;
    const facts = await gatherMergeSafetyFacts(meta, {
      ...base,
      git: gitOn('origin/main'),
      basePr: async () => {
        probed += 1;
        return { number: 42, labels: [] };
      },
    });

    expect(probed).toBe(0);
    expect(facts.baseBranch).toBe('main');
    expect(facts.stackedOnPr).toBeNull();
  });

  it('applies the exempt-label policy from the caller', async () => {
    const opts = {
      ...base,
      baseRef: 'origin/release-train',
      git: gitOn('origin/release-train'),
      basePr: async () => ({ number: 7, labels: ['release'] }),
    };

    const exempted = await gatherMergeSafetyFacts(meta, opts);
    expect(exempted.stackedOnPr).toBeNull();

    const barred = await gatherMergeSafetyFacts(meta, { ...opts, exemptBaseLabels: [] });
    expect(barred.stackedOnPr).toBe(7);
  });

  it('leaves the barrier inert when the default branch is unresolved', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      ...base,
      defaultBranch: null,
      baseRef: 'origin/issue-53-foo',
      git: gitOn('origin/issue-53-foo'),
      basePr: async () => ({ number: 42, labels: [] }),
    });

    expect(facts.stackedOnPr).toBeNull();
  });

  it('treats an unreadable base-PR lookup as not stacked', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      ...base,
      baseRef: 'origin/issue-53-foo',
      git: gitOn('origin/issue-53-foo'),
      basePr: async () => null,
    });

    expect(facts.stackedOnPr).toBeNull();
  });
});

describe('gatherMergeSafetyFacts — the path-based CI signal (#67)', () => {
  /** A stale-PR git fake with the given base messages, base per-commit files, and PR files. */
  function gitWith(opts: { log: string; baseFileLog: string; prFiles: string }): GitRunner {
    return fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': opts.log,
      'log --format=%x00%H --name-only BASE..origin/main': opts.baseFileLog,
      'diff --name-only BASE origin/main': 'src/a.ts\n.github/workflows/ci.yml',
      'diff --name-only BASE HEAD1': opts.prFiles,
      'diff --unified=0 BASE HEAD1': '',
    });
  }

  const probes = { baseChecks: fakeChecks(), requiredChecks: fakeRequired() };

  it('counts a merged feat/perf commit that changed .github/workflows or .github/actions as a CI commit', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWith({
        log: 'sha-feat\nfeat: ship a workflow input\0sha-perf\nperf: cache action\0sha-fix\nfix: small',
        baseFileLog:
          '\0sha-feat\n\n.github/workflows/ci.yml\nsrc/a.ts\n' +
          '\0sha-perf\n\n.github/actions/setup/action.yml\n' +
          '\0sha-fix\n\nsrc/a.ts\n',
        prFiles: 'src/b.ts',
      }),
    });

    expect(facts.baseCiSinceMergeBase).toBe(true);
    expect(facts.baseCiCommits).toEqual([
      { sha: 'sha-feat', subject: 'feat: ship a workflow input' },
      { sha: 'sha-perf', subject: 'perf: cache action' },
    ]);
  });

  it('does not count a commit touching a lookalike path outside .github/workflows or .github/actions', async () => {
    const facts = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWith({
        log: 'sha-doc\ndocs: describe workflows',
        baseFileLog: '\0sha-doc\n\ndocs/.github/workflows/x.yml\n.github/dependabot.yml\n',
        prFiles: 'src/b.ts',
      }),
    });

    expect(facts.baseCiSinceMergeBase).toBe(false);
    expect(facts.baseCiCommits).toEqual([]);
  });

  it('flags prIsCi when the PR diff itself changes a workflow or local action', async () => {
    const workflow = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWith({
        log: '',
        baseFileLog: '',
        prFiles: 'src/b.ts\n.github/workflows/merge-safety.yml',
      }),
    });
    expect(workflow.prIsCi).toBe(true);

    const action = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWith({ log: '', baseFileLog: '', prFiles: '.github/actions/setup/action.yml' }),
    });
    expect(action.prIsCi).toBe(true);
  });

  it('keeps the title-based signals unchanged alongside the paths', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, title: 'ci: add job' },
      {
        ...probes,
        git: gitWith({
          log: 'sha-ci\nci: add job',
          baseFileLog: '\0sha-ci\n\nscripts/check.sh\n',
          prFiles: 'src/b.ts',
        }),
      },
    );

    expect(facts.prIsCi).toBe(true);
    expect(facts.baseCiCommits).toEqual([{ sha: 'sha-ci', subject: 'ci: add job' }]);
  });
});

describe('gatherMergeSafetyFacts — the docs facts', () => {
  /** A stale-PR git fake whose base moved by the given commits. */
  function gitWithLog(log: string): GitRunner {
    return fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': log,
      'log --format=%x00%H --name-only BASE..origin/main': '',
      'diff --name-only BASE origin/main': 'docs/a.md',
      'diff --name-only BASE HEAD1': 'src/b.ts',
      'diff --unified=0 BASE HEAD1': '',
    });
  }

  const probes = { baseChecks: fakeChecks(), requiredChecks: fakeRequired() };

  it('flags baseOnlyDocsSinceMergeBase only when every base commit is docs-typed', async () => {
    const allDocs = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWithLog('sha-d1\ndocs: one\0sha-d2\ndocs(scope): two'),
    });
    expect(allDocs.baseOnlyDocsSinceMergeBase).toBe(true);

    const mixed = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWithLog('sha-d1\ndocs: one\0sha-fix\nfix: small'),
    });
    expect(mixed.baseOnlyDocsSinceMergeBase).toBe(false);

    const none = await gatherMergeSafetyFacts(meta, { ...probes, git: gitWithLog('') });
    expect(none.baseOnlyDocsSinceMergeBase).toBe(false);
  });

  it('flags prIsDocs from a docs-typed title', async () => {
    const docs = await gatherMergeSafetyFacts(
      { ...meta, title: 'docs(consuming): clarify' },
      { ...probes, git: gitWithLog('sha-fix\nfix: small') },
    );
    expect(docs.prIsDocs).toBe(true);

    const feat = await gatherMergeSafetyFacts(meta, {
      ...probes,
      git: gitWithLog('sha-fix\nfix: small'),
    });
    expect(feat.prIsDocs).toBe(false);
  });
});
