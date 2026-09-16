import { describe, it, expect } from 'vitest';
import {
  gatherMergeSafetyFacts,
  type GitRunner,
  type PrMergeMeta,
} from '../src/merge-safety-facts.js';

/** A fake `git` keyed by argv joined with spaces; missing keys return `null`. */
function fakeGit(responses: Record<string, string>): GitRunner {
  return async (args) => responses[args.join(' ')] ?? null;
}

const meta: PrMergeMeta = {
  headSha: 'HEAD1',
  title: 'feat: add a thing',
  labels: [],
  mergeable: 'MERGEABLE',
};

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

    const facts = await gatherMergeSafetyFacts(meta, { git });

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

    const facts = await gatherMergeSafetyFacts(meta, { git });

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

    const facts = await gatherMergeSafetyFacts(meta, { git });

    expect(facts.isCurrent).toBe(true);
    expect(facts.baseBreakingSinceMergeBase).toBe(false);
    expect(facts.fileOverlap).toBe(false);
    expect(facts.baseBreakingCommits).toEqual([]);
    expect(facts.overlappingFiles).toEqual([]);
  });

  it('honors the breaking-change label and a CONFLICTING mergeable state', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha-fix\nfix: small',
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
    });

    const facts = await gatherMergeSafetyFacts(
      { ...meta, labels: ['Breaking Change'], mergeable: 'conflicting' },
      { git },
    );

    expect(facts.prIsBreaking).toBe(true);
    expect(facts.hasConflict).toBe(true);
  });

  it('throws when the merge-base cannot be resolved (caller must fail the check)', async () => {
    const git = fakeGit({ 'rev-parse origin/main': 'TIP' });
    await expect(gatherMergeSafetyFacts(meta, { git })).rejects.toThrow(/merge-base/);
  });

  it('throws when git log returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      // log key absent → null
      'diff --name-only BASE origin/main': 'src/a.ts',
      'diff --name-only BASE HEAD1': 'src/b.ts',
    });
    await expect(gatherMergeSafetyFacts(meta, { git })).rejects.toThrow(/git log failed/);
  });

  it('throws when git diff returns null — never silently produces false success', async () => {
    const git = fakeGit({
      'merge-base HEAD1 origin/main': 'BASE',
      'rev-parse origin/main': 'TIP',
      'log -z --format=%H%n%B BASE..origin/main': 'sha1\nfeat!: breaking',
      // diff keys absent → null
    });
    await expect(gatherMergeSafetyFacts(meta, { git })).rejects.toThrow(/git diff failed/);
  });
});
