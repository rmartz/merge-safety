import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MergeSafetyFacts } from '../src/merge-safety.js';
import type { Args } from '../src/bin/merge-safety.js';

// The bin's only real-world boundaries are the `gh`/`git` transport and the
// fact-gatherer. Mock both so every test is hermetic — no gh, no git, no network —
// and assert on the argv/stdin the orchestration hands the transport. The verdict
// mapping (evaluateMergeSafety) is left REAL, so these tests exercise the actual
// decision → check-run/label wiring, not a stub of it.
const ghCall = vi.fn();
const resolveRepoTarget = vi.fn();
const addLabels = vi.fn();
const removeLabel = vi.fn();
vi.mock('../src/lib/github.js', () => ({ ghCall, resolveRepoTarget, addLabels, removeLabel }));

const gatherMergeSafetyFacts = vi.fn();
vi.mock('../src/merge-safety-facts.js', () => ({
  gatherMergeSafetyFacts,
  makeGitRunner: vi.fn(() => ({})),
}));

const { runEvaluate, runInvalidate, makeBaseChecksProbe, makeRequiredChecksProbe } =
  await import('../src/bin/merge-safety.js');
const { MERGE_SAFETY_CHECK_NAME } = await import('../src/index.js');

const REPO = 'o/r';

const evalArgs = (over: Partial<Args> = {}): Args => ({
  mode: 'evaluate',
  baseRef: 'origin/main',
  workflow: 'merge-safety.yml',
  json: false,
  ...over,
});
const invalidateArgs = (over: Partial<Args> = {}): Args => ({
  mode: 'invalidate',
  baseRef: 'origin/main',
  workflow: 'merge-safety.yml',
  json: false,
  ...over,
});

const prView = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 5,
    headRefOid: 'headsha',
    title: 'feat: a change',
    labels: [],
    mergeable: 'MERGEABLE',
    state: 'OPEN',
    ...over,
  });

const facts = (over: Partial<MergeSafetyFacts> = {}): MergeSafetyFacts => ({
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
  ...over,
});

/** The stdin payload of the check-runs POST, or null if no check-run was posted. */
function postedCheck(): Record<string, unknown> | null {
  const call = ghCall.mock.calls.find(([primary]) =>
    (primary.argv as string[]).some((a) => a.includes('/check-runs')),
  );
  return call
    ? (JSON.parse((call[0] as { stdin: string }).stdin) as Record<string, unknown>)
    : null;
}

beforeEach(() => {
  ghCall.mockReset();
  resolveRepoTarget.mockReset();
  addLabels.mockReset();
  removeLabel.mockReset();
  gatherMergeSafetyFacts.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('runEvaluate', () => {
  it('throws (fail-safe) when the PR cannot be read and not in --json mode', async () => {
    ghCall.mockResolvedValue(null); // pr view unreadable
    await expect(runEvaluate(REPO, 5, evalArgs())).rejects.toThrow(/could not read PR #5/);
    expect(postedCheck()).toBeNull();
  });

  it('emits the fail-safe decision as JSON with exit 1 when the PR is unreadable in --json mode', async () => {
    ghCall.mockResolvedValue(null);
    const log = vi.spyOn(console, 'log');
    await runEvaluate(REPO, 5, evalArgs({ json: true }));
    expect(log.mock.calls[0]?.[0]).toContain('Could not evaluate');
    expect(process.exitCode).toBe(1);
    expect(gatherMergeSafetyFacts).not.toHaveBeenCalled();
  });

  it('skips a closed/merged PR entirely — no check-run, no facts, no labels', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) =>
      primary.argv.includes('view') ? prView({ state: 'MERGED' }) : '',
    );
    await runEvaluate(REPO, 5, evalArgs());
    expect(gatherMergeSafetyFacts).not.toHaveBeenCalled();
    expect(postedCheck()).toBeNull();
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('--json prints the verdict and performs no side effects', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) =>
      primary.argv.includes('view') ? prView() : '',
    );
    gatherMergeSafetyFacts.mockResolvedValue(facts());
    const log = vi.spyOn(console, 'log');
    await runEvaluate(REPO, 5, evalArgs({ json: true }));
    expect(log.mock.calls[0]?.[0]).toContain('No update required');
    expect(postedCheck()).toBeNull();
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('posts a failure check-run and sets exit 1 when facts cannot be gathered', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) =>
      primary.argv.includes('view') ? prView() : '',
    );
    gatherMergeSafetyFacts.mockRejectedValue(new Error('bad merge-base'));
    await runEvaluate(REPO, 5, evalArgs());
    const check = postedCheck();
    expect(check?.name).toBe(MERGE_SAFETY_CHECK_NAME);
    expect(check?.conclusion).toBe('failure');
    expect(process.exitCode).toBe(1);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('posts the verdict check-run and reconciles labels on a needs-update PR', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) =>
      primary.argv.includes('view') ? prView() : '',
    );
    gatherMergeSafetyFacts.mockResolvedValue(
      facts({ isCurrent: false, fileOverlap: true, overlappingFiles: ['src/a.ts'] }),
    );
    await runEvaluate(REPO, 5, evalArgs());
    const check = postedCheck();
    expect(check?.name).toBe(MERGE_SAFETY_CHECK_NAME);
    expect(check?.conclusion).toBe('failure');
    // needsUpdate → add 'update required', remove the disjoint 'merge conflict'.
    expect(addLabels).toHaveBeenCalledWith(REPO, 5, ['update required'], expect.anything());
    expect(removeLabel).toHaveBeenCalledWith(REPO, 5, 'merge conflict', expect.anything());
  });

  it('posts a success check-run and clears both labels on a clean PR', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) =>
      primary.argv.includes('view') ? prView() : '',
    );
    gatherMergeSafetyFacts.mockResolvedValue(facts());
    await runEvaluate(REPO, 5, evalArgs());
    expect(postedCheck()?.conclusion).toBe('success');
    // add is empty → addLabels skipped; both labels are removed.
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).toHaveBeenCalledWith(REPO, 5, 'update required', expect.anything());
    expect(removeLabel).toHaveBeenCalledWith(REPO, 5, 'merge conflict', expect.anything());
  });
});

