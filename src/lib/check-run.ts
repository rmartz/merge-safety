/**
 * Posting the `merge-safety` check-run on a head SHA — create-or-update (#61).
 *
 * `invalidate` marks a PR pending with an `in_progress` run, and the dispatched
 * `evaluate` then posts the verdict. Creating a fresh run for the verdict left the
 * pending one `in_progress` forever — harmless to the gate (GitHub resolves the
 * required check from the newest run) but an orphan spinning on the PR's checks
 * list, one more per open PR per base move. So every post first completes the
 * head's still-open `merge-safety` runs **in place**, and only creates a run when
 * there is none to update.
 *
 * Every post also sets a **commit status** of the same `merge-safety` context (#73),
 * and that status is what the merge gate can rely on. A check-run created with
 * `GITHUB_TOKEN` gets no suite of its own: GitHub files it into the head SHA's
 * oldest `github-actions` check suite, typically some other `pull_request_target`
 * workflow. Once a newer run of that workflow lands on the same SHA, GitHub treats
 * the older suite as superseded and the merge gate ignores every check-run in it,
 * while the checks list still shows it green. The PR sits `BLOCKED` on a "passing"
 * check. A commit status belongs to no suite, so nothing can supersede it. The
 * check-run is kept, with the identical verdict, for tooling that reads it by name.
 */
import { MERGE_SAFETY_CHECK_NAME } from '../index.js';
import { ghCall } from './github.js';

export interface CheckOutput {
  title: string;
  summary: string;
}

/**
 * `pending` posts an incomplete (`in_progress`) run with no conclusion — it blocks
 * auto-merge like `failure` without rendering red. Both invalidate's "Re-evaluating"
 * mark and the stale-only `Update required` verdict (#58) use it.
 */
export type CheckConclusion = 'success' | 'failure' | 'pending';

/**
 * The ids of the head SHA's `merge-safety` runs that are not yet completed, or
 * `null` when they cannot be read. `check_name` is an exact match, so workflow-job
 * runs (`merge-safety / Evaluate one PR`) never qualify; `filter=all` (not
 * `latest`) so orphans left by earlier versions are swept up too.
 */
async function openCheckRunIds(
  repo: string,
  headSha: string,
  cwd?: string,
): Promise<number[] | null> {
  const out = await ghCall(
    {
      argv: [
        'gh',
        'api',
        '--paginate',
        `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(MERGE_SAFETY_CHECK_NAME)}&filter=all`,
        '--jq',
        '.check_runs[] | select(.status != "completed") | .id',
      ],
    },
    null,
    { cwd },
  );
  if (out === null) return null;
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** GitHub rejects a commit-status description longer than this. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Set the `merge-safety` commit status on `headSha` to mirror the verdict (#73).
 * `pending` maps to the status `pending` state, which blocks the merge exactly like
 * the incomplete check-run, and the title (`Re-evaluating` / `Update required`)
 * rides in the description. When the Actions run URL is known, it becomes the
 * status's details link. A failure is only warned about: the caller may not grant
 * `statuses: write` yet, and the check-run is still posted either way.
 */
async function postStatus(
  repo: string,
  headSha: string,
  output: CheckOutput,
  conclusion: CheckConclusion,
  cwd?: string,
): Promise<void> {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : undefined;
  const out = await ghCall(
    {
      argv: ['gh', 'api', '-X', 'POST', `repos/${repo}/statuses/${headSha}`, '--input', '-'],
      stdin: JSON.stringify({
        state: conclusion,
        context: MERGE_SAFETY_CHECK_NAME,
        description: output.title.slice(0, STATUS_DESCRIPTION_MAX),
        ...(runUrl ? { target_url: runUrl } : {}),
      }),
    },
    null,
    { cwd },
  );
  if (out === null) {
    console.warn(
      `::warning::could not set the ${MERGE_SAFETY_CHECK_NAME} commit status on ${headSha} ` +
        '— does the caller workflow grant `statuses: write`? (rmartz/merge-safety#73)',
    );
  }
}

/**
 * Post the `merge-safety` verdict (or a pending mark) on `headSha`: update every
 * still-open `merge-safety` run on it in place, or create one when none updates.
 * A failed lookup falls back to creating — the pre-#61 behavior — so an unreadable
 * checks list never costs the PR its verdict. The same verdict is then mirrored to
 * the `merge-safety` commit status (#73).
 */
export async function postCheck(
  repo: string,
  headSha: string,
  output: CheckOutput,
  conclusion: CheckConclusion,
  cwd?: string,
): Promise<void> {
  await postCheckRun(repo, headSha, output, conclusion, cwd);
  await postStatus(repo, headSha, output, conclusion, cwd);
}

async function postCheckRun(
  repo: string,
  headSha: string,
  output: CheckOutput,
  conclusion: CheckConclusion,
  cwd?: string,
): Promise<void> {
  const state =
    conclusion === 'pending'
      ? { status: 'in_progress', output }
      : { status: 'completed', conclusion, completed_at: new Date().toISOString(), output };
  let updated = false;
  for (const id of (await openCheckRunIds(repo, headSha, cwd)) ?? []) {
    const out = await ghCall(
      {
        argv: ['gh', 'api', '-X', 'PATCH', `repos/${repo}/check-runs/${id}`, '--input', '-'],
        stdin: JSON.stringify(state),
      },
      null,
      { cwd },
    );
    if (out !== null) updated = true;
  }
  if (updated) return;
  await ghCall(
    {
      argv: ['gh', 'api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'],
      stdin: JSON.stringify({
        // The fleet-contract check-run name (src/index.ts). Never a local literal —
        // every consumer's required status check matches exactly this name.
        name: MERGE_SAFETY_CHECK_NAME,
        head_sha: headSha,
        ...state,
      }),
    },
    null,
    { cwd },
  );
}
