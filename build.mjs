/**
 * Codex Build Script
 * ==========================================
 * 使用 esbuild 直接构建，支持开发和生产模式
 *
 * 用法:
 *   node build.mjs           生产构建 (minified)
 *   node build.mjs --dev     开发构建 (sourcemap, no minify)
 *   node build.mjs --watch   监听模式
 */

import * as esbuild from 'esbuild';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

const banner = '#!/usr/bin/env node';

/** @type {esbuild.BuildOptions} */
const config = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: { js: banner },
  packages: 'external',
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  loader: {
    '.jsx': 'jsx',
    '.tsx': 'tsx',
  },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  const result = await esbuild.build(config);

  if (result.errors.length > 0) {
    console.error('Build failed:', result.errors);
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    console.warn('Build warnings:', result.warnings);
  }

  console.log(`Build succeeded! (${isDev ? 'development' : 'production'} mode)`);
  console.log(`Output: dist/index.js`);

  await esbuild.stop();
}