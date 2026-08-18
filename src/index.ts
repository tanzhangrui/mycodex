/**
 * Codex V2.0 — CLI 入口
 * ==========================================
 *
 * 完整功能：
 * - Agent 循环 + 并行工具执行 + 子 Agent 委派（tool_use > 5）
 * - Ink UI 代码高亮 + diff 彩色输出
 * - MCP 协议兼容（JSON-RPC 2.0 over stdio）
 * - 插件系统（npm 包 / 本地文件动态加载）
 * - 多 Provider 支持 (Anthropic / OpenAI Compatible / Local / Mock)
 * - 多模型智能路由（简单任务→GLM 免费，复杂任务→Claude）
 * - 流式重试机制（网络错误自动重试）
 * - 会话崩溃恢复（锁文件检测 + --resume 恢复）
 * - AI 回复代码块 ANSI 语法高亮
 * - 会话保存（/save 命令）
 * - 自动更新检查（启动时 + codex update）
 * - 独立二进制分发（构建脚本 + 启动脚本）
 * - Token 用量统计
 * - AbortSignal 支持（Ctrl+C 中断 API 请求）
 * - CODEX.md 项目规则注入
 * - 内存文件系统 + diff 颜色高亮
 * - 安全沙箱执行（命令白名单 + 危险模式检测）
 * - 结构化日志系统
 */

import { config as loadDotenv } from 'dotenv';
loadDotenv(); // 必须在所有其他 import 之前加载 .env

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink';
import React from 'react';
import { initConfig, loadConfig, getConfigDir, getProviderDisplayName } from './config/config.js';
import { loadMessages, saveMessages } from './core/message-manager.js';
import { createProvider } from './utils/ai-client.js';
import { InMemoryFileSystem } from './core/in-memory-fs.js';
import { getSessionTokenUsage, resetSessionTokenUsage } from './core/agent-loop.js';
import { createSandbox } from './sandbox/sandbox.js';
import { createLogger } from './utils/logger.js';
import { toolRegistry } from './tools/registry.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { checkForUpdates, getUpdateMessage } from './utils/auto-updater.js';
import { ChatApp } from './cli/app.jsx';
import { runTextRepl } from './cli/text-repl.js';

const logger = createLogger('index');

const VERSION = '2.0.0';

// ---- 会话锁文件（用于崩溃恢复） ----

function getLockPath(): string {
  return join(getConfigDir(), '.codex.lock');
}

function writeLock(store: { sessionId: string; messages: Array<unknown> }): void {
  const lockPath = getLockPath();
  writeFileSync(lockPath, JSON.stringify({
    sessionId: store.sessionId,
    messageCount: store.messages.length,
    timestamp: new Date().toISOString(),
  }), 'utf-8');
}

function readLock(): { sessionId: string; messageCount: number } | null {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function removeLock(): void {
  const lockPath = getLockPath();
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // 忽略清理错误
  }
}

function hasCrashedSession(): boolean {
  const lock = readLock();
  return lock !== null && lock.messageCount > 0;
}

// ---- 帮助信息 ----

const HELP_TEXT = `
Codex — 顶级 CLI AI 编程工具 v${VERSION}

用法:
  codex chat      启动对话 REPL（支持工具调用）
  codex config    配置 API Key 和模型参数
  codex update    检查更新
  codex --help    显示此帮助
  codex --version 显示版本号

功能:
  - AI 对话（流式响应）+ 并行工具执行
  - 多 Provider: Anthropic / OpenAI Compatible / Local / Mock
  - 文件操作（读取、创建、编辑）
  - 代码搜索
  - 内存文件系统（先修改后确认写入磁盘）
  - /apply  写入修改到磁盘
  - /diff   预览所有变更
  - /status 查看文件状态
  - /save   保存会话到文件
  - /clear  清除对话历史

示例:
  $ codex chat
  > 列出当前目录的文件
  > 创建一个 hello.js 文件
  > 搜索包含 "function" 的代码
`;

// ---- 子命令处理 ----