describe('runInvalidate', () => {
  it('throws when the open-PR list cannot be read', async () => {
    ghCall.mockResolvedValue(null);
    await expect(runInvalidate(REPO, invalidateArgs())).rejects.toThrow(/could not list open PRs/);
  });

  it('skips the excluded PR and, for each other, flips to pending then dispatches the caller workflow', async () => {
    ghCall.mockImplementation(async (primary: { argv: string[] }) => {
      if (primary.argv.includes('list')) {
        return JSON.stringify([
          { number: 1, headRefOid: 'sha1' },
          { number: 2, headRefOid: 'sha2' },
        ]);
      }
      return '';
    });
    await runInvalidate(REPO, invalidateArgs({ exclude: 1, workflow: 'custom-caller.yml' }));

    const checkPosts = ghCall.mock.calls.filter(([p]) =>
      (p.argv as string[]).some((a) => a.includes('/check-runs')),
    );
    const dispatches = ghCall.mock.calls.filter(([p]) => (p.argv as string[]).includes('workflow'));

    // The excluded PR #1 (sha1) is never touched.
    expect(checkPosts).toHaveLength(1);
    expect(JSON.parse((checkPosts[0]![0] as { stdin: string }).stdin).head_sha).toBe('sha2');
    // Pending check: no conclusion → in_progress status.
    expect(JSON.parse((checkPosts[0]![0] as { stdin: string }).stdin).status).toBe('in_progress');
    // Dispatch targets the caller workflow filename for PR #2 only.
    expect(dispatches).toHaveLength(1);
    const dispatchArgv = dispatches[0]![0].argv as string[];
    expect(dispatchArgv).toContain('custom-caller.yml');
    expect(dispatchArgv).toContain('pr=2');
    expect(dispatchArgv).not.toContain('pr=1');
  });
});

describe('makeBaseChecksProbe', () => {
  it('queries the base tip check-runs (deduped to latest) and parses the JSONL', async () => {
    ghCall.mockResolvedValue(
      '{"name":"typecheck","conclusion":"failure","appSlug":"github-actions"}\n' +
        '{"name":"Vercel","conclusion":"success","appSlug":"vercel"}\n',
    );
    const checks = await makeBaseChecksProbe(REPO, '/wd')('BASESHA');

    // The endpoint targets the base tip and requests the latest run per name.
    const argv = ghCall.mock.calls[0]![0].argv as string[];
    expect(argv.join(' ')).toContain('repos/o/r/commits/BASESHA/check-runs?filter=latest');
    expect(checks).toEqual([
      { name: 'typecheck', conclusion: 'failure', appSlug: 'github-actions' },
      { name: 'Vercel', conclusion: 'success', appSlug: 'vercel' },
    ]);
  });

  it('soft-fails to an empty list when the read fails', async () => {
    ghCall.mockResolvedValue(null);
    expect(await makeBaseChecksProbe(REPO)('BASESHA')).toEqual([]);
  });

  it('skips a malformed JSONL line rather than throwing', async () => {
    ghCall.mockResolvedValue(
      'not json\n{"name":"test","conclusion":"success","appSlug":"github-actions"}\n',
    );
    expect(await makeBaseChecksProbe(REPO)('BASESHA')).toEqual([
      { name: 'test', conclusion: 'success', appSlug: 'github-actions' },
    ]);
  });
});

describe('makeRequiredChecksProbe', () => {
  it('queries the branch rules and returns the deduped required contexts', async () => {
    ghCall.mockResolvedValue('typecheck\ntest\ntypecheck\nBuild\n');
    const required = await makeRequiredChecksProbe(REPO, '/wd')('main');

    const argv = ghCall.mock.calls[0]![0].argv as string[];
    expect(argv.join(' ')).toContain('repos/o/r/rules/branches/main');
    expect(argv.join(' ')).toContain('required_status_checks');
    expect(required).toEqual(['typecheck', 'test', 'Build']);
  });

  it('URL-encodes a branch name with a slash', async () => {
    ghCall.mockResolvedValue('');
    await makeRequiredChecksProbe(REPO)('release/1.x');
    const argv = ghCall.mock.calls[0]![0].argv as string[];
    expect(argv.join(' ')).toContain('repos/o/r/rules/branches/release%2F1.x');
  });

  it('returns an empty set when the branch requires no status checks', async () => {
    ghCall.mockResolvedValue('');
    expect(await makeRequiredChecksProbe(REPO)('main')).toEqual([]);
  });

  it('soft-fails to null (nothing gates) when the read fails', async () => {
    ghCall.mockResolvedValue(null);
    expect(await makeRequiredChecksProbe(REPO)('main')).toBeNull();
  });
});
