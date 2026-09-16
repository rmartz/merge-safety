import { describe, it, expect } from 'vitest';
import {
  MERGE_SAFETY_CHECK_NAME,
  MERGE_SAFETY_COMMANDS,
  isMergeSafetyCommand,
} from '../src/index.js';

describe('merge-safety package contract', () => {
  it('pins the fleet check-run name to `merge-safety`', () => {
    // This name is a fleet contract (see docs/check-run-contract.md); a change
    // here is a coordinated fleet migration, so the test guards it deliberately.
    expect(MERGE_SAFETY_CHECK_NAME).toBe('merge-safety');
  });

  it('exposes exactly the evaluate/invalidate commands', () => {
    expect(MERGE_SAFETY_COMMANDS).toEqual(['evaluate', 'invalidate']);
  });

  it('recognizes valid commands and rejects everything else', () => {
    expect(isMergeSafetyCommand('evaluate')).toBe(true);
    expect(isMergeSafetyCommand('invalidate')).toBe(true);
    expect(isMergeSafetyCommand('nope')).toBe(false);
    expect(isMergeSafetyCommand(undefined)).toBe(false);
  });
});
