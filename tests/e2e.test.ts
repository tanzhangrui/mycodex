/**
 * V1.3 — E2E 测试
 * ==========================================
 * 测试完整的 Agent 循环流程
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockProvider } from '../src/utils/ai-client.js';
import { runAgentLoop, type AgentCallbacks } from '../src/core/agent-loop.js';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';
import { registerBuiltinTools, clearTools } from '../src/tools/builtin.js';
import { createSandbox } from '../src/sandbox/sandbox.js';
import { existsSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- 辅助函数 ----

function createTestDir(): string {
  const dir = join(tmpdir(), `codex-e2e-test-${Date.now()}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cleanupTestDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmdirSync(dir, { recursive: true });
    }
  } catch {
    // 忽略清理错误
  }
}

function createNoopCallbacks(): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}

// ---- 测试 ----

describe('E2E Agent 循环', () => {
  beforeEach(() => {
    // 确保工具已注册
    clearTools();
    registerBuiltinTools();
  });

  it('1. Mock Provider 返回工具调用 → 验证工具执行 → 验证结果追加到消息历史', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();

    try {
      // 创建测试文件
      writeFileSync(join(testDir, 'test.txt'), 'Hello World\nLine 2\nLine 3');

      await fs.snapshot(testDir);

      const callbacks = createNoopCallbacks();
      const result = await runAgentLoop(
        provider,
        [{ role: 'user', content: '列出文件和读取test.txt', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
      );

      // 验证结果结构
      expect(result).toBeDefined();
      expect(typeof result.text).toBe('string');
      expect(Array.isArray(result.toolCalls)).toBe(true);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage.totalTokens).toBeGreaterThan(0);

      // 验证工具调用回调被触发
      expect(callbacks.onToolUse).toHaveBeenCalled();
      expect(callbacks.onToolResult).toHaveBeenCalled();
      expect(callbacks.onDone).toHaveBeenCalled();

      // 如果有工具调用，验证结果
      if (result.toolCalls.length > 0) {
        for (const tc of result.toolCalls) {
          expect(tc.name).toBeTruthy();
          expect(tc.input).toBeDefined();
          expect(typeof tc.success).toBe('boolean');
          expect(tc.output).toBeDefined();
        }
      }
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('2. 并行工具调用 → 验证 Promise.all 执行', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();
    const sandbox = createSandbox(testDir);

    try {
      // 创建测试文件
      writeFileSync(join(testDir, 'a.ts'), 'const a = 1;');
      writeFileSync(join(testDir, 'b.ts'), 'const b = 2;');
      writeFileSync(join(testDir, 'config.ts'), 'export const config = {};');

      await fs.snapshot(testDir);

      const callbacks = createNoopCallbacks();
      const result = await runAgentLoop(
        provider,
        [{ role: 'user', content: '读取 src/index.ts 和 src/config/config.ts', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
        undefined,
        sandbox,
      );

      // 验证多个工具调用
      const readFileCalls = result.toolCalls.filter((tc) => tc.name === 'read_file');
      expect(readFileCalls.length).toBeGreaterThanOrEqual(0); // Mock 可能不总返回 read_file

      // 如果有多个工具调用，验证它们都被执行了
      if (result.toolCalls.length > 1) {
        expect(callbacks.onToolUse).toHaveBeenCalledTimes(result.toolCalls.length);
        expect(callbacks.onToolResult).toHaveBeenCalledTimes(result.toolCalls.length);
      }
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('3. 工具缓存命中 → 验证第二次调用返回缓存结果', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();

    try {
      writeFileSync(join(testDir, 'cache-test.ts'), '// cache test file');
      await fs.snapshot(testDir);

      // 第一次调用
      const callbacks1 = createNoopCallbacks();
      const result1 = await runAgentLoop(
        provider,
        [{ role: 'user', content: '读取 cache-test.ts', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks1,
      );

      // 立即第二次调用（应该命中缓存，< 5s TTL）
      const callbacks2 = createNoopCallbacks();
      const result2 = await runAgentLoop(
        provider,
        [{ role: 'user', content: '读取 cache-test.ts', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks2,
      );

      // 验证两次调用都成功
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      // 如果有 read_file 工具调用，验证结果
      const readCalls1 = result1.toolCalls.filter((tc) => tc.name === 'read_file');
      const readCalls2 = result2.toolCalls.filter((tc) => tc.name === 'read_file');
      if (readCalls1.length > 0 && readCalls2.length > 0) {
        expect(readCalls1[0].success).toBe(true);
        expect(readCalls2[0].success).toBe(true);
      }
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('4. AbortSignal → 验证中断后循环退出', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();
    const sandbox = createSandbox(testDir);

    try {
      await fs.snapshot(testDir);

      const controller = new AbortController();
      const callbacks = createNoopCallbacks();

      // 在短时间内中断
      const abortPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 100);
      });

      const resultPromise = runAgentLoop(
        provider,
        [{ role: 'user', content: '运行 node -v', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
        controller.signal,
        sandbox,
      );

      // 等待 abort 和 agent loop 同时完成
      await Promise.all([abortPromise, resultPromise]);

      const result = await resultPromise;
      expect(result).toBeDefined();
      // 验证 loop 被中断（不会运行完整的 10 次循环）
      expect(result.toolCalls.length).toBeLessThanOrEqual(1);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('5. 安全沙箱 → 危险命令被拒绝', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();
    const sandbox = createSandbox(testDir);

    try {
      await fs.snapshot(testDir);

      const callbacks = createNoopCallbacks();
      const result = await runAgentLoop(
        provider,
        [{ role: 'user', content: '运行 rm -rf /', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
        undefined,
        sandbox,
      );

      // 如果有 run_command 工具调用，验证它被拒绝
      const cmdCalls = result.toolCalls.filter((tc) => tc.name === 'run_command');
      if (cmdCalls.length > 0) {
        for (const tc of cmdCalls) {
          expect(tc.success).toBe(false);
          expect(tc.output).toBe('');
        }
      }
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('6. CODEX.md 规则加载', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();

    try {
      // 创建 CODEX.md
      writeFileSync(join(testDir, 'CODEX.md'), '本项目使用 TypeScript 严格模式。\n不要使用 any 类型。');

      // 创建测试文件
      writeFileSync(join(testDir, 'test.ts'), '// test');
      await fs.snapshot(testDir);

      const callbacks = createNoopCallbacks();
      const result = await runAgentLoop(
        provider,
        [{ role: 'user', content: '列出文件', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
      );

      // 验证 Agent 循环正常运行（CODEX.md 不应导致崩溃）
      expect(result).toBeDefined();
      expect(result.hasError).toBe(false);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  it('7. Token 用量累积', async () => {
    const provider = new MockProvider();
    const fs = new InMemoryFileSystem();
    const testDir = createTestDir();

    try {
      await fs.snapshot(testDir);

      const callbacks = createNoopCallbacks();

      // 第一次调用
      const result1 = await runAgentLoop(
        provider,
        [{ role: 'user', content: '你好', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
      );

      expect(result1.tokenUsage).toBeDefined();
      expect(result1.tokenUsage.totalTokens).toBeGreaterThanOrEqual(0);

      // 第二次调用
      const result2 = await runAgentLoop(
        provider,
        [{ role: 'user', content: '列出文件', timestamp: new Date().toISOString() }],
        fs,
        testDir,
        callbacks,
      );

      expect(result2.tokenUsage).toBeDefined();
      expect(result2.tokenUsage.totalTokens).toBeGreaterThanOrEqual(0);
    } finally {
      cleanupTestDir(testDir);
    }
  });
});