// Pre-merge guard: prove the changelog toolchain can actually render release
// notes with the *installed* preset + conventional-changelog-writer, so an
// incompatible pairing (e.g. a Dependabot bump of
// `conventional-changelog-conventionalcommits` to a major that outruns the
// writer semantic-release ships) fails the PR here — not the post-merge Release
// run, which only fires on push to main (see .github/workflows/release.yml).
//
// Why not `semantic-release --dry-run`? semantic-release short-circuits before
// rendering notes on a `pull_request` event ("a new version won't be published"),
// so a dry-run is a false pass — it never exercises generateNotes, the exact step
// that broke on main. Defeating that short-circuit makes semantic-release run its
// full verifyConditions first, which includes a git *push*-permission check that
// fails on the read-only GITHUB_TOKEN every Dependabot and fork PR gets — i.e. it
// would fail on precisely the bumps this guard exists to catch, and for the wrong
// reason. So we invoke the genuine `@semantic-release/release-notes-generator`
// render path directly: no token, no network, no push — just the preset+writer
// seam. The plugin is pinned to the version semantic-release resolves, so it
// renders with the same writer the real release uses.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateNotes } from '@semantic-release/release-notes-generator';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Use the same release-notes-generator options the real release uses, read from
// .releaserc.json rather than hard-coded, so a config change (preset, presetConfig)
// is exercised by this guard too.
const config = JSON.parse(await readFile(join(repoRoot, '.releaserc.json'), 'utf8'));
const pluginName = '@semantic-release/release-notes-generator';
const entry = (config.plugins ?? []).find(
  (plugin) => plugin === pluginName || (Array.isArray(plugin) && plugin[0] === pluginName),
);
if (!entry) {
  console.error(`No "${pluginName}" plugin found in .releaserc.json`);
  process.exit(1);
}
const pluginConfig = Array.isArray(entry) ? (entry[1] ?? {}) : {};

// A synthetic release with one commit of every conventional type the writer
// templates render differently (breaking, feat, fix), so a template that
// references a helper the installed writer lacks throws here.
const context = {
  cwd: repoRoot,
  env: {},
  options: { repositoryUrl: 'https://github.com/rmartz/merge-safety.git' },
  lastRelease: { gitTag: 'v0.0.0', version: '0.0.0' },
  nextRelease: { gitTag: 'v0.0.1', version: '0.0.1', type: 'minor', channel: null },
  commits: [
    { hash: '0'.repeat(40), message: 'feat!: breaking sample\n\nBREAKING CHANGE: sample' },
    { hash: '1'.repeat(40), message: 'feat: feature sample' },
    { hash: '2'.repeat(40), message: 'fix: fix sample' },
  ],
  logger: { log: () => {}, error: () => {} },
};

try {
  const notes = await generateNotes(pluginConfig, context);
  if (!notes || notes.trim().length === 0) {
    console.error('Changelog render produced empty notes — the toolchain is misconfigured.');
    process.exit(1);
  }
  console.log(`Changelog toolchain renders (${notes.length} chars of notes).`);
} catch (error) {
  console.error('Changelog toolchain FAILED to render release notes:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
