import { describe, it, expect } from 'vitest';
import {
  gatherMergeSafetyFacts,
  type GitRunner,
  type PrMergeMeta,
} from '../src/merge-safety-facts.js';
import {
  makeApiGitRunner,
  COMPARE_MAX_COMMITS,
  COMPARE_MAX_FILES,
  COMMIT_MAX_FILES,
  type GitHubApiGet,
} from '../src/api-fact-source.js';

const REPO = 'o/r';
const HEAD = 'HEAD1';

/** One base commit since the merge base. */
interface ScenarioCommit {
  sha: string;
  message: string;
  files: string[];
  merge?: boolean;
}

/** One PR-side changed file; `patch` is the hunks, `changes` its changed-line count. */
interface ScenarioFile {
  filename: string;
  previous?: string;
  patch?: string;
  changes?: number;
}

/**
 * A repository state both fact sources are built from, so a parity test runs the
 * same scenario through `git` and through the API. `baseCommits` is oldest first.
 */
interface Scenario {
  mergeBase: string;
  tip: string;
  baseCommits: ScenarioCommit[];
  baseFiles: string[];
  prFiles: ScenarioFile[];
}

/** The `git` fake: the exact output each query gatherMergeSafetyFacts makes yields. */
function gitFor(s: Scenario): GitRunner {
  const newestFirst = [...s.baseCommits].reverse();
  const mb = s.mergeBase;
  const responses: Record<string, string> = {
    [`merge-base ${HEAD} origin/main`]: `${mb}\n`,
    'rev-parse origin/main': `${s.tip}\n`,
    [`log -z --format=%H%n%B ${mb}..origin/main`]: newestFirst
      .map((c) => `${c.sha}\n${c.message}\n`)
      .join('\0'),
    [`log --format=%x00%H --name-only ${mb}..origin/main`]: newestFirst
      .map((c) => `\0${c.sha}\n` + (c.merge ? '' : `\n${c.files.join('\n')}\n`))
      .join(''),
    [`diff --name-only ${mb} origin/main`]: s.baseFiles.join('\n'),
    [`diff --name-only ${mb} ${HEAD}`]: s.prFiles.map((f) => f.filename).join('\n'),
    [`diff --unified=0 ${mb} ${HEAD}`]: s.prFiles
      .map((f) => {
        const a = f.previous ?? f.filename;
        const body = f.patch === undefined ? '' : `${f.patch}\n`;
        return `diff --git a/${a} b/${f.filename}\n--- a/${a}\n+++ b/${f.filename}\n${body}`;
      })
      .join(''),
  };
  return async (args) => responses[args.join(' ')] ?? null;
}

/** The API responses for the same scenario, as the GitHub REST API returns them. */
function apiResponses(s: Scenario): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [`repos/${REPO}/branches/main`]: { commit: { sha: s.tip } },
    [`repos/${REPO}/compare/${HEAD}...${s.tip}`]: {
      merge_base_commit: { sha: s.mergeBase },
      total_commits: s.baseCommits.length,
      commits: s.baseCommits.map((c) => ({
        sha: c.sha,
        commit: { message: c.message },
        parents: c.merge ? [{ sha: 'p1' }, { sha: 'p2' }] : [{ sha: 'p1' }],
      })),
      files: s.baseFiles.map((filename) => ({ filename, changes: 1, patch: '@@ -1 +1 @@' })),
    },
    [`repos/${REPO}/compare/${s.tip}...${HEAD}`]: {
      merge_base_commit: { sha: s.mergeBase },
      total_commits: 1,
      commits: [],
      files: s.prFiles.map((f) => ({
        filename: f.filename,
        previous_filename: f.previous,
        changes: f.changes ?? (f.patch === undefined ? 0 : 1),
        patch: f.patch,
      })),
    },
  };
  for (const c of s.baseCommits) {
    responses[`repos/${REPO}/commits/${c.sha}`] = {
      sha: c.sha,
      files: c.files.map((filename) => ({ filename })),
    };
  }
  return responses;
}

/** A fake API getter over a response table; a missing path reads as `null`. */
function fakeApi(responses: Record<string, unknown>, seen: string[] = []): GitHubApiGet {
  return async (path) => {
    seen.push(path);
    return responses[path] ?? null;
  };
}

function apiFor(s: Scenario): GitRunner {
  return makeApiGitRunner({ repo: REPO, api: fakeApi(apiResponses(s)) });
}

const probes = { baseChecks: async () => [], requiredChecks: async () => null };

