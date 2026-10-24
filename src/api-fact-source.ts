/**
 * The API-backed fact source: a {@link GitRunner} that answers the `git` queries
 * {@link gatherMergeSafetyFacts} makes from the GitHub REST API instead of a local
 * checkout, so merge-safety can run where there is no `git` binary (a hosted
 * GitHub App's serverless function). The git-backed runner stays the default; this
 * one is opt-in through the same `git` injection point.
 *
 * Every query maps onto two compares and, for CI-path detection, one commit read
 * per base commit:
 * - `compare/{head}...{tip}` — the merge base, the base commits since it, and the
 *   base-side changed files;
 * - `compare/{tip}...{head}` — the PR-side changed files and their patches;
 * - `commits/{sha}` — each base commit's own files, for the CI-path signal.
 *
 * The compare API truncates silently (250 commits, 300 files) and omits `patch`
 * for oversized files. Each of those **fails closed** by throwing, so the caller
 * reports `Could not evaluate` rather than a verdict built on partial data.
 */
import { baseBranchName, isCiPath, type GitRunner } from './merge-safety-facts.js';

/**
 * A GitHub REST `GET` for a path relative to the API root (e.g.
 * `repos/o/r/compare/a...b`), yielding the parsed JSON body, or `null` when the
 * read fails. A caller that wants a transient error to abort the run (rather than
 * fail the check) may throw instead; the error propagates unchanged.
 */
export type GitHubApiGet = (path: string) => Promise<unknown>;

export interface ApiGitRunnerOptions {
  /** `owner/repo` the PR and its base live in. */
  repo: string;
  api: GitHubApiGet;
  /** Concurrent `commits/{sha}` reads during CI-path detection (default 8). */
  concurrency?: number;
}

/** The compare API's caps: past these its lists are silently truncated. */
export const COMPARE_MAX_COMMITS = 250;
export const COMPARE_MAX_FILES = 300;
/** A commit read lists at most this many files without pagination. */
export const COMMIT_MAX_FILES = 300;

interface ApiFile {
  filename: string;
  previous_filename?: string;
  changes?: number;
  patch?: string;
}

interface ApiCommit {
  sha: string;
  commit: { message: string };
  parents?: readonly { sha: string }[];
}

interface CompareResponse {
  merge_base_commit: { sha: string };
  total_commits: number;
  commits: readonly ApiCommit[];
  files?: readonly ApiFile[];
}

