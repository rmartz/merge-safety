#!/usr/bin/env node
// Thin CLI over the merge-safety predicate. Two modes:
//   evaluate  — gather facts for one PR, post its `merge-safety` check-run, and
//               reconcile the `update required` / `merge conflict` labels.
//   invalidate — (push-to-base fan-out) flip every OTHER open PR's check to
//               pending and dispatch its own evaluate run, so a moved base holds
//               auto-merge until each PR re-clears against the new base.
// All judgment lives in the library; this only parses args and talks to `gh`.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghCall, resolveRepoTarget, addLabels, removeLabel } from '../lib/github.js';
import {
  MERGE_SAFETY_CHECK_NAME,
  isMergeSafetyCommand,
  type MergeSafetyCommand,
} from '../index.js';
import {
  evaluateMergeSafety,
  errorMergeSafetyDecision,
  isEvaluablePrState,
  type BaseCheckRun,
  type MergeSafetyDecision,
} from '../merge-safety.js';
import {
  gatherMergeSafetyFacts,
  makeGitRunner,
  type BaseChecksProbe,
  type PrMergeMeta,
  type RequiredChecksProbe,
} from '../merge-safety-facts.js';

/** The conventional consumer caller filename the invalidate fan-out re-dispatches. */
const DEFAULT_CALLER_WORKFLOW = 'merge-safety.yml';

export interface Args {
  mode: MergeSafetyCommand;
  pr?: number;
  exclude?: number;
  repo?: string;
  baseRef: string;
  /**
   * The consumer's caller workflow filename that `invalidate` re-dispatches per PR
   * (issue #247's dispatch-target wrinkle: a reusable workflow's fan-out targets
   * the *caller* file, not this reusable file). Defaults to the conventional name.
   */
  workflow: string;
  cwd?: string;
  /** Decision-only: print the verdict as JSON and perform no side effects. */
  json: boolean;
}

function usage(): never {
  console.error(
    'usage: ai-merge-safety evaluate --pr <n> [--json] [--repo <o/r>] [--base <ref>] [--cwd <path>]\n' +
      '       ai-merge-safety invalidate [--workflow <file>] [--exclude <n>] [--repo <o/r>] [--cwd <path>]',
  );
  process.exit(2);
}

function parse(argv: string[]): Args {
  const mode = argv[0];
  if (!isMergeSafetyCommand(mode)) usage();
  const args: Args = {
    mode,
    baseRef: 'origin/main',
    workflow: DEFAULT_CALLER_WORKFLOW,
    json: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.pr = Number(argv[++i]);
    else if (a === '--exclude') args.exclude = Number(argv[++i]);
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--base') args.baseRef = argv[++i] ?? args.baseRef;
    else if (a === '--workflow') args.workflow = argv[++i] ?? args.workflow;
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--json' || a === '--dry-run') args.json = true;
    else usage();
  }
  if (mode === 'evaluate' && !args.pr) usage();
  // `--json`/`--dry-run` is evaluate-only: `invalidate` has no verdict to print,
  // and silently accepting the flag there would run the full side-effecting
  // fan-out under a "dry run" the caller expected to be a no-op.
  if (args.json && mode !== 'evaluate') usage();
  return args;
}

async function ghJson<T>(argv: string[], cwd?: string): Promise<T | null> {
  const out = await ghCall({ argv }, null, { cwd });
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

/**
 * A real base-checks probe: fetch the base tip's check-runs from the GitHub Checks
 * API (deduped to the latest run per name via `?filter=latest`) and reduce each to
 * the {@link BaseCheckRun} shape base-health classifies. `--jq` streams the array
 * as JSONL so `--paginate` can concatenate pages for a base with many checks.
 * Soft-fails to `[]` on any read error, so a transient `gh` failure never becomes
 * a base-health false positive that wedges the merge queue.
 */
export function makeBaseChecksProbe(repo: string, cwd?: string): BaseChecksProbe {
  return async (baseSha) => {
    const out = await ghCall(
      {
        argv: [
          'gh',
          'api',
          '--paginate',
          `repos/${repo}/commits/${baseSha}/check-runs?filter=latest`,
          '--jq',
          '.check_runs[] | {name: .name, conclusion: .conclusion, appSlug: .app.slug}',
        ],
      },
      null,
      { cwd },
    );
    if (!out) return [];
    const checks: BaseCheckRun[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const c = JSON.parse(trimmed) as BaseCheckRun;
        checks.push({ name: c.name, conclusion: c.conclusion, appSlug: c.appSlug });
      } catch {
        // Skip a malformed line rather than fail the whole probe.
      }
    }
    return checks;
  };
}

