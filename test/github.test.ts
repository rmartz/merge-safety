import { describe, it, expect, vi, beforeEach } from 'vitest';

// `gh`/`git` are real-world boundaries — mock the inlined boundedRun so every
// test is hermetic (no subprocess, no network).
const boundedRun = vi.fn();
vi.mock('../src/lib/bounded-subprocess.js', () => ({ boundedRun }));

const result = (over: Partial<{ stdout: string; stderr: string; code: number }> = {}) => ({
  stdout: '',
  stderr: '',
  code: 0,
  timedOut: false,
  ...over,
});

const { ghCall, resolveRepoTarget, addLabels, removeLabel } = await import('../src/lib/github.js');

const noSleep = vi.fn(async () => {});

describe('ghCall', () => {
  beforeEach(() => {
    boundedRun.mockReset();
    noSleep.mockClear();
  });

  it('returns primary stdout on success without touching the fallback', async () => {
    boundedRun.mockResolvedValueOnce(result({ stdout: 'ok' }));
    const out = await ghCall({ argv: ['gh', 'api', 'x'] }, { argv: ['gh', 'issue', 'list'] });
    expect(out).toBe('ok');
    expect(boundedRun).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    boundedRun
      .mockResolvedValueOnce(result({ stderr: 'boom', code: 1 }))
      .mockResolvedValueOnce(result({ stdout: 'recovered' }));
    const out = await ghCall({ argv: ['gh', 'api', 'x'] }, null, { sleep: noSleep });
    expect(out).toBe('recovered');
    expect(noSleep).toHaveBeenCalledOnce();
  });

  it('skips retries and switches to the fallback on a rate-limit error', async () => {
    boundedRun
      .mockResolvedValueOnce(result({ stderr: 'API rate limit exceeded', code: 1 }))
      .mockResolvedValueOnce(result({ stdout: 'via-graphql' }));
    const out = await ghCall(
      { argv: ['gh', 'api', 'x'] },
      { argv: ['gh', 'issue', 'list'] },
      {
        sleep: noSleep,
      },
    );
    expect(out).toBe('via-graphql');
    // First transport rate-limited (no retry sleeps), straight to fallback.
    expect(noSleep).not.toHaveBeenCalled();
    expect(boundedRun).toHaveBeenCalledTimes(2);
  });

  it('soft-fails to null when both transports are exhausted', async () => {
    boundedRun.mockResolvedValue(result({ stderr: 'nope', code: 1 }));
    const out = await ghCall(
      { argv: ['gh', 'api', 'x'] },
      { argv: ['gh', 'issue', 'list'] },
      {
        sleep: noSleep,
      },
    );
    expect(out).toBeNull();
  });

  it('treats a boundedRun rejection as a failed attempt', async () => {
    boundedRun.mockRejectedValue(new Error('spawn ENOENT'));
    const out = await ghCall({ argv: ['gh', 'api', 'x'] }, null, { sleep: noSleep });
    expect(out).toBeNull();
  });
});

describe('resolveRepoTarget', () => {
  beforeEach(() => boundedRun.mockReset());

  it('prefers an explicit --repo over everything, shelling to nothing', async () => {
    const repo = await resolveRepoTarget({ repo: 'o/explicit', env: { GH_REPO: 'o/env' } });
    expect(repo).toBe('o/explicit');
    expect(boundedRun).not.toHaveBeenCalled();
  });

  it('falls back to GH_REPO before shelling to gh repo view', async () => {
    const repo = await resolveRepoTarget({ env: { GH_REPO: 'o/env' } });
    expect(repo).toBe('o/env');
    expect(boundedRun).not.toHaveBeenCalled();
  });

  it('resolves the cwd repo via gh repo view when no override is given', async () => {
    boundedRun.mockResolvedValueOnce(result({ stdout: 'o/cwd\n' }));
    const repo = await resolveRepoTarget({ env: {} });
    expect(repo).toBe('o/cwd');
  });

  it('falls back to the git remote slug when gh repo view yields nothing', async () => {
    boundedRun
      .mockResolvedValueOnce(result({ stdout: '' })) // gh repo view: empty
      .mockResolvedValueOnce(result({ stdout: 'git@github.com:o/from-remote.git\n' }));
    const repo = await resolveRepoTarget({ env: {} });
    expect(repo).toBe('o/from-remote');
  });
});

describe('addLabels', () => {
  beforeEach(() => boundedRun.mockReset());

  it('POSTs the labels array to the REST endpoint and returns trimmed stdout', async () => {
    boundedRun.mockResolvedValueOnce(result({ stdout: 'done\n' }));
    const out = await addLabels('o/r', 5, ['update required', 'merge conflict']);
    expect(out).toBe('done');
    const [, args, opts] = boundedRun.mock.calls[0] as [string, string[], { input?: string }];
    expect(args).toContain('repos/o/r/issues/5/labels');
    expect(opts.input).toContain('"labels":["update required","merge conflict"]');
  });

  it('is a no-op (null, no subprocess) for an empty label list or unparseable issue', async () => {
    expect(await addLabels('o/r', 5, [])).toBeNull();
    expect(await addLabels('o/r', 'not-a-ref', ['x'])).toBeNull();
    expect(boundedRun).not.toHaveBeenCalled();
  });
});

describe('removeLabel', () => {
  beforeEach(() => boundedRun.mockReset());

  it('URL-encodes a label name with spaces in the REST DELETE path', async () => {
    boundedRun.mockResolvedValueOnce(result({ stdout: '' }));
    await removeLabel('o/r', 5, 'update required');
    const [, args] = boundedRun.mock.calls[0] as [string, string[]];
    expect(args).toContain('repos/o/r/issues/5/labels/update%20required');
  });

  it('is a no-op (null) for an unparseable issue reference', async () => {
    expect(await removeLabel('o/r', 'not-a-ref', 'x')).toBeNull();
    expect(boundedRun).not.toHaveBeenCalled();
  });
});