const meta: PrMergeMeta = {
  headSha: HEAD,
  title: 'feat: add a thing',
  labels: [],
  mergeable: 'MERGEABLE',
};

const stale: Scenario = {
  mergeBase: 'BASE',
  tip: 'TIP',
  baseCommits: [{ sha: 'sha-fix', message: 'fix: small', files: ['src/a.ts'] }],
  baseFiles: ['src/a.ts'],
  prFiles: [{ filename: 'src/b.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
};

const scenarios: { name: string; scenario: Scenario; meta?: Partial<PrMergeMeta> }[] = [
  { name: 'a stale PR with no triggers', scenario: stale },
  {
    name: 'a current PR (merge base is the tip)',
    scenario: { ...stale, mergeBase: 'TIP', baseCommits: [], baseFiles: [] },
  },
  {
    name: 'a breaking base commit, a ci commit and a file overlap',
    scenario: {
      ...stale,
      baseCommits: [
        { sha: 'sha-ci', message: 'ci: add job', files: ['scripts/x.sh'] },
        { sha: 'sha-break', message: 'feat(api)!: rename field', files: ['src/shared.ts'] },
      ],
      baseFiles: ['src/shared.ts', 'scripts/x.sh'],
      prFiles: [
        { filename: 'src/shared.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'src/b.ts', patch: '@@ -0,0 +1 @@\n+b' },
      ],
    },
  },
  {
    name: 'a breaking-change footer in a multi-line body',
    scenario: {
      ...stale,
      baseCommits: [
        {
          sha: 'sha-foot',
          message: 'feat: add flag\n\nBREAKING CHANGE: config renamed',
          files: ['src/a.ts'],
        },
      ],
    },
  },
  {
    name: 'release-typed base commits that changed CI paths, and a lookalike path',
    scenario: {
      ...stale,
      baseCommits: [
        { sha: 'sha-feat', message: 'feat: ship input', files: ['.github/workflows/ci.yml'] },
        { sha: 'sha-perf', message: 'perf: cache', files: ['.github/actions/setup/action.yml'] },
        { sha: 'sha-doc', message: 'docs: x', files: ['docs/.github/workflows/x.yml'] },
      ],
      baseFiles: ['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
    },
  },
  {
    name: 'a merge commit on the base, whose files git log does not list',
    scenario: {
      ...stale,
      baseCommits: [
        {
          sha: 'sha-merge',
          message: 'Merge branch x',
          files: ['.github/workflows/ci.yml'],
          merge: true,
        },
      ],
    },
  },
  {
    name: 'a docs-only base',
    scenario: {
      ...stale,
      baseCommits: [
        { sha: 'sha-d1', message: 'docs: one', files: ['docs/a.md'] },
        { sha: 'sha-d2', message: 'docs(scope): two', files: ['docs/b.md'] },
      ],
      baseFiles: ['docs/a.md', 'docs/b.md'],
    },
  },
  {
    name: 'a PR that changes a workflow',
    scenario: {
      ...stale,
      prFiles: [{ filename: '.github/workflows/merge-safety.yml', patch: '@@ -1 +1 @@\n-a\n+b' }],
    },
  },
  {
    name: 'a CI-sensitive package bump in the PR diff',
    meta: { title: 'chore(deps): bump prettier' },
    scenario: {
      ...stale,
      prFiles: [
        {
          filename: 'package.json',
          patch: '@@ -1 +1 @@\n-    "prettier": "^3.9.7",\n+    "prettier": "^3.9.8",',
        },
      ],
    },
  },
  {
    name: 'a major version bump and a materially changed test file',
    scenario: {
      ...stale,
      prFiles: [
        {
          filename: 'package.json',
          patch: '@@ -3 +3 @@\n-    "zod": "^3.2.0",\n+    "zod": "^4.0.0",',
        },
        { filename: 'test/a.test.ts', patch: '@@ -5 +5 @@\n-  expect(1)\n+  expect(2)' },
      ],
    },
  },
  {
    name: 'a binary file and a pure rename (no patch, no changed lines)',
    scenario: {
      ...stale,
      prFiles: [
        { filename: 'img/logo.png' },
        { filename: 'test/new.test.ts', previous: 'test/old.test.ts' },
      ],
    },
  },
];

describe('the API fact source agrees with the git fact source', () => {
  for (const { name, scenario, meta: overrides } of scenarios) {
    it(name, async () => {
      const m = { ...meta, ...overrides };
      const viaGit = await gatherMergeSafetyFacts(m, { ...probes, git: gitFor(scenario) });
      const viaApi = await gatherMergeSafetyFacts(m, { ...probes, git: apiFor(scenario) });
      expect(viaApi).toEqual(viaGit);
    });
  }

  it('sees the scenarios the parity table is meant to exercise', async () => {
    // Guard against a parity table that only ever compares two all-false fact sets.
    const breaking = scenarios[2]?.scenario as Scenario;
    const facts = await gatherMergeSafetyFacts(meta, { ...probes, git: apiFor(breaking) });
    expect(facts.isCurrent).toBe(false);
    expect(facts.baseBreakingCommits).toEqual([
      { sha: 'sha-break', subject: 'feat(api)!: rename field' },
    ]);
    expect(facts.baseCiCommits).toEqual([{ sha: 'sha-ci', subject: 'ci: add job' }]);
    expect(facts.overlappingFiles).toEqual(['src/shared.ts']);

    const ciPaths = scenarios[4]?.scenario as Scenario;
    const ci = await gatherMergeSafetyFacts(meta, { ...probes, git: apiFor(ciPaths) });
    expect(ci.baseCiCommits.map((c) => c.sha)).toEqual(['sha-perf', 'sha-feat']);
  });

  it('reads each base commit once, and skips merge commits', async () => {
    const seen: string[] = [];
    const scenario: Scenario = {
      ...stale,
      baseCommits: [
        { sha: 'sha-a', message: 'fix: a', files: ['src/a.ts'] },
        { sha: 'sha-m', message: 'Merge x', files: [], merge: true },
      ],
    };
    const git = makeApiGitRunner({ repo: REPO, api: fakeApi(apiResponses(scenario), seen) });
    await gatherMergeSafetyFacts(meta, { ...probes, git });
    expect(seen.filter((p) => p.includes('/commits/'))).toEqual([`repos/${REPO}/commits/sha-a`]);
    expect(seen.filter((p) => p.includes('/compare/'))).toHaveLength(2);
  });
});

describe('the API fact source fails closed', () => {
  /** Gather over `stale`, with `patch` applied to its API responses. */
  function gatherWith(patch: (r: Record<string, unknown>) => void) {
    const responses = apiResponses(stale);
    patch(responses);
    const git = makeApiGitRunner({ repo: REPO, api: fakeApi(responses) });
    return gatherMergeSafetyFacts(meta, { ...probes, git });
  }
  const baseCompare = `repos/${REPO}/compare/${HEAD}...TIP`;
  const prCompare = `repos/${REPO}/compare/TIP...${HEAD}`;
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ filename: `f${i}`, changes: 1, patch: '@@' }));

  it(`past the ${COMPARE_MAX_COMMITS}-commit compare cap`, async () => {
    await expect(
      gatherWith((r) => {
        Object.assign(r[baseCompare] as object, { total_commits: COMPARE_MAX_COMMITS + 1 });
      }),
    ).rejects.toThrow(/250-commit cap/);
  });

  it(`at the ${COMPARE_MAX_FILES}-file compare cap on the base side`, async () => {
    await expect(
      gatherWith((r) => {
        Object.assign(r[baseCompare] as object, { files: files(COMPARE_MAX_FILES) });
      }),
    ).rejects.toThrow(/base diff lists 300 files/);
  });

  it(`at the ${COMPARE_MAX_FILES}-file compare cap on the PR side`, async () => {
    await expect(
      gatherWith((r) => {
        Object.assign(r[prCompare] as object, { files: files(COMPARE_MAX_FILES) });
      }),
    ).rejects.toThrow(/PR diff lists 300 files/);
  });

  it('on a changed PR file whose patch the API omitted', async () => {
    await expect(
      gatherWith((r) => {
        Object.assign(r[prCompare] as object, {
          files: [{ filename: 'dist/huge.js', changes: 40_000 }],
        });
      }),
    ).rejects.toThrow(/omitted the patch for dist\/huge\.js/);
  });

  it(`on a base commit at the ${COMMIT_MAX_FILES}-file commit cap with no CI path seen`, async () => {
    await expect(
      gatherWith((r) => {
        r[`repos/${REPO}/commits/sha-fix`] = { files: files(COMMIT_MAX_FILES) };
      }),
    ).rejects.toThrow(/300-file cap/);
  });

  it('on a failed API read', async () => {
    await expect(
      gatherWith((r) => {
        delete r[prCompare];
      }),
    ).rejects.toThrow(/GitHub API read failed/);
  });

  it('on a git query it does not map', async () => {
    const git = makeApiGitRunner({ repo: REPO, api: fakeApi({}) });
    await expect(git(['status'])).rejects.toThrow(/does not support `git status`/);
  });
});
