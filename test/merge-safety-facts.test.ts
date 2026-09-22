import { describe, it, expect } from 'vitest';
import {
  gatherMergeSafetyFacts,
  type BaseChecksProbe,
  type GitRunner,
  type PrMergeMeta,
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
    'diff --name-only BASE origin/main': 'src/a.ts',
    'diff --name-only BASE HEAD1': 'src/b.ts',
  });
}

describe('gatherMergeSafetyFacts', () => {
  it('assembles stale facts from git output — breaking base commit + file overlap', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP', // != BASE → stale
      'log -z --format=%H%n%B BASE..origin/main':
        'sha-break\nfeat(api)!: rename field\0sha-ci\nci: add job',
      'diff --name-only BASE origin/main': 'src/a.ts\nsrc/shared.ts',
      'diff --name-only BASE HEAD1': 'src/shared.ts\nsrc/b.ts',
    });

    const facts = await gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() });

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
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
    });

    const facts = await gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() });

    // Subject is the first line; the footer on a later line still trips detection.
    expect(facts.baseBreakingCommits).toEqual([{ sha: 'sha-foot', subject: 'feat: add flag' }]);
  });

  it('reports current + no triggers when merge-base equals the base tip', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'TIP',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B TIP..origin/main': '',
      'diff --name-only TIP origin/main': '',
      'diff --name-only TIP HEAD1': 'src/b.ts',
    });

    const facts = await gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() });

    expect(facts.isCurrent).toBe(true);
    expect(facts.baseBreakingSinceMergeBase).toBe(false);
    expect(facts.fileOverlap).toBe(false);
    expect(facts.baseBreakingCommits).toEqual([]);
    expect(facts.overlappingFiles).toEqual([]);
  });

  it('honors the breaking-change label and a CONFLICTING mergeable state', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Breaking Change'], mergeable: 'conflicting' },
      { git: cleanStaleGit(), baseChecks: fakeChecks() },
    );

    expect(facts.prIsBreaking).toBe(true);
    expect(facts.hasConflict).toBe(true);
  });

  it('flags prIsCi from a ci-typed PR title (and not from a plain feat title)', async () => {
    const ci = await gatherMergeSafetyFacts(
      { ...meta, title: 'ci(tests): shard the suite' },
      { git: cleanStaleGit(), baseChecks: fakeChecks() },
    );
    expect(ci.prIsCi).toBe(true);

    const feat = await gatherMergeSafetyFacts(meta, {
      git: cleanStaleGit(),
      baseChecks: fakeChecks(),
    });
    expect(feat.prIsCi).toBe(false);
  });

  it('flags base CI failing from a failing base Actions check, and probes the base tip', async () => {
    let probedSha: string | undefined;
    const baseChecks: BaseChecksProbe = async (sha) => {
      probedSha = sha;
      return [{ name: 'typecheck', conclusion: 'failure', appSlug: 'github-actions' }];
    };

    const facts = await gatherMergeSafetyFacts(meta, { git: cleanStaleGit(), baseChecks });

    expect(probedSha).toBe('TIP'); // judged against the base tip, not the merge-base
    expect(facts.baseCiFailing).toBe(true);
    expect(facts.failingBaseChecks).toEqual(['typecheck']);
    expect(facts.prIsHotfix).toBe(false);
  });

  it('does not flag base CI failing for a failing deploy under green Actions', async () => {
    const baseChecks = fakeChecks([
      { name: 'Vercel', conclusion: 'failure', appSlug: 'vercel' },
      { name: 'test', conclusion: 'success', appSlug: 'github-actions' },
    ]);

    const facts = await gatherMergeSafetyFacts(meta, { git: cleanStaleGit(), baseChecks });

    expect(facts.baseCiFailing).toBe(false);
    expect(facts.failingBaseChecks).toEqual([]);
  });

  it('reads the hotfix label case-insensitively', async () => {
    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Hotfix'] },
      { git: cleanStaleGit(), baseChecks: fakeChecks() },
    );

    expect(facts.prIsHotfix).toBe(true);
  });

  it('throws when the merge-base cannot be resolved (caller must fail the check)', async () => {
    const git = fakeGit({ 'rev-parse origin/main': 'TIP' });
    await expect(gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() })).rejects.toThrow(
      /merge-base/,
    );
  });

  it('throws when git log returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      // log key absent → null
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
    });
    await expect(gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() })).rejects.toThrow(
      /git log failed/,
    );
  });

  it('throws when git diff returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha1\nfeat!: breaking',
      // diff keys absent → null
    });
    await expect(gatherMergeSafetyFacts(meta, { git, baseChecks: fakeChecks() })).rejects.toThrow(
      /git diff failed/,
    );
  });
});
