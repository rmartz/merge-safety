/**
 * Inlined `gh` transport + label helpers — PORTED FROM `@rmartz/github@0.4.2`.
 *
 * Inlined (rather than depended on) to keep this package zero-runtime-dependency,
 * like `rmartz/repo-hygiene` (ai-tools#247, docs/migration.md). The four functions
 * the `ai-merge-safety` bin needs are copied here verbatim from that version:
 *   - `ghCall`            — REST-first + GraphQL-fallback `gh` transport with
 *                           bounded retry/backoff and rate-limit soft-fail.
 *   - `resolveRepoTarget` — explicit `--repo` → `GH_REPO` → cwd `gh repo view`.
 *   - `addLabels` / `removeLabel` — per-issue label reconciliation.
 * Their private helpers (`currentRepo`, `parseSlugFromRemoteUrl`, `issueNumber`,
 * the transport internals) come along.
 *
 * TRACEABLE DIVERGENCE, NOT A SILENT FORK: `ghCall` is non-trivial and evolves
 * upstream (transport, rate-limit, soft-fail posture). When you touch this file,
 * check `@rmartz/github` for transport/rate-limit fixes and port them across.
 * The git subprocess runs through our own inlined `boundedRun` (#7), so there is
 * no `@rmartz/agent-runtime` edge either.
 */
import { boundedRun } from './bounded-subprocess.js';

const GH_API_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;

/**
 * A single `gh` invocation: an argv plus an optional stdin body. `stdin` is set
 * when the call sends a request body (`gh api --input -` / `--body-file -`).
 */
export interface Transport {
  argv: string[];
  stdin?: string;
}

/** Injectable sleeper so tests can drive backoff without real delays. */
export type Sleeper = (ms: number) => Promise<void>;

const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GhCallOptions {
  /** Working directory for the `gh` subprocess. */
  cwd?: string;
  sleep?: Sleeper;
}

function isRateLimited(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  return t.includes('rate limit') || t.includes('rate-limit');
}

async function runTransport(
  { argv, stdin }: Transport,
  cwd: string | undefined,
): Promise<{ stdout: string | null; stderr: string }> {
  const [command, ...args] = argv;
  if (command === undefined) return { stdout: null, stderr: 'empty argv' };
  try {
    const r = await boundedRun(command, args, { timeoutMs: GH_API_TIMEOUT_MS, cwd, input: stdin });
    if (r.code === 0) return { stdout: r.stdout, stderr: '' };
    return { stdout: null, stderr: r.stderr || '' };
  } catch (err) {
    return { stdout: null, stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run `primary` (REST via `gh api`) with bounded exponential-backoff retry; on a
 * rate-limit error, fall back to `fallback` (the equivalent GraphQL `gh`
 * subcommand) immediately — REST and GraphQL draw from separate hourly pools, so
 * exhausting one degrades to the other rather than failing. Returns the winning
 * transport's stdout, or `null` on total failure (soft-fail, matching the
 * tracking/self-report callers' posture).
 */
export async function ghCall(
  primary: Transport,
  fallback: Transport | null,
  opts: GhCallOptions = {},
): Promise<string | null> {
  const sleep = opts.sleep ?? realSleep;
  for (const transport of [primary, fallback]) {
    if (!transport) continue;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { stdout, stderr } = await runTransport(transport, opts.cwd);
      if (stdout !== null) return stdout;
      // This pool is exhausted — don't burn retries on it; switch transports.
      if (isRateLimited(stderr)) break;
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS));
      }
    }
  }
  return null;
}

/** Parse an `owner/repo` slug from a GitHub remote URL (ssh, https, or `git://`), or `null`. */
function parseSlugFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  // Take the last two path segments before an optional `.git` / trailing slash,
  // after either the ssh `:` or an https/`git://` `/`. Handles
  // git@github.com:owner/repo.git, https://github.com/owner/repo(.git), ssh://….
  const match = trimmed.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match) return `${match[1]}/${match[2]}`;
  // Fall back to an already-bare `owner/repo` (a pre-resolved slug with no host or
  // protocol) so the parser is robust to being handed a slug rather than a URL.
  const bare = trimmed.match(/^([^/:\s]+)\/([^/:\s]+?)(?:\.git)?$/);
  return bare ? `${bare[1]}/${bare[2]}` : null;
}

