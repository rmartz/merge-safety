import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Github from '../src/lib/github.js';

// The cancel request is a `gh` call — mock the transport so the tests are hermetic.
const ghCall = vi.fn();
vi.mock('../src/lib/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Github>()),
  ghCall,
}));

const { requestRunCancel, abandonRunAsCancelled, EXIT_TRANSIENT } =
  await import('../src/lib/cancel-run.js');
const { GhTransientError } = await import('../src/lib/github.js');

const ACTIONS_ENV = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42' };
const transient = new GhTransientError('GraphQL: API rate limit exceeded');

beforeEach(() => {
  ghCall.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('requestRunCancel', () => {
  it('POSTs the cancel for the current run', async () => {
    ghCall.mockResolvedValue('{}');
    expect(await requestRunCancel({ env: ACTIONS_ENV })).toBe(true);
    const [primary] = ghCall.mock.calls[0] as [{ argv: string[] }];
    expect(primary.argv).toEqual(['gh', 'api', '-X', 'POST', 'repos/o/r/actions/runs/42/cancel']);
  });

  it('does nothing outside GitHub Actions', async () => {
    expect(await requestRunCancel({ env: {} })).toBe(false);
    expect(ghCall).not.toHaveBeenCalled();
  });

  it('reports false when the cancel request fails', async () => {
    ghCall.mockResolvedValue(null);
    expect(await requestRunCancel({ env: ACTIONS_ENV })).toBe(false);
  });
});

describe('abandonRunAsCancelled', () => {
  it('requests the cancel and waits for the runner to stop the process', async () => {
    ghCall.mockResolvedValue('{}');
    const wait = vi.fn(async () => {});
    await abandonRunAsCancelled(transient, { env: ACTIONS_ENV, wait });
    expect(wait).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('merge-safety cancelled'));
    // The backstop if the runner never stops the process.
    expect(process.exitCode).toBe(EXIT_TRANSIENT);
  });

  it('exits non-zero without waiting when the cancel cannot be requested', async () => {
    const wait = vi.fn(async () => {});
    await abandonRunAsCancelled(transient, { env: {}, wait });
    expect(wait).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_TRANSIENT);
  });
});
