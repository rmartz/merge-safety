import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/merge-safety.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
