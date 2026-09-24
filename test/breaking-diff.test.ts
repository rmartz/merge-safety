import { describe, it, expect } from 'vitest';
import {
  breakingDiffSignals,
  majorVersionBumps,
  materialTestChanges,
  sensitivePackageBumps,
  hasSignal,
  signalDetail,
} from '../src/breaking-diff.js';

/** Assemble a unified diff from per-file bodies, as `git diff --unified=0` emits it. */
function diff(...files: { path: string; body: string }[]): string {
  return files
    .map(
      (f) =>
        `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n${f.body}`,
    )
    .join('\n');
}

const npmBump = (name: string, from: string, to: string) => ({
  path: 'package.json',
  body: `-    "${name}": "^${from}",\n+    "${name}": "^${to}",`,
});

describe('majorVersionBumps', () => {
  it('detects an npm dependency whose major version increased', () => {
    expect(majorVersionBumps(diff(npmBump('left-pad', '2.1.0', '3.0.0')))).toEqual([
      'left-pad 2.1.0 → 3.0.0',
    ]);
  });

  it('ignores a minor or patch bump', () => {
    expect(majorVersionBumps(diff(npmBump('left-pad', '2.1.0', '2.2.0')))).toEqual([]);
    expect(majorVersionBumps(diff(npmBump('left-pad', '2.1.0', '2.1.1')))).toEqual([]);
  });

  it('ignores a major version going *down* (a downgrade is not a bump)', () => {
    expect(majorVersionBumps(diff(npmBump('left-pad', '3.0.0', '2.1.0')))).toEqual([]);
  });

  it('detects a pip requirement whose major version increased', () => {
    const d = diff({
      path: 'requirements-dev.txt',
      body: '-django==3.2.1\n+django==4.0.0',
    });
    expect(majorVersionBumps(d)).toEqual(['django 3.2.1 → 4.0.0']);
  });

  it('fills absent pip version components with 0', () => {
    const d = diff({ path: 'requirements.txt', body: '-flask>=1\n+flask>=2' });
    expect(majorVersionBumps(d)).toEqual(['flask 1.0.0 → 2.0.0']);
  });

  it("ignores package.json's own `version` — a release PR is not a dependency bump", () => {
    const d = diff({
      path: 'package.json',
      body: '-  "version": "1.9.0",\n+  "version": "2.0.0",',
    });
    expect(majorVersionBumps(d)).toEqual([]);
  });

  it('ignores version-shaped lines outside a dependency manifest', () => {
    const d = diff({
      path: 'src/config.ts',
      body: '-  "left-pad": "^2.1.0",\n+  "left-pad": "^3.0.0",',
    });
    expect(majorVersionBumps(d)).toEqual([]);
  });

  it('matches a removed/added pair across name-normalization differences', () => {
    const d = diff({
      path: 'requirements.txt',
      body: '-My_Pkg==2.0.0\n+my-pkg==3.0.0',
    });
    expect(majorVersionBumps(d)).toEqual(['my-pkg 2.0.0 → 3.0.0']);
  });

  it('ignores an added dependency with no removed counterpart', () => {
    const d = diff({ path: 'package.json', body: '+    "brand-new": "^3.0.0",' });
    expect(majorVersionBumps(d)).toEqual([]);
  });
});

