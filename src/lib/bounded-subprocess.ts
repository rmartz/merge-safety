import { spawn } from 'node:child_process';

export interface BoundedResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface BoundedOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to the child's stdin, then closed. Used for `gh api --input -` bodies. */
  input?: string;
}

/**
 * Run a command with a hard wall-clock timeout, killing the whole process
 * group on expiry so no orphaned children survive.
 *
 * Inlined from `@rmartz/agent-runtime` per the extraction migration
 * (ai-tools#247, docs/migration.md) — the same ~67-line helper `rmartz/repo-hygiene`
 * vendored — so merge-safety's fact gathering can shell out to `git` without a
 * dependency edge on agent-runtime. Layer-0 foundation used by any caller that
 * shells out to a long-running tool.
 */
export function boundedRun(
  command: string,
  args: string[],
  options: BoundedOptions,
): Promise<BoundedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true, // new process group, so we can kill the whole tree
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL'); // negative pid → the group
      } catch {
        /* already gone */
      }
    }, options.timeoutMs);

    if (options.input !== undefined && child.stdin) {
      // Swallow EPIPE if the child exits before consuming stdin.
      child.stdin.on('error', () => {});
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