/**
 * Resolve the current `owner/repo` (the **cwd-derived** slug). Prefers `gh repo
 * view`, then falls back to the git remote directly when that returns nothing —
 * `gh repo view` is a GraphQL call, so a throttled/unavailable GraphQL pool would
 * otherwise strand slug resolution. Both sources are the local checkout's own
 * remote, so the fallback is equivalent, minus the API dependency.
 */
async function currentRepo(opts: GhCallOptions = {}): Promise<string | null> {
  const out = await ghCall(
    { argv: ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'] },
    null,
    opts,
  );
  if (out && out.trim()) return out.trim();
  const remote = await boundedRun('git', ['remote', 'get-url', 'origin'], {
    timeoutMs: GH_API_TIMEOUT_MS,
    cwd: opts.cwd,
  });
  return remote.code === 0 ? parseSlugFromRemoteUrl(remote.stdout) : null;
}

/** Options for {@link resolveRepoTarget}: `GhCallOptions` + an explicit repo and env bag. */
export interface RepoTargetOptions extends GhCallOptions {
  /** Explicit `owner/repo` from a `--repo` flag; highest precedence. */
  repo?: string | null;
  /** Environment consulted for `GH_REPO` (defaults to `process.env`). Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the target `owner/repo` with a single uniform precedence:
 * **explicit `repo` (a `--repo` flag) → `GH_REPO` → cwd `gh repo view`**.
 *
 * `GH_REPO` is consulted *before* shelling to `gh repo view`, because
 * `gh repo view --json nameWithOwner` returns the **cwd-derived** repo even when
 * `GH_REPO` is set — a resolver that shelled straight to it would silently ignore
 * the override. Soft-fails to `null` when nothing resolves.
 */
export async function resolveRepoTarget(opts: RepoTargetOptions = {}): Promise<string | null> {
  const explicit = opts.repo?.trim();
  if (explicit) return explicit;
  const ghRepo = (opts.env ?? process.env).GH_REPO?.trim();
  if (ghRepo) return ghRepo;
  return currentRepo(opts);
}

/** Normalize an issue/PR number or URL to its numeric string, or `null`. */
function issueNumber(ref: string | number): string | null {
  const s = String(ref);
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(?:issues|pull)\/(\d+)/);
  return m?.[1] ?? null;
}

/** Add labels to an issue/PR (by number or URL). Additive. Returns stdout or `null`. */
export async function addLabels(
  repo: string,
  issue: string | number,
  labels: string[],
  call: GhCallOptions = {},
): Promise<string | null> {
  const number = issueNumber(issue);
  if (number === null || !labels.length) return null;
  const rest: Transport = {
    argv: ['gh', 'api', '-X', 'POST', `repos/${repo}/issues/${number}/labels`, '--input', '-'],
    stdin: JSON.stringify({ labels }),
  };
  const fb: Transport = {
    argv: ['gh', 'issue', 'edit', number, '--repo', repo, '--add-label', labels.join(',')],
  };
  const out = await ghCall(rest, fb, call);
  return out !== null ? out.trim() : null;
}

/** Remove a single label from an issue/PR (by number or URL). Returns stdout or `null`. */
export async function removeLabel(
  repo: string,
  issue: string | number,
  label: string,
  call: GhCallOptions = {},
): Promise<string | null> {
  const number = issueNumber(issue);
  if (number === null) return null;
  const rest: Transport = {
    argv: [
      'gh',
      'api',
      '-X',
      'DELETE',
      `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
    ],
  };
  const fb: Transport = {
    argv: ['gh', 'issue', 'edit', number, '--repo', repo, '--remove-label', label],
  };
  const out = await ghCall(rest, fb, call);
  return out !== null ? out.trim() : null;
}
