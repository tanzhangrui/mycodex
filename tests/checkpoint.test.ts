/**
 * 检查点（回滚时间线）测试 — V3.1 迭代 C
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';

describe('InMemoryFileSystem 检查点', () => {
  let dir: string;
  let fs: InMemoryFileSystem;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-cp-'));
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'b.ts'), 'const b = 2;\n');
    fs = new InMemoryFileSystem();
    await fs.snapshot(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('恢复检查点可撤销后续修改', () => {
    const cp = fs.createCheckpoint();

    fs.write('a.ts', 'const a = 999;\n');
    fs.write('c.ts', 'const c = 3;\n');
    expect(fs.getDirtyCount()).toBe(2);

    fs.restoreCheckpoint(cp);
    expect(fs.read('a.ts')).toBe('const a = 1;\n');
    expect(fs.read('c.ts')).toBeNull();
    expect(fs.isDirty()).toBe(false);
  });

  it('检查点互不影响（多轮时间线）', () => {
    const cp1 = fs.createCheckpoint();
    fs.write('a.ts', 'v2\n');
    const cp2 = fs.createCheckpoint();
    fs.write('a.ts', 'v3\n');

    fs.restoreCheckpoint(cp2);
    expect(fs.read('a.ts')).toBe('v2\n');

    fs.restoreCheckpoint(cp1);
    expect(fs.read('a.ts')).toBe('const a = 1;\n');
  });

  it('rebaseAgainstDisk：应用到磁盘后回滚可重新写回', () => {
    const cp = fs.createCheckpoint();

    // 模拟一轮任务：修改并应用到磁盘
    fs.write('a.ts', 'const a = 999;\n');
    const applied = fs.applyToDisk();
    expect(applied.applied.length).toBe(1);
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('const a = 999;\n');
    expect(fs.isDirty()).toBe(false);

    // 回滚 + 对齐磁盘：应重新标记 dirty
    fs.restoreCheckpoint(cp);
    fs.rebaseAgainstDisk();
    expect(fs.isDirty()).toBe(true);

    // 再次应用 = 把回滚状态写回磁盘
    fs.applyToDisk();
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('const a = 1;\n');
  });

  it('恢复后 diff 基于检查点状态计算', () => {
    const cp = fs.createCheckpoint();
    fs.write('b.ts', 'changed\n');
    fs.restoreCheckpoint(cp);
    expect(fs.getAllDiffs().size).toBe(0);
  });
});