async function handleChat(): Promise<void> {
  // 初始化配置
  const config = initConfig();
  let store = loadMessages();
  const provider = createProvider(config);
  resetSessionTokenUsage();

  // 检查 CLI 参数
  const args = process.argv.slice(2);
  const providerIndex = args.indexOf('--provider');
  const forceProvider = providerIndex !== -1 ? args[providerIndex + 1] : undefined;
  const mcpIndex = args.indexOf('--mcp');
  const mcpCommand = mcpIndex !== -1 ? args[mcpIndex + 1] : undefined;
  const resumeIndex = args.indexOf('--resume');
  const forceResume = resumeIndex !== -1;

  // V1.5: 会话崩溃恢复检测
  if (hasCrashedSession() && store.messages.length > 0 && !forceResume) {
    console.log('⚠ 检测到上次会话异常退出。');
    console.log(`  上次会话 ID: ${store.sessionId}`);
    console.log(`  历史消息: ${store.messages.length} 条`);
    console.log('');
    console.log('  使用 --resume 恢复上次会话，或手动删除锁文件以跳过。');
    console.log(`  锁文件: ${getLockPath()}`);
    console.log('');
    console.log('  启动全新会话...');
    console.log('');
    // 清理旧锁，开始新会话
    removeLock();
  }

  // 写入锁文件
  writeLock(store);

  // 设置退出时清理锁文件
  const cleanup = () => {
    removeLock();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // V2.0: 启动时检查更新
  checkForUpdates(VERSION).then((info) => {
    if (info && info.hasUpdate) {
      console.log(getUpdateMessage(info));
    }
  }).catch(() => {});
  registerBuiltinTools();

  // 初始化内存文件系统
  const workingDir = process.cwd();
  const fs = new InMemoryFileSystem();
  await fs.snapshot(workingDir);

  // 初始化安全沙箱
  const sandbox = createSandbox(workingDir);

  // 加载 --mcp CLI 参数指定的 MCP Server
  if (mcpCommand) {
    try {
      const count = await toolRegistry.loadMcpTools(mcpCommand);
      console.log(`[MCP] 已加载 ${count} 个外部工具\n`);
    } catch (err) {
      logger.warn(`MCP Server 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 自动加载配置中的 MCP Servers
  if (config.mcpServers) {
    for (const server of config.mcpServers) {
      try {
        const count = await toolRegistry.loadMcpTools(server.command, server.args);
        console.log(`[MCP] 已加载 ${count} 个工具 (${server.command})\n`);
      } catch (err) {
        logger.warn(`MCP Server "${server.command}" 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 自动加载配置中的插件
  if (config.plugins) {
    for (const pluginPath of config.plugins) {
      try {
        const count = await toolRegistry.loadPlugin(pluginPath);
        console.log(`[插件] 已加载 ${count} 个工具 (${pluginPath})\n`);
      } catch (err) {
        logger.warn(`插件 "${pluginPath}" 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const displayName = forceProvider
    ? getProviderDisplayName(config)
    : '自动路由 (简单→GLM, 复杂→Claude)';

  console.log(`Codex v${VERSION} — ${displayName}`);
  console.log(`会话: ${store.sessionId} | 历史消息: ${store.messages.length} 条`);
  console.log(`工具: ${toolRegistry.size} 个已注册`);
  console.log('');

  // 非 TTY 环境回退到纯文本模式
  if (!process.stdin.isTTY) {
    await runTextRepl({
      store,
      provider,
      config,
      fs,
      workingDir,
      sandbox,
      forceProvider,
      onSave: (updated) => saveMessages(updated),
    });
    // 显示 Token 用量
    printTokenUsage();
    return;
  }

  // 渲染 Ink 应用
  const { waitUntilExit } = render(
    React.createElement(ChatApp, {
      store,
      provider,
      config,
      fs,
      workingDir,
      sandbox,
      forceProvider,
      onSave: (updated) => saveMessages(updated),
      onExit: () => {
        printTokenUsage();
        console.log('\n再见！');
      },
    }),
    {
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await waitUntilExit();
}

function printTokenUsage(): void {
  const usage = getSessionTokenUsage();
  if (usage.totalTokens > 0) {
    console.log(`[Token: 输入 ${usage.promptTokens} + 输出 ${usage.completionTokens} = ${usage.totalTokens}]`);
  }
}

function handleConfig(): void {
  const config = loadConfig();
  const configDir = getConfigDir();
  const configPath = `${configDir}/config.json`;

  console.log('Codex 配置管理');
  console.log('═'.repeat(50));
  console.log('');
  console.log(`配置文件: ${configPath}`);
  console.log(`当前 Provider: ${config.provider}`);
  console.log('');

  // Anthropic
  const ac = config.providers.anthropic;
  console.log('[Anthropic]');
  console.log(`  API Key: ${ac.apiKey ? '****' + ac.apiKey.slice(-4) : '(未设置)'}`);
  console.log(`  模型:    ${ac.model}`);
  console.log(`  最大Token: ${ac.maxTokens}`);
  console.log('');

  // OpenAI Compatible
  const oc = config.providers['openai-compatible'];
  console.log('[OpenAI Compatible]');
  console.log(`  API Key: ${oc.apiKey ? '****' + oc.apiKey.slice(-4) : '(未设置)'}`);
  console.log(`  Base URL: ${oc.baseURL}`);
  console.log(`  模型:    ${oc.model}`);
  console.log(`  最大Token: ${oc.maxTokens}`);
  console.log('');

  // Local
  const lc = config.providers.local;
  console.log('[Local / Ollama]');
  console.log(`  Base URL: ${lc.baseURL}`);
  console.log(`  模型:    ${lc.model}`);
  console.log(`  最大Token: ${lc.maxTokens}`);
  console.log('');

  console.log('环境变量优先级高于配置文件。');
  console.log('获取 GLM API Key: https://open.bigmodel.cn/');
  console.log('获取 Anthropic API Key: https://console.anthropic.com/');
  console.log('');

  if (config.provider === 'mock') {
    console.log('⚠ 当前为 Mock 模式（模拟回复）。');
    console.log('在 .env 文件中设置 GLM_API_KEY 或 ANTHROPIC_API_KEY 以启用真实 AI。');
    console.log('');
  }
}

function handleHelp(): void {
  console.log(HELP_TEXT);
}

async function handleUpdate(): Promise<void> {
  console.log('正在检查更新...');
  const info = await checkForUpdates(VERSION);

  if (!info) {
    console.log('无法检查更新，请检查网络连接。');
    console.log('访问 https://github.com/codex-ai/codex/releases 手动查看。');
    return;
  }

  if (info.hasUpdate) {
    console.log(getUpdateMessage(info));
  } else {
    console.log(`Codex v${VERSION} 已是最新版本。`);
  }
}

// ---- 主入口 ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  switch (subcommand) {
    case 'chat':
      await handleChat();
      break;
    case 'config':
      handleConfig();
      break;
    case 'update':
      await handleUpdate();
      break;
    case '--help':
    case '-h':
      handleHelp();
      break;
    case '--version':
    case '-v':
      console.log(`Codex v${VERSION}`);
      break;
    default:
      if (!subcommand || subcommand.startsWith('-')) {
        await handleChat();
      } else {
        console.log(`未知命令: ${subcommand}`);
        handleHelp();
        process.exit(1);
      }
  }
}

main().catch((err) => {
  logger.error('Codex 启动失败:', err);
  process.exit(1);
});