/**
 * A real required-checks probe: fetch the base branch's **required status check**
 * contexts from the repository rulesets that apply to it (`/rules/branches/{branch}`,
 * the endpoint that surfaces ruleset-declared rules the way this fleet configures
 * them). `--jq` streams each `required_status_checks` rule's contexts as lines,
 * deduped here. Soft-fails to `null` on any read error (no ruleset, missing scope,
 * transient `gh` failure) so base-health degrades to "nothing gates" rather than
 * wedging the queue on an unreadable protection config (#40).
 */
export function makeRequiredChecksProbe(repo: string, cwd?: string): RequiredChecksProbe {
  return async (baseBranch) => {
    const out = await ghCall(
      {
        argv: [
          'gh',
          'api',
          '--paginate',
          `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
          '--jq',
          '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
        ],
      },
      null,
      { cwd },
    );
    if (out === null) return null;
    const contexts = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return [...new Set(contexts)];
  };
}

/** Post (create) a check-run on a head SHA. `conclusion` omitted → pending. */
async function postCheck(
  repo: string,
  headSha: string,
  output: { title: string; summary: string },
  conclusion: 'success' | 'failure' | null,
  cwd?: string,
): Promise<void> {
  const payload = {
    // The fleet-contract check-run name (src/index.ts). Never a local literal —
    // every consumer's required status check matches exactly this name.
    name: MERGE_SAFETY_CHECK_NAME,
    head_sha: headSha,
    status: conclusion ? 'completed' : 'in_progress',
    ...(conclusion ? { conclusion, completed_at: new Date().toISOString() } : {}),
    output,
  };
  await ghCall(
    {
      argv: ['gh', 'api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'],
      stdin: JSON.stringify(payload),
    },
    null,
    { cwd },
  );
}

interface PrView {
  number: number;
  headRefOid: string;
  title: string;
  labels: { name: string }[];
  mergeable: string;
  state: string;
}

/** Re-read a PR until `mergeable` settles off UNKNOWN (GitHub computes it lazily). */
async function fetchPrView(repo: string, pr: number, cwd?: string): Promise<PrView | null> {
  const fields = 'number,headRefOid,title,labels,mergeable,state';
  for (let attempt = 0; attempt < 3; attempt++) {
    const view = await ghJson<PrView>(
      ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', fields],
      cwd,
    );
    if (!view) return null;
    if (view.mergeable !== 'UNKNOWN' || attempt === 2) return view;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function reconcileLabels(
  repo: string,
  pr: number,
  add: readonly string[],
  remove: readonly string[],
  cwd?: string,
): Promise<void> {
  if (add.length) await addLabels(repo, pr, [...add], { cwd });
  for (const label of remove) await removeLabel(repo, pr, label, { cwd });
}

export async function runEvaluate(repo: string, pr: number, args: Args): Promise<void> {
  const view = await fetchPrView(repo, pr, args.cwd);
  if (!view) {
    // A PR we can't even read is ungatherable — same fail-safe verdict.
    const msg = `could not read PR #${pr}`;
    if (args.json) return emitDecisionJson(errorMergeSafetyDecision(msg), true);
    throw new Error(msg);
  }
  // A closed or merged PR can no longer merge, so it earns no verdict: skip the
  // check-run and label reconciliation entirely. This guards against a label
  // event firing evaluate on an already-settled PR (e.g. a verdict label applied
  // moments after merge) and re-stamping it with a merge-safety label.
  if (!isEvaluablePrState(view.state)) {
    console.log(`#${pr}: ${view.state.toLowerCase()} — skipping merge-safety evaluate`);
    return;
  }
  const meta: PrMergeMeta = {
    headSha: view.headRefOid,
    title: view.title,
    labels: view.labels.map((l) => l.name),
    mergeable: view.mergeable,
  };

  let decision: MergeSafetyDecision;
  try {
    const facts = await gatherMergeSafetyFacts(meta, {
      baseRef: args.baseRef,
      git: makeGitRunner(args.cwd),
      baseChecks: makeBaseChecksProbe(repo, args.cwd),
      requiredChecks: makeRequiredChecksProbe(repo, args.cwd),
    });
    decision = evaluateMergeSafety(facts);
  } catch (err) {
    // Ungatherable → fail safe: never report a stale-safe verdict.
    const msg = err instanceof Error ? err.message : String(err);
    const failed = errorMergeSafetyDecision(msg);
    if (args.json) return emitDecisionJson(failed, true);
    await postCheck(
      repo,
      meta.headSha,
      { title: failed.title, summary: failed.summary },
      'failure',
      args.cwd,
    );
    console.error(`#${pr}: failure — could not evaluate: ${msg}`);
    process.exitCode = 1;
    return;
  }

  // Decision-only mode: print the verdict, touch nothing. Exit 0 — a real verdict
  // (even `failure`/`needsUpdate`) is a successful evaluation; non-zero is reserved
  // for the ungatherable error above, so a caller can tell "must update" from "broke".
  if (args.json) return emitDecisionJson(decision, false);

  const detail = decision.reasons.length
    ? decision.reasons.map((r) => `- ${r}`).join('\n')
    : decision.summary;
  await postCheck(
    repo,
    meta.headSha,
    { title: decision.title, summary: `${decision.summary}\n\n${detail}` },
    decision.conclusion,
    args.cwd,
  );
  // `addOnly` (currently just `breaking change`) joins the add list but never the
  // remove list — the check may assert a breaking change the diff proves, but must
  // never retract one a human asserted (#53).
  await reconcileLabels(
    repo,
    pr,
    [...decision.labels.add, ...decision.labels.addOnly],
    decision.labels.remove,
    args.cwd,
  );
  console.log(`#${pr}: ${decision.conclusion} — ${decision.summary}`);
}

/** Print a decision as JSON. `isError` marks the ungatherable case with exit 1. */
function emitDecisionJson(decision: MergeSafetyDecision, isError: boolean): void {
  console.log(JSON.stringify(decision, null, 2));
  if (isError) process.exitCode = 1;
}

export async function runInvalidate(repo: string, args: Args): Promise<void> {
  const prs = await ghJson<{ number: number; headRefOid: string }[]>(
    [
      'gh',
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--base',
      'main',
      '--limit',
      '1000',
      '--json',
      'number,headRefOid',
    ],
    args.cwd,
  );
  if (!prs) throw new Error('could not list open PRs');
  for (const pr of prs) {
    if (pr.number === args.exclude) continue;
    // 1) Flip to pending immediately — a pending required check blocks auto-merge.
    await postCheck(
      repo,
      pr.headRefOid,
      { title: 'Re-evaluating', summary: 'Re-evaluating against the updated base…' },
      null,
      args.cwd,
    );
    // 2) Dispatch this PR's own evaluate run via the consumer's caller workflow; it
    //    resolves the check against the new base. A reusable workflow's fan-out must
    //    target the caller file, not this reusable file — hence the `--workflow` flag.
    await ghCall(
      {
        argv: ['gh', 'workflow', 'run', args.workflow, '--repo', repo, '-f', `pr=${pr.number}`],
      },
      null,
      { cwd: args.cwd },
    );
    console.log(`#${pr.number}: invalidated (pending) + evaluate dispatched`);
  }
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const repo = await resolveRepoTarget({ repo: args.repo, cwd: args.cwd });
  if (!repo) {
    console.error('error: could not resolve target repo (pass --repo <owner/repo>)');
    process.exit(2);
  }
  if (args.mode === 'evaluate') await runEvaluate(repo, args.pr as number, args);
  else await runInvalidate(repo, args);
}

// Run only when invoked directly as the CLI entry. realpathSync resolves the npm
// bin symlink (node_modules/.bin/ai-merge-safety → dist/bin/merge-safety.js) so the
// comparison holds for the installed CLI, while an import (tests) does not match.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) void main();
