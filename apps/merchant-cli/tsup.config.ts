import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  noExternal: ['@agenzo/cli-core'],
  external: ['@inquirer/prompts', 'commander'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
