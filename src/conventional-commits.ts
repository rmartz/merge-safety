/**
 * Conventional-commit subject predicates — the title/commit-message half of the
 * merge-safety verdict's inputs.
 *
 * The counterpart to `breaking-diff.ts`: that module reads a PR's *diff*, this
 * one reads its *subject*. Together they are the TypeScript home of what
 * `claude/scripts/breaking_change.py` does in the coordinator, and keeping them
 * as two small pure modules is what lets the predicates have exactly one
 * implementation each (rmartz/dotfiles#1524).
 *
 * Extracted from `merge-safety.ts` when #53 pushed that file past its 480-line
 * `max-lines` cap.
 */

/**
 * Conventional-commit breaking marker in a subject, in either accepted position:
 * after the type (`feat!:`, `feat!(scope):`) or — per the Conventional Commits
 * spec — after the scope (`refactor(coordinator)!:`). The pre-scope form was a
 * live drift against the coordinator's `_BREAKING_RE`, which has always accepted
 * it (#53): a hand-typed `feat!(scope):` read as non-breaking here.
 */
const BREAKING_SUBJECT_RE = /^[a-z]+(?:!(?:\([^)]*\))?|(?:\([^)]*\))?!):/;

/** A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer anywhere in the message. */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

/** A `ci`-typed conventional commit (with or without a scope / `!`). */
const CI_SUBJECT_RE = /^ci(\([^)]*\))?!?:/;

/**
 * Conventional-commit types that may carry a `!` breaking marker. In a
 * semantic-release repo `!` fires a MAJOR release, so it is reserved for types
 * representing shippable functional change. `merge-pr.py` enforces this at merge
 * (rmartz/dotfiles#1559): it **strips** a `breaking change` label off any
 * non-functional-typed PR rather than stamping `!`. Mirrored here so the check
 * only ever proposes a label that will actually survive to merge.
 */
const FUNCTIONAL_TYPES = new Set(['feat', 'fix', 'perf', 'revert']);

/** The leading conventional-commit type, tolerating a scope and/or `!` in either order. */
const CONVENTIONAL_TYPE_RE = /^([a-z]+)(?:!|\([^)]*\))*:/;

/** The first line of a multi-line message — its subject. */
export function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

/** True when a commit message marks a breaking change (subject `!` or footer). */
export function isBreakingCommitMessage(message: string): boolean {
  return BREAKING_SUBJECT_RE.test(firstLine(message)) || BREAKING_FOOTER_RE.test(message);
}

/** True when a commit message is a `ci`-typed conventional commit. */
export function isCiCommitMessage(message: string): boolean {
  return CI_SUBJECT_RE.test(firstLine(message));
}

/** True when a PR title carries the conventional-commit breaking `!` marker. */
export function isBreakingTitle(title: string): boolean {
  return BREAKING_SUBJECT_RE.test(title.trim());
}

/** True when a PR title is a `ci`-typed conventional commit. */
export function isCiTitle(title: string): boolean {
  return CI_SUBJECT_RE.test(title.trim());
}

/**
 * True when the title's conventional-commit type is one a `!` marker — and so a
 * `breaking change` label — may legitimately land on. False for a non-conventional
 * title and for every non-functional type (`ci`/`docs`/`chore`/`refactor`/…).
 */
export function mayCarryBreakingMarker(title: string): boolean {
  const type = CONVENTIONAL_TYPE_RE.exec(title.trim())?.[1];
  return type !== undefined && FUNCTIONAL_TYPES.has(type);
}
