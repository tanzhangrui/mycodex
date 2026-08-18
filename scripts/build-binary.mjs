/**
 * V2.0 — 独立二进制分发脚本
 * ==========================================
 *
 * 使用 Node.js v20+ 的 Single Executable Application (SEA) 功能
 * 将 Codex 打包为独立二进制文件（无需 Node.js 运行时）。
 *
 * 回退方案：如果 SEA 不可用，生成启动脚本 (codex.bat / codex.sh)。
 *
 * 用法: node scripts/build-binary.mjs
 */

import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'bin');
const TARGET = process.platform === 'win32' ? 'codex.exe' : 'codex';

// 确保输出目录存在
if (!existsSync(OUT)) {
  mkdirSync(OUT, { recursive: true });
}

const nodeVersion = process.versions.node.split('.').map(Number);
const supportsSEA = nodeVersion[0] >= 20;

if (!supportsSEA) {
  console.log('Node.js < 20，SEA 不可用，使用启动脚本方案。');
  buildFallback();
  process.exit(0);
}

// ---- SEA 方案 ----

try {
  console.log('使用 Node.js SEA 构建独立二进制...');

  // 1. 确保 dist/index.js 已构建
  if (!existsSync(join(DIST, 'index.js'))) {
    console.log('构建 dist/index.js...');
    execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
  }

  // 2. 生成 SEA 配置文件
  const seaConfig = {
    main: join(DIST, 'index.js').replace(/\\/g, '\\\\'),
    output: join(OUT, 'sea-prep.blob').replace(/\\/g, '\\\\'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };

  const configPath = join(ROOT, 'sea-config.json');
  writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

  // 3. 生成 SEA blob
  console.log('生成 SEA blob...');
  execSync(`node --experimental-sea-config "${configPath}"`, { cwd: ROOT, stdio: 'inherit' });

  // 4. 复制 Node.js 二进制
  const nodeBinary = process.execPath;
  const outBinary = join(OUT, TARGET);
  copyFileSync(nodeBinary, outBinary);

  // 5. 注入 SEA blob（需要 postject）
  console.log('注入 SEA blob...');
  try {
    execSync(`npx --yes postject "${outBinary}" NODE_SEA_BLOB "${join(OUT, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });
  } catch {
    console.log('postject 不可用，尝试使用 Node.js 内置注入...');
    // 尝试使用 node --experimental-sea 运行
    const launcherPath = join(OUT, process.platform === 'win32' ? 'codex.bat' : 'codex');
    writeFileSync(
      launcherPath,
      process.platform === 'win32'
        ? `@echo off\r\nnode --experimental-sea "${outBinary}" %*`
        : `#!/bin/sh\nnode --experimental-sea "${outBinary}" "$@"`,
    );
    if (process.platform !== 'win32') {
      execSync(`chmod +x "${launcherPath}"`);
    }
  }

  console.log(`二进制构建完成: ${outBinary}`);
} catch (err) {
  console.log('SEA 构建失败，回退到启动脚本方案:', err.message);
  buildFallback();
}

// ---- 回退方案：启动脚本 ----

function buildFallback() {
  console.log('生成启动脚本...');

  // Windows: codex.bat
  const batPath = join(OUT, 'codex.bat');
  writeFileSync(batPath, [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'set "DIST_DIR=%SCRIPT_DIR%..\\dist"',
    'if not exist "%DIST_DIR%\\index.js" (',
    '  echo Error: dist/index.js not found. Run npm run build first.',
    '  exit /b 1',
    ')',
    'node "%DIST_DIR%\\index.js" %*',
  ].join('\r\n') + '\r\n');
  console.log(`  ${batPath}`);

  // Linux/macOS: codex.sh
  const shPath = join(OUT, 'codex');
  writeFileSync(shPath, [
    '#!/bin/sh',
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'DIST_DIR="$SCRIPT_DIR/../dist"',
    'if [ ! -f "$DIST_DIR/index.js" ]; then',
    '  echo "Error: dist/index.js not found. Run npm run build first."',
    '  exit 1',
    'fi',
    'exec node "$DIST_DIR/index.js" "$@"',
  ].join('\n') + '\n');

  try {
    execSync(`chmod +x "${shPath}"`);
  } catch {
    // Windows 上忽略 chmod 错误
  }
  console.log(`  ${shPath}`);

  console.log('启动脚本生成完成。');
}