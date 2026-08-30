/**
 * V0.2 — 内存文件系统
 * ==========================================
 *
 * 设计决策：
 * 1. 启动时快照工作目录到内存 Map<路径, 内容>
 * 2. 所有文件操作在内存中进行，维护 dirty 标记
 * 3. 用户通过 /apply 命令将修改写入磁盘
 * 4. 自动跳过二进制文件和超大文件 (>1MB)
 * 5. 使用 .gitignore 规则排除文件
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { isSensitivePath } from './privacy-guard.js';

// ---- 常量 ----

/** 最大文件大小 (1MB) */
const MAX_FILE_SIZE = 1_048_576;

/** 文本文件扩展名（注意：.env 等敏感文件由 privacy-guard 物理隔离，不在此列） */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.json5',
  '.md', '.mdx', '.txt', '.rst',
  '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.svg', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.sql', '.graphql', '.prisma',
  '.gitignore', '.dockerignore', '.editorconfig',
  '.vue', '.svelte', '.astro',
  '.lock', 'Dockerfile', 'Makefile',
]);

/** 忽略目录 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', '.next', '.nuxt', '.output',
  '__pycache__', '.venv', 'venv', '.tox',
  '.cache', '.idea', '.vscode',
  'coverage', '.nyc_output',
]);

// ---- 类型 ----

export interface ApplyResult {
  applied: string[];
  failed: Array<{ path: string; error: string }>;
}

/** 检查点：完整状态快照（字符串不可变，浅拷贝 Map/Set 即可） */
export interface FsCheckpoint {
  files: Map<string, string>;
  originalFiles: Map<string, string>;
  dirtyFiles: Set<string>;
  deletedFiles: Set<string>;
}

// ---- 内存文件系统 ----

export class InMemoryFileSystem {
  /** 所有文件内容（路径 → 内容） */
  private files: Map<string, string> = new Map();

  /** 原始内容（用于 diff 对比） */
  private originalFiles: Map<string, string> = new Map();

  /** 已修改的文件路径 */
  private dirtyFiles: Set<string> = new Set();

  /** 已删除的文件路径 */
  private deletedFiles: Set<string> = new Set();

  /** 工作目录 */
  private workingDir: string = '';

  /**
   * 快照工作目录。V5.1：支持多根（string[]）——键为绝对路径天然无冲突，
   * 相对路径解析基准（resolvePath）取首根（主根语义）。
   */
  async snapshot(workingDir: string | string[]): Promise<void> {
    this.workingDir = resolve(Array.isArray(workingDir) ? workingDir[0] : workingDir);
    this.files.clear();
    this.originalFiles.clear();
    this.dirtyFiles.clear();
    this.deletedFiles.clear();

    const roots = Array.isArray(workingDir) ? workingDir : [workingDir];
    for (const root of roots) {
      this.scanDirectory(resolve(root));
    }

    // 复制到原始文件记录
    for (const [path, content] of this.files) {
      this.originalFiles.set(path, content);
    }
  }

  /**
   * 递归扫描目录
   */
  private scanDirectory(dir: string): void {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);

        // 跳过忽略目录
        if (IGNORE_DIRS.has(entry)) continue;

        // 隐私守卫：敏感文件（.env / 私钥 / 证书 / 凭据）永不入快照
        if (isSensitivePath(entry)) continue;

