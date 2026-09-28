import { describe, it, expect, vi, beforeEach } from 'vitest';

// The only boundary is the `gh` transport: mock it and assert on the argv/stdin
// postCheck hands it — the lookup (GET), in-place updates (PATCH), and create (POST).
const ghCall = vi.fn();
vi.mock('../src/lib/github.js', () => ({ ghCall }));

const { postCheck } = await import('../src/lib/check-run.js');
const { MERGE_SAFETY_CHECK_NAME } = await import('../src/index.js');

const REPO = 'o/r';
const OUTPUT = { title: 'Update required', summary: 'rebase' };

type Call = { argv: string[]; stdin?: string };
const calls = (): Call[] => ghCall.mock.calls.map(([primary]) => primary as Call);
const lookups = () => calls().filter((c) => c.argv.some((a) => a.includes('check_name=')));
const patches = () => calls().filter((c) => c.argv.includes('PATCH'));
const posts = () =>
  calls().filter((c) => c.argv.includes('POST') && c.argv.includes('repos/o/r/check-runs'));
const statuses = () => calls().filter((c) => c.argv.some((a) => a.includes('/statuses/')));

/**
 * Answer the open-run lookup with `lookup`; every write succeeds unless `failPatch`
 * names the run, or `failStatus` is set.
 */
function respond(
  lookup: string | null,
  failPatch: readonly number[] = [],
  failStatus = false,
): void {
  ghCall.mockImplementation(async (primary: Call) => {
    if (primary.argv.some((a) => a.includes('check_name='))) return lookup;
    if (failStatus && primary.argv.some((a) => a.includes('/statuses/'))) return null;
    const patched = primary.argv.find((a) => /\/check-runs\/\d+$/.test(a));
    if (patched && failPatch.some((id) => patched.endsWith(`/${id}`))) return null;
    return '{}';
  });
}

beforeEach(() => {
  ghCall.mockReset();
  vi.unstubAllEnvs();
});

describe('postCheck', () => {
  it('looks up only the head SHA’s still-open runs of exactly the merge-safety name', async () => {
    respond('');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    const argv = lookups()[0]!.argv;
    expect(argv.join(' ')).toContain(
      `repos/o/r/commits/headsha/check-runs?check_name=${MERGE_SAFETY_CHECK_NAME}&filter=all`,
    );
    expect(argv.join(' ')).toContain('select(.status != "completed")');
  });

  it('completes the pending run in place instead of creating a sibling (#61)', async () => {
    respond('4242\n');
    await postCheck(REPO, 'headsha', OUTPUT, 'failure');
    expect(posts()).toHaveLength(0);
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.argv).toContain('repos/o/r/check-runs/4242');
    const body = JSON.parse(patches()[0]!.stdin!) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'completed', conclusion: 'failure', output: OUTPUT });
    expect(body.completed_at).toEqual(expect.any(String));
    // An update never renames or re-targets the run.
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('head_sha');
  });

  it('sweeps every open run, including orphans left by earlier versions', async () => {
    respond('11\n12\n13\n');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(patches().map((c) => c.argv.find((a) => a.includes('/check-runs/')))).toEqual([
      'repos/o/r/check-runs/11',
      'repos/o/r/check-runs/12',
      'repos/o/r/check-runs/13',
    ]);
    expect(posts()).toHaveLength(0);
  });

  it('refreshes an open run as still pending when the new state is pending', async () => {
    respond('7\n');
    await postCheck(REPO, 'headsha', { title: 'Re-evaluating', summary: '…' }, 'pending');
    expect(posts()).toHaveLength(0);
    const body = JSON.parse(patches()[0]!.stdin!) as Record<string, unknown>;
    expect(body.status).toBe('in_progress');
    expect(body).not.toHaveProperty('conclusion');
    expect(body).not.toHaveProperty('completed_at');
  });

  it('creates a run when the head has no open merge-safety run', async () => {
    respond('');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(patches()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]!.stdin!)).toMatchObject({
      name: MERGE_SAFETY_CHECK_NAME,
      head_sha: 'headsha',
      status: 'completed',
      conclusion: 'success',
      output: OUTPUT,
    });
  });

  it('falls back to creating when the lookup cannot be read', async () => {
    respond(null);
    await postCheck(REPO, 'headsha', OUTPUT, 'failure');
    expect(patches()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  it('falls back to creating when no in-place update succeeds', async () => {
    respond('9\n', [9]);
    await postCheck(REPO, 'headsha', OUTPUT, 'failure');
    expect(patches()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it('does not create when at least one in-place update succeeds', async () => {
    respond('9\n10\n', [9]);
    await postCheck(REPO, 'headsha', OUTPUT, 'failure');
    expect(patches()).toHaveLength(2);
    expect(posts()).toHaveLength(0);
  });

  it('ignores malformed lookup lines', async () => {
    respond('not-an-id\n\n0\n5\n');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.argv).toContain('repos/o/r/check-runs/5');
  });
});

// The commit status is what the merge gate can rely on: a GITHUB_TOKEN check-run can
// be filed into a superseded suite that the gate ignores (#73).
describe('postCheck commit status', () => {
  const statusBody = () => JSON.parse(statuses()[0]!.stdin!) as Record<string, unknown>;

  it.each(['success', 'failure', 'pending'] as const)(
    'mirrors a %s verdict to the merge-safety status on the head SHA',
    async (conclusion) => {
      respond('');
      await postCheck(REPO, 'headsha', OUTPUT, conclusion);
      expect(statuses()).toHaveLength(1);
      expect(statuses()[0]!.argv).toContain('repos/o/r/statuses/headsha');
      expect(statusBody()).toMatchObject({
        state: conclusion,
        context: MERGE_SAFETY_CHECK_NAME,
        description: OUTPUT.title,
      });
    },
  );

  it('is set even when the check-run was completed in place', async () => {
    respond('4242\n');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(patches()).toHaveLength(1);
    expect(statuses()).toHaveLength(1);
  });

  it('carries the pending title so Re-evaluating and Update required stay distinct', async () => {
    respond('');
    await postCheck(REPO, 'headsha', { title: 'Re-evaluating', summary: '…' }, 'pending');
    expect(statusBody()).toMatchObject({ state: 'pending', description: 'Re-evaluating' });
  });

  it('truncates the description to GitHub’s 140-character limit', async () => {
    respond('');
    await postCheck(REPO, 'headsha', { title: 'x'.repeat(200), summary: '' }, 'failure');
    expect(statusBody().description).toHaveLength(140);
  });

  it('links the Actions run when the run context is available', async () => {
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_RUN_ID', '99');
    respond('');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(statusBody().target_url).toBe('https://github.com/o/r/actions/runs/99');
  });

  it('omits the link outside Actions', async () => {
    vi.stubEnv('GITHUB_RUN_ID', '');
    respond('');
    await postCheck(REPO, 'headsha', OUTPUT, 'success');
    expect(statusBody()).not.toHaveProperty('target_url');
  });

  it('warns, without throwing, when the status cannot be set (no statuses: write)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond('', [], true);
    await expect(postCheck(REPO, 'headsha', OUTPUT, 'success')).resolves.toBeUndefined();
    expect(posts()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('statuses: write'));
    warn.mockRestore();
  });
});
