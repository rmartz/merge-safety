import { defineConfig } from 'vitest/config';

// Single-package repo: vitest globs the whole test tree, so there is no manual
// discovery list to fall out of sync with the files on disk.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/bin/**', '**/index.ts'],
    },
  },
});
