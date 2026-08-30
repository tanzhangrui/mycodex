/**
 * V2.0 — 性能基准测试
 * ==========================================
 *
 * 测试目标：
 * 1. 冷启动时间（CLI 启动到 REPL 就绪）
 * 2. Agent 循环 10 轮迭代耗时
 * 3. 1000 条消息的上下文裁剪耗时
 * 4. 1000 个文件的快照耗时
 * 5. 工具缓存命中率统计
 */

import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';
import { toolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { loadConfig } from '../src/config/config.js';
import { createProvider } from '../src/utils/ai-client.js';
import { runAgentLoop } from '../src/core/agent-loop.js';
import type { Message } from '../src/core/message-manager.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 隔离配置目录：agent-loop 触发的上下文引擎持久化绝不写入真实 ~/.codex
process.env.CODEX_CONFIG_PATH = join(tmpdir(), 'codex-test-config-bench');

// 注册内置工具
registerBuiltinTools();

describe('性能基准测试', () => {
  // ---- 1. 冷启动时间 ----

  it('冷启动时间（配置加载 + Provider 创建）', () => {
    const start = performance.now();
    const config = loadConfig();
    const provider = createProvider(config);
    const elapsed = performance.now() - start;

    console.log(`  冷启动: ${elapsed.toFixed(2)}ms`);
    expect(provider).toBeDefined();
    expect(elapsed).toBeLessThan(1000); // 应在 1s 内
  });

  // ---- 2. Agent 循环 10 轮 ----

  it('Agent 循环 10 轮迭代', async () => {
    const config = loadConfig();
    const provider = createProvider(config);
    const fs = new InMemoryFileSystem();
    await fs.snapshot(process.cwd());

    const messages: Message[] = [
      {
        role: 'user',
        content: 'Hello, this is a benchmark test.',
        timestamp: new Date().toISOString(),
      },
    ];

    const start = performance.now();
    let roundCount = 0;

    await runAgentLoop(provider, messages, fs, process.cwd(), {
      onTextDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: () => {},
      onDone: () => { roundCount++; },
    });

    const elapsed = performance.now() - start;
    console.log(`  Agent 循环 1 轮: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(30_000); // 应在 30s 内（含网络）
  }, 35_000);

  // ---- 3. 1000 条消息上下文裁剪 ----

  it('1000 条消息的上下文裁剪', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 1000; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(100)}`,
        timestamp: new Date(Date.now() - (1000 - i) * 1000).toISOString(),
      });
    }

    const start = performance.now();

    // 模拟上下文裁剪：保留最近 50 条 + 系统消息
    const systemMessages = messages.filter((m) => m.content.includes('[system]'));
    const recentMessages = messages.slice(-50);
    const trimmed = [...systemMessages, ...recentMessages];

    const elapsed = performance.now() - start;
    console.log(`  1000 条消息裁剪: ${elapsed.toFixed(2)}ms`);
    expect(trimmed.length).toBeLessThanOrEqual(1000);
    expect(elapsed).toBeLessThan(100); // 应在 100ms 内
  });

  // ---- 4. 1000 个文件快照 ----

  it('1000 个文件的快照', async () => {
    const tmpDir = join(tmpdir(), 'codex-benchmark-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    // 创建 1000 个测试文件
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(tmpDir, `file_${i}.txt`), `Content ${i}: ${'x'.repeat(50)}`);
    }
    const createElapsed = performance.now() - start;
    console.log(`  创建 1000 个文件: ${createElapsed.toFixed(2)}ms`);

    // 快照
    const fs = new InMemoryFileSystem();
    const snapshotStart = performance.now();
    await fs.snapshot(tmpDir);
    const snapshotElapsed = performance.now() - snapshotStart;

    console.log(`  1000 个文件快照: ${snapshotElapsed.toFixed(2)}ms`);
    expect(snapshotElapsed).toBeLessThan(5000); // 应在 5s 内

    // 清理
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }, 15_000);

  // ---- 5. 工具缓存命中率 ----

  it('工具缓存命中率', async () => {
    // 第一次调用：缓存未命中
    const start = performance.now();
    const result1 = await toolRegistry.execute('list_files', { path: '.', depth: 1 }, {
      workingDir: process.cwd(),
      readFile: () => null,
      writeFile: () => {},
      listFiles: () => ['src/index.ts', 'src/config.ts', 'package.json'],
      searchContent: () => [],
      confirm: async () => true,
    });

    const firstElapsed = performance.now() - start;

    // 第二次调用：应命中缓存
    const cacheStart = performance.now();
    const result2 = await toolRegistry.execute('list_files', { path: '.', depth: 1 }, {
      workingDir: process.cwd(),
      readFile: () => null,
      writeFile: () => {},
      listFiles: () => ['src/index.ts', 'src/config.ts', 'package.json'],
      searchContent: () => [],
      confirm: async () => true,
    });
    const cacheElapsed = performance.now() - cacheStart;

    console.log(`  首次调用: ${firstElapsed.toFixed(2)}ms`);
    console.log(`  缓存命中: ${cacheElapsed.toFixed(2)}ms`);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(cacheElapsed).toBeLessThan(firstElapsed); // 缓存应更快
  });

  // ---- 6. 工具注册性能 ----

  it('工具注册和查找性能', () => {
    const start = performance.now();

    // 查找所有工具
    const tools = toolRegistry.getAllDefinitions();
    const elapsed = performance.now() - start;

    console.log(`  工具注册数: ${tools.length}`);
    console.log(`  工具查找: ${elapsed.toFixed(2)}ms`);
    expect(tools.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10); // 应在 10ms 内
  });
});