interface Comparison {
  head: string;
  baseRef: string;
  tip: string;
  mergeBase: string;
  base: CompareResponse;
  pr?: Promise<readonly ApiFile[]>;
  ciLog?: Promise<string>;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** The changed files of a compare, failing closed when the list may be truncated. */
function compareFiles(compare: CompareResponse, side: string): readonly ApiFile[] {
  const files = compare.files ?? [];
  if (files.length >= COMPARE_MAX_FILES) {
    throw new Error(
      `${side} diff lists ${files.length} files, at the compare API's ${COMPARE_MAX_FILES}-file cap`,
    );
  }
  return files;
}

/**
 * The PR's patch in the shape `git diff --unified=0` emits, as far as the
 * breaking-diff detectors read it: a `diff --git` header per file, then its hunks.
 * A file with changed lines but no `patch` (GitHub omits it for oversized diffs)
 * fails closed. A file with no changed lines and no patch — a binary or a pure
 * rename — keeps only its header, which is all `git diff` gives the detectors too.
 */
function synthesizePatch(files: readonly ApiFile[]): string {
  return files
    .map((f) => {
      const header = `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}`;
      if (f.patch !== undefined) return `${header}\n${f.patch}\n`;
      if ((f.changes ?? 0) > 0) {
        throw new Error(`the compare API omitted the patch for ${f.filename}`);
      }
      return `${header}\n`;
    })
    .join('');
}

/**
 * A {@link GitRunner} backed by the GitHub REST API rather than a checkout. It
 * answers exactly the queries {@link gatherMergeSafetyFacts} makes and throws on
 * any other, so a new git query added there fails closed until it is mapped here.
 * Comparisons are cached for the runner's lifetime, so create one per evaluation.
 */
export function makeApiGitRunner({ repo, api, concurrency = 8 }: ApiGitRunnerOptions): GitRunner {
  const tips = new Map<string, Promise<string>>();
  const comparisons = new Map<string, Promise<Comparison>>();
  const loaded: Comparison[] = [];

  async function get<T>(path: string): Promise<T> {
    const body = await api(path);
    if (body === null || body === undefined) throw new Error(`GitHub API read failed: ${path}`);
    return body as T;
  }

  async function loadTip(baseRef: string): Promise<string> {
    const branch = encodeURIComponent(baseBranchName(baseRef));
    const b = await get<{ commit: { sha: string } }>(`repos/${repo}/branches/${branch}`);
    return b.commit.sha;
  }

  function resolveTip(baseRef: string): Promise<string> {
    let tip = tips.get(baseRef);
    if (!tip) {
      tip = loadTip(baseRef);
      tips.set(baseRef, tip);
    }
    return tip;
  }

  async function loadComparison(head: string, baseRef: string): Promise<Comparison> {
    const tip = await resolveTip(baseRef);
    const base = await get<CompareResponse>(`repos/${repo}/compare/${head}...${tip}`);
    if (base.total_commits > base.commits.length) {
      throw new Error(
        `base moved by ${base.total_commits} commits, past the compare API's ` +
          `${COMPARE_MAX_COMMITS}-commit cap`,
      );
    }
    const comparison: Comparison = {
      head,
      baseRef,
      tip,
      mergeBase: base.merge_base_commit.sha,
      base,
    };
    loaded.push(comparison);
    return comparison;
  }

  function compare(head: string, baseRef: string): Promise<Comparison> {
    const key = `${head}\0${baseRef}`;
    let c = comparisons.get(key);
    if (!c) {
      c = loadComparison(head, baseRef);
      comparisons.set(key, c);
    }
    return c;
  }

  /** The loaded comparison a later query (keyed on its merge base) belongs to. */
  function find(mergeBase: string, match: (c: Comparison) => boolean): Comparison {
    const c = loaded.find((l) => l.mergeBase === mergeBase && match(l));
    if (!c) throw new Error(`no comparison loaded for merge base ${mergeBase}`);
    return c;
  }

  /** Base commits, newest first like `git log`. */
  function baseCommits(c: Comparison): ApiCommit[] {
    return [...c.base.commits].reverse();
  }

  async function loadPrFiles(c: Comparison): Promise<readonly ApiFile[]> {
    const pr = await get<CompareResponse>(`repos/${repo}/compare/${c.tip}...${c.head}`);
    return compareFiles(pr, 'PR');
  }

  function prFiles(c: Comparison): Promise<readonly ApiFile[]> {
    c.pr ??= loadPrFiles(c);
    return c.pr;
  }

  /** One base commit's `git log --format=%x00%H --name-only` record. */
  async function commitRecord(commit: ApiCommit): Promise<string> {
    // `git log --name-only` lists no files for a merge commit; neither do we.
    if ((commit.parents?.length ?? 1) > 1) return `\0${commit.sha}\n`;
    const full = await get<{ files?: readonly ApiFile[] }>(`repos/${repo}/commits/${commit.sha}`);
    const files = (full.files ?? []).map((f) => f.filename);
    if (files.length >= COMMIT_MAX_FILES && !files.some(isCiPath)) {
      throw new Error(
        `base commit ${commit.sha} lists ${files.length} files, at the commit API's ` +
          `${COMMIT_MAX_FILES}-file cap`,
      );
    }
    return `\0${commit.sha}\n\n${files.join('\n')}\n`;
  }

  async function loadCiLog(c: Comparison): Promise<string> {
    const records = await mapBounded(baseCommits(c), concurrency, commitRecord);
    return records.join('');
  }

  /** `git log --format=%x00%H --name-only`: each base commit's own changed files. */
  function ciLog(c: Comparison): Promise<string> {
    c.ciLog ??= loadCiLog(c);
    return c.ciLog;
  }

  return async (args) => {
    const [cmd, ...rest] = args;
    const joined = rest.join(' ');
    if (cmd === 'merge-base' && rest.length === 2) {
      return (await compare(rest[0] as string, rest[1] as string)).mergeBase;
    }
    if (cmd === 'rev-parse' && rest.length === 1) return resolveTip(rest[0] as string);

    const range = /^(\S+)\.\.(\S+)$/.exec(rest[rest.length - 1] ?? '');
    if (cmd === 'log' && range) {
      const mergeBase = range[1] ?? '';
      const baseRef = range[2] ?? '';
      const c = find(mergeBase, (l) => l.baseRef === baseRef);
      if (joined === `-z --format=%H%n%B ${mergeBase}..${baseRef}`) {
        return baseCommits(c)
          .map((commit) => `${commit.sha}\n${commit.commit.message}`)
          .join('\0');
      }
      if (joined === `--format=%x00%H --name-only ${mergeBase}..${baseRef}`) return ciLog(c);
    }

    if (cmd === 'diff' && rest.length === 3) {
      const [flag, mergeBase, ref] = rest as [string, string, string];
      if (flag === '--name-only') {
        const c = find(mergeBase, (l) => l.baseRef === ref || l.head === ref);
        const files = c.baseRef === ref ? compareFiles(c.base, 'base') : await prFiles(c);
        return files.map((f) => f.filename).join('\n');
      }
      if (flag === '--unified=0') {
        return synthesizePatch(await prFiles(find(mergeBase, (l) => l.head === ref)));
      }
    }

    throw new Error(`the API fact source does not support \`git ${args.join(' ')}\``);
  };
}