describe('sensitivePackageBumps', () => {
  it('detects a patch bump of a CI-sensitive formatter', () => {
    expect(sensitivePackageBumps(diff(npmBump('prettier', '3.9.7', '3.9.8')))).toEqual([
      'prettier 3.9.7 → 3.9.8',
    ]);
  });

  it('detects a pip linter bump', () => {
    const d = diff({ path: 'requirements-dev.txt', body: '-black==24.1.0\n+black==24.2.0' });
    expect(sensitivePackageBumps(d)).toEqual(['black 24.1.0 → 24.2.0']);
  });

  it('ignores a patch bump of a package that does not gate CI', () => {
    expect(sensitivePackageBumps(diff(npmBump('left-pad', '2.1.0', '2.1.1')))).toEqual([]);
  });

  it('ignores a CI-sensitive package whose version did not actually change', () => {
    const d = diff({
      path: 'package.json',
      body: '-    "prettier": "^3.9.8",\n+    "prettier": "^3.9.8"',
    });
    expect(sensitivePackageBumps(d)).toEqual([]);
  });

  it('matches a CI-sensitive name case-insensitively', () => {
    const d = diff({ path: 'requirements-dev.txt', body: '-Black==24.1.0\n+Black==24.2.0' });
    expect(sensitivePackageBumps(d)).toEqual(['Black 24.1.0 → 24.2.0']);
  });
});

describe('materialTestChanges', () => {
  it('detects an existing test file with both added and removed lines', () => {
    const d = diff({
      path: 'src/thing.test.ts',
      body: '-  expect(x).toBe(1);\n+  expect(x).toBe(2);',
    });
    expect(materialTestChanges(d)).toEqual(['src/thing.test.ts']);
  });

  it('ignores a pure addition — appended tests are not changed expectations', () => {
    const d = diff({ path: 'src/thing.test.ts', body: "+  it('new case', () => {});" });
    expect(materialTestChanges(d)).toEqual([]);
  });

  it('ignores a brand-new test file, whose /dev/null header is not a removal', () => {
    const d = [
      'diff --git a/src/new.test.ts b/src/new.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.test.ts',
      '@@ -0,0 +1 @@',
      "+it('x', () => {});",
    ].join('\n');
    expect(materialTestChanges(d)).toEqual([]);
  });

  it('ignores a non-test file modified the same way', () => {
    const d = diff({ path: 'src/thing.ts', body: '-const a = 1;\n+const a = 2;' });
    expect(materialTestChanges(d)).toEqual([]);
  });

  it('recognizes the .spec and Python test-file conventions', () => {
    const body = '-old\n+new';
    expect(materialTestChanges(diff({ path: 'a.spec.tsx', body }))).toEqual(['a.spec.tsx']);
    expect(materialTestChanges(diff({ path: 'pkg/test_thing.py', body }))).toEqual([
      'pkg/test_thing.py',
    ]);
    expect(materialTestChanges(diff({ path: 'pkg/thing_test.py', body }))).toEqual([
      'pkg/thing_test.py',
    ]);
  });

  it('reports every materially-changed test file, including the last in the diff', () => {
    const d = diff(
      { path: 'a.test.ts', body: '-old\n+new' },
      { path: 'src/x.ts', body: '-old\n+new' },
      { path: 'b.test.ts', body: '-old\n+new' },
    );
    expect(materialTestChanges(d)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('breakingDiffSignals', () => {
  it('is empty for a diff that trips nothing', () => {
    expect(breakingDiffSignals(diff({ path: 'README.md', body: '-a\n+b' }))).toEqual([]);
  });

  it('collects every fired detector, each with its detail', () => {
    const d = diff(
      npmBump('left-pad', '2.1.0', '3.0.0'),
      { path: 'a.test.ts', body: '-old\n+new' },
      npmBump('prettier', '3.9.7', '3.9.8'),
    );
    const signals = breakingDiffSignals(d);
    expect(signals.map((s) => s.kind)).toEqual([
      'major-version-bump',
      'sensitive-package-bump',
      'material-test-changes',
    ]);
    expect(hasSignal(signals, 'sensitive-package-bump')).toBe(true);
    expect(signalDetail(signals, 'material-test-changes')).toEqual(['a.test.ts']);
  });

  it('reports no detail for a kind that did not fire', () => {
    const signals = breakingDiffSignals(diff(npmBump('left-pad', '2.1.0', '3.0.0')));
    expect(hasSignal(signals, 'material-test-changes')).toBe(false);
    expect(signalDetail(signals, 'material-test-changes')).toEqual([]);
  });
});
