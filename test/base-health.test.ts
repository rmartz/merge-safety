import { describe, it, expect } from 'vitest';
import { failingBaseChecks } from '../src/index.js';
import type { BaseCheckRun } from '../src/merge-safety.js';

const run = (
  name: string,
  conclusion: string | null,
  appSlug = 'github-actions',
): BaseCheckRun => ({
  name,
  conclusion,
  appSlug,
});

describe('failingBaseChecks', () => {
  it('counts a failing required check', () => {
    expect(
      failingBaseChecks([run('Test', 'failure'), run('Lint', 'success')], ['Test', 'Lint']),
    ).toEqual(['Test']);
  });

  it("ignores a failing check that isn't required", () => {
    expect(failingBaseChecks([run('Docs', 'failure')], ['Test'])).toEqual([]);
  });

  it('treats a required check still running as not failing', () => {
    expect(failingBaseChecks([run('Test', null)], ['Test'])).toEqual([]);
  });

  it('is the same set before and after a required check turns green, so a verdict keyed on it holds', () => {
    const before = failingBaseChecks([run('Test', null)], ['Test']);
    const after = failingBaseChecks([run('Test', 'success')], ['Test']);
    expect(after).toEqual(before);
  });

  it('falls back to failing Actions runs when no required checks are declared', () => {
    expect(
      failingBaseChecks([run('Build', 'failure'), run('Deploy', 'failure', 'vercel')], null),
    ).toEqual(['Build']);
  });

  it('treats an empty required set like an unreadable one', () => {
    expect(failingBaseChecks([run('Build', 'timed_out')], [])).toEqual(['Build']);
  });
});
