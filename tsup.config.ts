import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  splitting: false,
  shims: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});