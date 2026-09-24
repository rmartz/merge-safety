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
const posts = () => calls().filter((c) => c.argv.includes('POST'));

/** Answer the open-run lookup with `lookup`; every write succeeds unless `failPatch`. */
function respond(lookup: string | null, failPatch: readonly number[] = []): void {
  ghCall.mockImplementation(async (primary: Call) => {
    if (primary.argv.some((a) => a.includes('check_name='))) return lookup;
    const patched = primary.argv.find((a) => /\/check-runs\/\d+$/.test(a));
    if (patched && failPatch.some((id) => patched.endsWith(`/${id}`))) return null;
    return '{}';
  });
}

beforeEach(() => {
  ghCall.mockReset();
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
    await postCheck(REPO, 'headsha', { title: 'Re-evaluating', summary: '…' }, null);
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
