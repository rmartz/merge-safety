#!/usr/bin/env node
/**
 * `ai-merge-safety` CLI — SCAFFOLD.
 *
 * Extraction target per ai-tools#247. Until `merge-safety.ts` /
 * `merge-safety-facts.ts` migrate from `@rmartz/pr-review`, this entry point only
 * validates the command surface (`evaluate` | `invalidate`) so the reusable
 * workflow's shape can be wired end to end. The real implementation — and the
 * depend-vs-inline decision for `@rmartz/github` / `@rmartz/agent-runtime` — is
 * resolved during the migration. See docs/migration.md.
 */
import { MERGE_SAFETY_COMMANDS, isMergeSafetyCommand } from '../index.js';

const command = process.argv[2];

if (!isMergeSafetyCommand(command)) {
  console.error(`usage: ai-merge-safety <${MERGE_SAFETY_COMMANDS.join(' | ')}> [options]`);
  process.exit(2);
}

console.error(
  `ai-merge-safety ${command}: not yet implemented — the evaluate/invalidate logic ` +
    `is migrating from @rmartz/pr-review (ai-tools#247). See docs/migration.md.`,
);
process.exit(1);
