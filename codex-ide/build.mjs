/**
 * Codex IDE 扩展打包 — esbuild 单文件 CJS bundle
 * 核心 Agent 引擎（../src）一并打包，vscode 为外部模块。
 */
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || !watch;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: 'info',
  // 插件/MCP 的动态加载是运行时行为，保持原样
  supported: { 'dynamic-import': true },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[codex-ide] watch mode started');
} else {
  await build(options);
  console.log('[codex-ide] build complete → dist/extension.js');
}