        // 跳过隐藏文件（除了 .gitignore 等白名单）
        if (entry.startsWith('.') && !['.gitignore', '.editorconfig'].includes(entry)) continue;

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            this.scanDirectory(fullPath);
          } else if (stat.isFile()) {
            if (stat.size > MAX_FILE_SIZE) continue;

            const ext = entry.includes('.') ? entry.slice(entry.lastIndexOf('.')) : entry;
            const baseName = entry;

            if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(baseName)) {
              try {
                const content = readFileSync(fullPath, 'utf-8');
                this.files.set(fullPath, content);
              } catch {
                // 跳过无法读取的文件
              }
            }
          }
        } catch {
          // 跳过无权限的文件
        }
      }
    } catch {
      // 目录不存在或无权限
    }
  }

  /**
   * 读取文件内容
   */
  read(path: string): string | null {
    // 隐私守卫（纵深防御）：敏感文件不可读
    if (isSensitivePath(path)) return null;
    const absolutePath = this.resolvePath(path);
    return this.files.get(absolutePath) ?? null;
  }

  /**
   * 写入文件（内存中）
   */
  write(path: string, content: string): void {
    // 隐私守卫（纵深防御）：敏感文件不可写
    if (isSensitivePath(path)) return;
    const absolutePath = this.resolvePath(path);
    this.files.set(absolutePath, content);
    this.dirtyFiles.add(absolutePath);
    this.deletedFiles.delete(absolutePath);

    // 如果文件不在原始记录中，标记为新文件
    if (!this.originalFiles.has(absolutePath)) {
      this.originalFiles.set(absolutePath, '');
    }
  }

  /**
   * 删除文件（内存中）
   */
  delete(path: string): void {
    // 隐私守卫（纵深防御）：敏感文件不可删
    if (isSensitivePath(path)) return;
    const absolutePath = this.resolvePath(path);
    this.files.delete(absolutePath);
    this.dirtyFiles.delete(absolutePath);
    this.deletedFiles.add(absolutePath);
  }

  /**
   * 列出目录内容
   */
  list(dir: string, depth = 2): string[] {
    const absoluteDir = this.resolvePath(dir);
    const results: string[] = [];

    const prefix = absoluteDir + '/';
    for (const [filePath] of this.files) {
      if (filePath.startsWith(prefix) || filePath === absoluteDir) {
        const rel = relative(absoluteDir, filePath);
        const parts = rel.split('/');
        if (parts.length <= depth) {
          results.push(rel);
        }
      }
    }

    // 也检查磁盘上的目录
    try {
      if (existsSync(absoluteDir)) {
        this.listDiskDir(absoluteDir, absoluteDir, depth, results);
      }
    } catch {
      // 忽略
    }

    // 去重并排序
    return [...new Set(results)].sort();
  }

  private listDiskDir(baseDir: string, currentDir: string, depth: number, results: string[]): void {
    if (depth < 0) return;

    try {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        if (entry.startsWith('.') || IGNORE_DIRS.has(entry)) continue;

        const fullPath = join(currentDir, entry);
        const rel = relative(baseDir, fullPath);

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            results.push(rel + '/');
            if (depth > 0) {
              this.listDiskDir(baseDir, fullPath, depth - 1, results);
            }
          } else {
            results.push(rel);
          }
        } catch {
          // 跳过
        }
      }
    } catch {
      // 忽略
    }
  }

  /**
   * 搜索内容（简单实现）
   */
  search(pattern: string, searchPath?: string, glob?: string): string[] {
    const results: string[] = [];
    const searchDir = searchPath ? this.resolvePath(searchPath) : this.workingDir;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      regex = new RegExp(escapeRegex(pattern), 'gi');
    }

    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(searchDir)) continue;
      if (glob && !matchGlob(filePath, glob)) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          // 重置 lastIndex
          regex.lastIndex = 0;
          const relPath = relative(this.workingDir, filePath);
          results.push(`${relPath}:${i + 1}: ${lines[i].trim().substring(0, 120)}`);
        }
      }
    }

    return results;
  }

  /**
   * 生成单个文件的 unified diff
   */
  getDiff(path: string): string {
    const absolutePath = this.resolvePath(path);
    const original = this.originalFiles.get(absolutePath) || '';
    const current = this.files.get(absolutePath);

    if (current === undefined) {
      // 文件被删除
      return generateUnifiedDiff(relative(this.workingDir, absolutePath), original, '');
    }

    if (original === current) return '';
    return generateUnifiedDiff(relative(this.workingDir, absolutePath), original, current);
  }

  /**
 * 获取所有变更文件的 diff
   */
  getAllDiffs(): Map<string, string> {
    const diffs = new Map<string, string>();

    // 已修改的文件
    for (const path of this.dirtyFiles) {
      const diff = this.getDiff(path);
      if (diff) {
        diffs.set(path, diff);
      }
    }

    // 已删除的文件
    for (const path of this.deletedFiles) {
      diffs.set(path, `[已删除] ${relative(this.workingDir, path)}`);
    }

    return diffs;
  }

  /**
   * V1.4: 获取带 ANSI 颜色高亮的 diff
   */
  getColoredDiff(path: string): string {
    const absolutePath = this.resolvePath(path);
    const original = this.originalFiles.get(absolutePath) || '';
    const current = this.files.get(absolutePath);

    if (current === undefined) {
      // 文件被删除
      const raw = generateUnifiedDiff(relative(this.workingDir, absolutePath), original, '');
      return colorizeDiff(raw, relative(this.workingDir, absolutePath));
    }

    if (original === current) return '';
    const raw = generateUnifiedDiff(relative(this.workingDir, absolutePath), original, current);
    return colorizeDiff(raw, relative(this.workingDir, absolutePath));
  }

  /**
   * 获取所有变更文件的彩色 diff
   */
  getAllColoredDiffs(): Map<string, string> {
    const diffs = new Map<string, string>();

    for (const path of this.dirtyFiles) {
      const diff = this.getColoredDiff(path);
      if (diff) {
        diffs.set(path, diff);
      }
    }

    for (const path of this.deletedFiles) {
      diffs.set(path, `\x1b[31m[已删除]\x1b[0m ${relative(this.workingDir, path)}`);
    }

    return diffs;
  }

  /**
   * 将所有修改写入磁盘
   */
  applyToDisk(): ApplyResult {
    const result: ApplyResult = { applied: [], failed: [] };

    // 应用修改
    for (const path of this.dirtyFiles) {
      const content = this.files.get(path);
      if (content === undefined) continue;

      try {
        const dir = dirname(path);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(path, content, 'utf-8');
        this.originalFiles.set(path, content);
        result.applied.push(relative(this.workingDir, path));
      } catch (err) {
        result.failed.push({
          path: relative(this.workingDir, path),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 删除文件
    for (const path of this.deletedFiles) {
      try {
        unlinkSync(path);
        this.originalFiles.delete(path);
        result.applied.push(`[删除] ${relative(this.workingDir, path)}`);
      } catch (err) {
        result.failed.push({
          path: relative(this.workingDir, path),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 清除 dirty 标记
    this.dirtyFiles.clear();
    this.deletedFiles.clear();

    return result;
  }

  /**
   * 是否有未保存的修改
   */
  isDirty(): boolean {
    return this.dirtyFiles.size > 0 || this.deletedFiles.size > 0;
  }

  /**
   * V3.1: 创建检查点（每轮 Agent 任务前调用，支持逐轮回滚）
   */
  createCheckpoint(): FsCheckpoint {
    return {
      files: new Map(this.files),
      originalFiles: new Map(this.originalFiles),
      dirtyFiles: new Set(this.dirtyFiles),
      deletedFiles: new Set(this.deletedFiles),
    };
  }

  /**
   * V3.1: 恢复到检查点状态
   */
  restoreCheckpoint(checkpoint: FsCheckpoint): void {
    this.files = new Map(checkpoint.files);
    this.originalFiles = new Map(checkpoint.originalFiles);
    this.dirtyFiles = new Set(checkpoint.dirtyFiles);
    this.deletedFiles = new Set(checkpoint.deletedFiles);
  }

  /**
   * V3.1: 与磁盘重新对齐 — 回滚后若检查点之前已有变更被写入磁盘，
   * 将「内存内容与磁盘不一致」的文件重新标记为 dirty，
   * 使「全部应用」可以把回滚后的状态真正写回磁盘（时间旅行闭环）。
   */
  rebaseAgainstDisk(): void {
    for (const [path, content] of this.files) {
      let disk: string | null = null;
      try {
        disk = readFileSync(path, 'utf-8');
      } catch {
        // 磁盘上不存在（待新建）
      }
      if (disk !== content) {
        this.dirtyFiles.add(path);
        if (disk !== null) {
          this.originalFiles.set(path, disk);
        }
      }
    }
  }

  /**
   * 获取未保存的修改数量
   */
  getDirtyCount(): number {
    return this.dirtyFiles.size + this.deletedFiles.size;
  }

  /**
   * 解析路径为绝对路径
   */
  private resolvePath(path: string): string {
    if (resolve(path) === path) return path;
    return resolve(this.workingDir, path);
  }
}

// ---- Diff 生成 ----

function generateUnifiedDiff(filename: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diff = computeDiff(oldLines, newLines);

  if (diff.length === 0) return '';

  const header = `--- a/${filename}\n+++ b/${filename}\n`;
  const hunks = formatHunks(diff, oldLines.length, newLines.length);
  return header + hunks;
}

interface DiffOp {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

function computeDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  // 简化的 LCS diff 算法
  const m = oldLines.length;
  const n = newLines.length;

  // 构建 LCS 表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'equal', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'insert', text: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'delete', text: oldLines[i - 1] });
      i--;
    }
  }

  return ops;
}

function formatHunks(ops: DiffOp[], _oldLen: number, _newLen: number): string {
  const hunks: string[] = [];
  let oldStart = 1;
  let newStart = 1;
  let oldCount = 0;
  let newCount = 0;
  let hunkLines: string[] = [];

  for (const op of ops) {
    if (op.type === 'equal') {
      if (hunkLines.length > 0) {
        hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${hunkLines.join('\n')}`);
        hunkLines = [];
        oldCount = 0;
        newCount = 0;
      }
      oldStart += 1;
      newStart += 1;
    } else if (op.type === 'delete') {
      if (hunkLines.length === 0) {
        oldStart = oldStart;
        newStart = newStart;
      }
      hunkLines.push(`-${op.text}`);
      oldCount++;
    } else if (op.type === 'insert') {
      if (hunkLines.length === 0) {
        // 调整起始位置
      }
      hunkLines.push(`+${op.text}`);
      newCount++;
    }
  }

  if (hunkLines.length > 0) {
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${hunkLines.join('\n')}`);
  }

  return hunks.join('\n\n');
}

// ---- 工具函数 ----

// ANSI 颜色代码
const ANSI_RESET = '\x1b[0m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_CYAN_BOLD = '\x1b[1;36m';

/**
 * V1.4: 为 unified diff 输出添加 ANSI 颜色
 */
function colorizeDiff(diff: string, _filename: string): string {
  if (!diff) return '';

  const lines = diff.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // 文件名行 → 青色加粗
      result.push(`${ANSI_CYAN_BOLD}${line}${ANSI_RESET}`);
    } else if (line.startsWith('@@')) {
      // hunk header → 青色
      result.push(`\x1b[36m${line}${ANSI_RESET}`);
    } else if (line.startsWith('+')) {
      // 新增行 → 绿色
      result.push(`${ANSI_GREEN}${line}${ANSI_RESET}`);
    } else if (line.startsWith('-')) {
      // 删除行 → 红色
      result.push(`${ANSI_RED}${line}${ANSI_RESET}`);
    } else {
      // 上下文行 → 灰色
      result.push(`${ANSI_GRAY}${line}${ANSI_RESET}`);
    }
  }

  return result.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchGlob(filePath: string, glob: string): boolean {
  const regex = globToRegex(glob);
  const filename = filePath.split('/').pop() || filePath;
  return regex.test(filename);
}

function globToRegex(glob: string): RegExp {
  const pattern = glob
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}