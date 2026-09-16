import { describe, it, expect } from 'vitest';
import { boundedRun } from '../src/lib/bounded-subprocess.js';

// Exercise the wrapper against cheap, hermetic `node -e` subprocesses — no
// network, no `gh`, no `git` — so each behavior (success, failure, timeout,
// stdin) is deterministic and self-contained. `process.execPath` is the running
// node binary, always present on the test host.
const node = process.execPath;

describe('boundedRun', () => {
  it('captures stdout and resolves with code 0 on success', async () => {
    const result = await boundedRun(node, ['-e', "process.stdout.write('ok')"], {
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr and surfaces a non-zero exit code on failure', async () => {
    const result = await boundedRun(node, ['-e', "process.stderr.write('boom'); process.exit(3)"], {
      timeoutMs: 5000,
    });

    expect(result.stderr).toBe('boom');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('kills the process group and flags timedOut when the wall-clock bound expires', async () => {
    // A child that would otherwise run forever; the 50ms bound must terminate it.
    const result = await boundedRun(node, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    // Killed by SIGKILL → no clean exit code.
    expect(result.code).toBeNull();
  });

  it('writes the provided input to the child stdin, then closes it', async () => {
    const result = await boundedRun(
      node,
      ['-e', "process.stdin.on('data', (c) => process.stdout.write(c.toString().toUpperCase()))"],
      { timeoutMs: 5000, input: 'hello' },
    );

    expect(result.stdout).toBe('HELLO');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
