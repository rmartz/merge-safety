/**
 * Ending a run as **cancelled** when an external transient error stopped it.
 *
 * An exhausted GraphQL quota, a GitHub 5xx, or a network blip says nothing about
 * the PR, so it should not read as a merge-safety failure. A process cannot set
 * its own job conclusion from an exit code (any non-zero exit is `failure`), so
 * inside GitHub Actions the run asks the API to cancel itself and then waits for
 * the runner to stop it. Cancelling posts no verdict, so the PR keeps whatever
 * `merge-safety` state it already had — the pending mark `invalidate` left, or the
 * earlier verdict for this head — and the next event re-evaluates it.
 *
 * If the cancel cannot be requested (outside Actions, a token without
 * `actions: write`, or the REST pool exhausted too), the process exits with
 * {@link EXIT_TRANSIENT}, which still fails the step.
 */
import { ghCall, type GhTransientError } from './github.js';

/** Exit code for a run stopped by a transient external error (sysexits `EX_TEMPFAIL`). */
export const EXIT_TRANSIENT = 75;

/**
 * How long to wait for the runner to stop the process once the cancel is
 * accepted. The runner signals the step within seconds; this is a backstop well
 * inside the jobs' 5-minute timeout.
 */
const CANCEL_GRACE_MS = 120_000;

export interface CancelOptions {
  cwd?: string;
  /** Environment holding the `GITHUB_*` run context (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Injectable wait so tests need not sit out the grace period. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Ask the Actions API to cancel the run this process is part of. Returns `true`
 * when the request was accepted, `false` outside Actions or when it failed.
 */
export async function requestRunCancel(opts: CancelOptions = {}): Promise<boolean> {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_RUN_ID } = opts.env ?? process.env;
  if (GITHUB_ACTIONS !== 'true' || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return false;
  const out = await ghCall(
    {
      argv: [
        'gh',
        'api',
        '-X',
        'POST',
        `repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/cancel`,
      ],
    },
    null,
    { cwd: opts.cwd },
  );
  return out !== null;
}

/**
 * Report a transient failure and end the run as cancelled: request the cancel and
 * wait to be stopped. Sets {@link EXIT_TRANSIENT} for the case the cancel is not
 * accepted, or the runner never stops the process.
 */
export async function abandonRunAsCancelled(
  err: GhTransientError,
  opts: CancelOptions = {},
): Promise<void> {
  console.warn(
    `::warning title=merge-safety cancelled::${err.message} — cancelling this run; ` +
      'the next event re-evaluates.',
  );
  process.exitCode = EXIT_TRANSIENT;
  if (!(await requestRunCancel(opts))) {
    console.error('could not request cancellation of this run; exiting as failed');
    return;
  }
  const wait = opts.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await wait(CANCEL_GRACE_MS);
}
