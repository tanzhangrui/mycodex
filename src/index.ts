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

import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { render } from 'ink';
import React from 'react';
import { initConfig, loadConfig, saveConfig, getConfigDir, getProviderDisplayName } from './config/config.js';
import { loadMessages, saveMessages } from './core/message-manager.js';
import { createProvider } from './utils/ai-client.js';
import { InMemoryFileSystem } from './core/in-memory-fs.js';
import { getSessionTokenUsage, resetSessionTokenUsage } from './core/agent-loop.js';
import { createSandbox } from './sandbox/sandbox.js';
import { createLogger } from './utils/logger.js';
import { toolRegistry } from './tools/registry.js';
import { ContextEngine } from './context/context-engine.js';
import { registerBuiltinTools } from './tools/builtin.js';
import {
  loadMarketplaceIndex,
  loadMarketplaceIndexFromUrl,
  findEntry,
  installPlugin,
  updatePlugin,
  updateAllPlugins,
  searchEntries,
  compareVersions,
} from './tools/marketplace.js';
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
  codex doctor    环境体检（配置 / 运行时 / 插件健康）
  codex plugin    插件市场（list / search / install / update / outdated / remove）
  codex context   上下文引擎（stats — 索引/缓存/召回体检）
  codex --help    显示此帮助
  codex --version 显示版本号

多仓库工作区:
  codex chat --workspace <目录1>,<目录2>   多根模式（跨仓检索，首根为主根）
  codex context stats <目录1> <目录2>      多根索引体检

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
  const workspaceIndex = args.indexOf('--workspace');
  const workspaceArg = workspaceIndex !== -1 ? args[workspaceIndex + 1] : undefined;

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

  // V5.1 工作目录：--workspace a,b 多根（首根为主根）；缺省 cwd 单根
  let workingDir: string | string[] = process.cwd();
  if (workspaceArg) {
    const roots = workspaceArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolve(s));
    if (roots.length === 0) {
      console.error('错误: --workspace 参数为空（格式: --workspace <目录1>,<目录2>）');
      process.exit(1);
    }
    const invalid = roots.filter((r) => !existsSync(r) || !statSync(r).isDirectory());
    if (invalid.length > 0) {
      console.error(`错误: 以下工作区根不存在或不是目录:\n  ${invalid.join('\n  ')}`);
      process.exit(1);
    }
    workingDir = roots;
    console.log(`[工作区] 多根模式（${roots.length} 个根，主根: ${roots[0]}）`);
  }

  // 初始化内存文件系统（多根快照：绝对路径键，跨根无冲突）
  const fs = new InMemoryFileSystem();
  await fs.snapshot(workingDir);

  // 初始化安全沙箱（以主根为 cwd）
  const sandbox = createSandbox(Array.isArray(workingDir) ? workingDir[0] : workingDir);

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

  // 自动加载配置中的插件（批量隔离：单插件失败不拖累其他）
  if (config.plugins && config.plugins.length > 0) {
    const results = await toolRegistry.loadPlugins(config.plugins);
    for (const r of results) {
      if (r.error) {
        console.log(`[插件] 加载失败 (${r.path}): ${r.error}\n`);
      } else {
        console.log(`[插件] 已加载 ${r.count} 个工具 (${r.path})\n`);
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

// ---- V5.1 插件市场命令 ----

/** 默认市场索引路径：当前目录 marketplace.json */
const DEFAULT_MARKETPLACE = 'marketplace.json';

async function handlePlugin(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  // 解析 --index <path|url>（默认 ./marketplace.json；V5.11 支持 https 远程索引）
  const idxFlag = rest.indexOf('--index');
  const indexArg = idxFlag !== -1 ? rest[idxFlag + 1] : undefined;
  const indexFile = indexArg ?? DEFAULT_MARKETPLACE;

  /** V5.11 双源索引加载：https:// → 远程拉取；其余 → 本地文件 */
  const loadIndex = () =>
    indexFile.startsWith('https://')
      ? loadMarketplaceIndexFromUrl(indexFile)
      : Promise.resolve(loadMarketplaceIndex(indexFile));

  if (sub === 'list') {
    const loaded = await loadIndex();
    if (!loaded) {
      console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
      process.exit(1);
    }
    const installed = new Set(loadConfig().plugins ?? []);
    console.log(`市场索引: ${indexFile}（${loaded.index.plugins.length} 个插件）`);
    console.log('');
    for (const p of loaded.index.plugins) {
      // V5.5 双源：file → 本地路径；url → https 远程（sha256 pin）
      const pluginPath =
        p.source.kind === 'url'
          ? undefined
          : isAbsolute(p.source.path)
            ? p.source.path
            : resolve(loaded.baseDir, p.source.path);
      const mark = pluginPath && installed.has(pluginPath) ? ' [已安装]' : '';
      const desc = p.description ? ` — ${p.description}` : '';
      console.log(`  ${p.name}@${p.version}${mark}${desc}`);
      console.log(p.source.kind === 'url' ? `    源: ${p.source.url}（sha256 pin）` : `    源: ${p.source.path}`);
    }
    return;
  }

  if (sub === 'install') {
    // 名称 = rest 中去掉 --index 及其值后的首个参数
    const positional = rest.filter((a, i) => a !== '--index' && rest[i - 1] !== '--index');
    const name = positional[0];
    if (!name) {
      console.error('用法: codex plugin install <名称> [--index <索引路径>]');
      process.exit(1);
    }

    const loaded = await loadIndex();
    if (!loaded) {
      console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
      process.exit(1);
    }

    const entry = findEntry(loaded, name);
    if (!entry) {
      console.error(`错误: 索引中未找到插件 "${name}"`);
      console.error(`可用插件: ${loaded.index.plugins.map((p) => p.name).join(', ') || '（无）'}`);
      process.exit(1);
    }

    registerBuiltinTools();
    const result = await installPlugin(loaded, entry, toolRegistry);
    if (!result.success) {
      console.error(`安装失败 (${result.name}): ${result.detail}`);
      process.exit(1);
    }

    console.log(`✔ ${result.name}: ${result.detail}`);
    console.log(`  路径: ${result.pluginPath}`);

    // 常驻：写入 config.plugins（下次启动自动加载）；已在配置中则跳过
    const config = loadConfig();
    if (result.pluginPath && !(config.plugins ?? []).includes(result.pluginPath)) {
      config.plugins = [...(config.plugins ?? []), result.pluginPath];
      saveConfig(config);
      console.log('  已写入配置（下次启动自动加载）');
    }
    return;
  }

  if (sub === 'outdated') {
    const config = loadConfig();
    const pluginPaths = config.plugins ?? [];
    if (pluginPaths.length === 0) {
      console.log('当前配置中没有常驻插件。');
      return;
    }

    const loaded = await loadIndex();
    if (!loaded) {
      console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
      process.exit(1);
    }

    // 加载全部已装插件以读取真实版本号（name@version）
    registerBuiltinTools();
    await toolRegistry.loadPlugins(pluginPaths);

    let outdatedCount = 0;
    for (const id of toolRegistry.loadedPluginIds) {
      const [pname, pver] = [id.split('@')[0], id.split('@').slice(1).join('@')];
      const entry = findEntry(loaded, pname);
      if (!entry) {
        console.log(`  ${id} — 索引中无此插件（无更新来源）`);
        continue;
      }
      const cmp = compareVersions(pver, entry.version);
      if (cmp < 0) {
        outdatedCount++;
        console.log(`  ${pname}: ${pver} → ${entry.version}（可更新，codex plugin update ${pname}）`);
      } else if (cmp === 0) {
        console.log(`  ${pname}: ${pver}（最新）`);
      } else {
        console.log(`  ${pname}: ${pver}（比索引 ${entry.version} 更新）`);
      }
    }
    if (outdatedCount === 0) console.log('全部插件均为最新。');
    return;
  }

  if (sub === 'search') {
    const positional = rest.filter((a, i) => a !== '--index' && rest[i - 1] !== '--index');
    const query = positional.join(' ');
    if (!query.trim()) {
      console.error('用法: codex plugin search <关键词> [--index <索引路径>]');
      process.exit(1);
    }

    const loaded = await loadIndex();
    if (!loaded) {
      console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
      process.exit(1);
    }

    const results = searchEntries(loaded, query);
    if (results.length === 0) {
      console.log(`未找到匹配 "${query}" 的插件（共检索 ${loaded.index.plugins.length} 个）。`);
      return;
    }
    console.log(`匹配 "${query}" 的插件（${results.length}/${loaded.index.plugins.length}）：`);
    console.log('');
    for (const p of results) {
      const desc = p.description ? ` — ${p.description}` : '';
      console.log(`  ${p.name}@${p.version}${desc}`);
      console.log(p.source.kind === 'url' ? `    源: ${p.source.url}（sha256 pin）` : `    源: ${p.source.path}`);
    }
    return;
  }

  if (sub === 'update') {
    const positional = rest.filter((a, i) => a !== '--index' && rest[i - 1] !== '--index');
    const name = positional[0];
    if (!name) {
      console.error('用法: codex plugin update <名称> [--index <索引路径>]');
      process.exit(1);
    }

    // V5.12 批量升级：update --all
    if (name === '--all' || name === '-a') {
      const config = loadConfig();
      const pluginPaths = config.plugins ?? [];
      if (pluginPaths.length === 0) {
        console.log('当前配置中没有常驻插件。');
        return;
      }

      const loaded = await loadIndex();
      if (!loaded) {
        console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
        process.exit(1);
      }

      // 加载全部已装插件以读取真实版本号（name@version）
      registerBuiltinTools();
      await toolRegistry.loadPlugins(pluginPaths);

      const installed = toolRegistry.loadedPluginIds.map((id) => {
        const pname = id.split('@')[0];
        return {
          name: pname,
          version: id.split('@').slice(1).join('@'),
          paths: pluginPaths.filter(
            (p) => p === pname || basename(p).replace(/\.\w+$/, '') === pname || p.includes(pname),
          ),
        };
      });

      const summary = await updateAllPlugins(loaded, toolRegistry, installed);

      for (const u of summary.updated) {
        console.log(`✔ ${u.name}: ${u.from} → ${u.to}`);
      }
      for (const n of summary.upToDate) {
        console.log(`= ${n}: 已是最新`);
      }
      for (const n of summary.noSource) {
        console.log(`- ${n}: 索引中无此插件（跳过）`);
      }
      for (const f of summary.failed) {
        console.error(`× ${f.name}: ${f.detail}`);
      }

      // 配置原子替换：移除全部旧路径 + 写入新路径
      if (summary.updated.length > 0) {
        const allRemoved = summary.updated.flatMap((u) => u.removedPaths);
        if (allRemoved.length > 0) {
          config.plugins = (config.plugins ?? []).filter((p) => !allRemoved.includes(p));
        }
        for (const u of summary.updated) {
          if (u.pluginPath && !(config.plugins ?? []).includes(u.pluginPath)) {
            config.plugins = [...(config.plugins ?? []), u.pluginPath];
          }
        }
        saveConfig(config);
        console.log(`已升级 ${summary.updated.length} 个插件，配置已更新（下次启动自动加载新版）`);
      } else {
        console.log('没有可升级的插件。');
      }
      if (summary.failed.length > 0) process.exit(1);
      return;
    }

    const loaded = await loadIndex();
    if (!loaded) {
      console.error(`错误: 无法加载市场索引 ${indexFile}（文件不存在或格式非法）`);
      process.exit(1);
    }

    const entry = findEntry(loaded, name);
    if (!entry) {
      console.error(`错误: 索引中未找到插件 "${name}"`);
      console.error(`可用插件: ${loaded.index.plugins.map((p) => p.name).join(', ') || '（无）'}`);
      process.exit(1);
    }

    const config = loadConfig();
    // 名称匹配规则与 remove 一致（插件名 / basename / 路径包含）
    const currentPaths = (config.plugins ?? []).filter(
      (p) => p === name || basename(p).replace(/\.\w+$/, '') === name || p.includes(name),
    );
    if (currentPaths.length === 0) {
      console.error(`错误: 插件 "${name}" 尚未安装（请先 codex plugin install ${name}）`);
      process.exit(1);
    }

    registerBuiltinTools();
    // 先加载旧版，让运行时状态与真实启动一致（卸旧才有对象）
    await toolRegistry.loadPlugins(currentPaths);
    // V5.9 版本感知：从已加载插件读取当前版本（name@version）
    const loadedId = toolRegistry.loadedPluginIds.find((id) => id.split('@')[0] === name);
    const currentVersion = loadedId?.split('@').slice(1).join('@');
    const result = await updatePlugin(loaded, entry, toolRegistry, currentPaths, undefined, currentVersion);
    if (!result.success) {
      console.error(`更新失败 (${result.name}): ${result.detail}`);
      process.exit(1);
    }

    // V5.9 已是最新：零变更直接返回
    if (result.upToDate) {
      console.log(`✔ ${result.name}: ${result.detail}`);
      return;
    }

    console.log(`✔ ${result.name}: ${result.detail}`);
    console.log(`  路径: ${result.pluginPath}`);

    // 配置原子更新：移除旧路径 + 写入新路径
    if (result.removedPaths.length > 0) {
      config.plugins = (config.plugins ?? []).filter((p) => !result.removedPaths.includes(p));
    }
    if (result.pluginPath && !(config.plugins ?? []).includes(result.pluginPath)) {
      config.plugins = [...(config.plugins ?? []), result.pluginPath];
    }
    saveConfig(config);
    console.log('  配置已更新（下次启动自动加载新版）');
    return;
  }

  if (sub === 'remove' || sub === 'uninstall') {
    const positional = rest.filter((a, i) => a !== '--index' && rest[i - 1] !== '--index');
    const name = positional[0];
    if (!name) {
      console.error('用法: codex plugin remove <名称>');
      process.exit(1);
    }

    const config = loadConfig();
    const plugins = config.plugins ?? [];
    if (plugins.length === 0) {
      console.error('当前配置中没有常驻插件。');
      process.exit(1);
    }

    // 名称匹配：插件名（basename 去扩展名）或路径包含
    const matches = plugins.filter(
      (p) => p === name || basename(p).replace(/\.\w+$/, '') === name || p.includes(name),
    );
    if (matches.length === 0) {
      console.error(`错误: 未找到匹配 "${name}" 的已配置插件`);
      console.error(`已配置: ${plugins.join(', ')}`);
      process.exit(1);
    }

    config.plugins = plugins.filter((p) => !matches.includes(p));
    saveConfig(config);

    // 运行中卸载（本进程内注册过的插件同步移除工具）
    registerBuiltinTools();
    const removedTools = toolRegistry.unloadPlugin(name);

    for (const p of matches) {
      console.log(`✔ 已从配置移除: ${p}`);
    }
    if (removedTools > 0) {
      console.log(`  运行时已卸载 ${removedTools} 个工具`);
    }
    return;
  }

  console.error('用法:');
  console.error('  codex plugin list [--index <路径|https URL>]      列出市场索引中的插件');
  console.error('  codex plugin search <关键词> [--index <路径|URL>] 按关键词搜索插件');
  console.error('  codex plugin install <名称> [--index <路径|URL>]  安装插件并写入配置常驻');
  console.error('  codex plugin update <名称|--all> [--index <…>]   升级插件（已是最新则跳过）');
  console.error('  codex plugin outdated [--index <路径|URL>]       检查已装插件的可更新项');
  console.error('  codex plugin remove <名称>                       移除常驻插件（配置 + 运行时）');
  console.error('索引源：本地文件路径或 https URL（远程索引，V5.11）');
  process.exit(sub ? 1 : 0);
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

/**
 * V5.14 环境体检：配置 / 运行时 / 插件健康逐项检查。
 * 全部通过退出码 0；有问题退出码 1（CI 可感知）。
 * 不做真实网络调用（provider 连通性由实际对话验证，体检只查本地可判定项）。
 */
async function handleDoctor(): Promise<void> {
  console.log(`Codex v${VERSION} 环境体检`);
  console.log('');
  let failures = 0;
  const ok = (msg: string) => console.log(`  ✔ ${msg}`);
  const fail = (msg: string, hint?: string) => {
    failures++;
    console.log(`  × ${msg}`);
    if (hint) console.log(`    → ${hint}`);
  };

  // 1) Provider 配置
  const config = loadConfig();
  console.log('[Provider]');
  if (config.provider === 'mock') {
    ok('mock provider（测试用，无需 API key）');
  } else {
    const apiKey =
      config.provider === 'anthropic'
        ? config.providers.anthropic.apiKey
        : config.provider === 'openai-compatible'
          ? config.providers['openai-compatible'].apiKey
          : ''; // local 无 key
    if (config.provider === 'local' || apiKey) {
      ok(`${getProviderDisplayName(config)}`);
      if (config.provider !== 'local' && !apiKey) fail('不应到达');
    } else {
      fail(`${config.provider} provider 缺少 API key`, '运行 codex config 或设置对应环境变量');
    }
  }

  // 2) 环境变量覆盖提示
  console.log('[环境变量]');
  const envVars: Array<[string, string]> = [
    ['ANTHROPIC_API_KEY', 'Anthropic key 覆盖'],
    ['GLM_API_KEY', 'GLM key 覆盖'],
    ['ANTHROPIC_MODEL', 'Anthropic 模型覆盖'],
    ['GLM_MODEL', 'GLM 模型覆盖'],
    ['OLLAMA_MODEL', 'Ollama 模型覆盖'],
    ['CODEX_CONFIG_PATH', '配置目录覆盖'],
  ];
  let envHits = 0;
  for (const [key, desc] of envVars) {
    if (process.env[key]) {
      ok(`${desc}: ${key} 已设置`);
      envHits++;
    }
  }
  if (envHits === 0) ok('无环境变量覆盖（使用配置文件）');

  // 3) Node 运行时（fetch 需 18+）
  console.log('[运行时]');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 18) ok(`Node ${process.versions.node}（fetch 可用）`);
  else fail(`Node ${process.versions.node} 过旧`, '升级到 Node 18+（远程索引/插件下载依赖 fetch）');

  // 4) 配置目录可写（目录由 initConfig/saveConfig 懒创建——体检时确保存在）
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-probe-${Date.now()}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    ok(`配置目录可写: ${dir}`);
  } catch (err) {
    fail(`配置目录不可写: ${getConfigDir()}`, err instanceof Error ? err.message : String(err));
  }

  // 5) 插件健康：逐路径存在性 + 加载结果
  console.log('[插件]');
  const pluginPaths = config.plugins ?? [];
  if (pluginPaths.length === 0) {
    ok('无常驻插件');
  } else {
    for (const p of pluginPaths) {
      if (!existsSync(p)) {
        fail(`插件文件不存在: ${p}`, '路径已失效，codex plugin remove 移除或重新安装');
      }
    }
    registerBuiltinTools();
    const results = await toolRegistry.loadPlugins(pluginPaths);
    for (const r of results) {
      if (r.error) fail(`插件加载失败: ${basename(r.path)}`, r.error);
      else ok(`${basename(r.path)}（${r.count} 个工具）`);
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('体检结果: 全部通过 ✔');
  } else {
    console.log(`体检结果: ${failures} 项待修复`);
    process.exit(1);
  }
}

// ---- V5.18 上下文引擎体检 ----

/**
 * `codex context stats [目录...]`
 * 索引/缓存/召回体检：多根元数据、文件与符号规模、import 边、别名表、
 * 持久化缓存命中状态（版本/结构指纹/种子数）、符号 top-5 文件。
 * 目录参数缺省 cwd；多个目录 = 多根工作区。
 */
async function handleContext(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'stats') {
    console.log('用法: codex context stats [目录...]（缺省当前目录；多目录 = 多根工作区）');
    return;
  }

  const targets = args.slice(1).filter((a) => !a.startsWith('-'));
  const workingDir: string | string[] =
    targets.length > 1 ? targets.map((t) => resolve(t)) : resolve(targets[0] ?? '.');

  console.log(`Codex v${VERSION} 上下文引擎体检`);
  console.log('');
  let warnings = 0;
  const warn = (msg: string, hint?: string) => {
    warnings++;
    console.log(`  ! ${msg}`);
    if (hint) console.log(`    → ${hint}`);
  };

  const engine = new ContextEngine();
  try {
    await engine.index(workingDir);
  } catch (err) {
    console.error(`错误: 索引失败 — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const report = engine.getContextReport();

  // 1) 工作区
  console.log('[工作区]');
  console.log(`  模式: ${report.mode === 'multi' ? '多根' : '单根'}`);
  for (const root of report.roots) {
    console.log(`  - ${root.name}（${root.fileCount} 文件） ${root.abs}`);
  }

  // 2) 索引
  console.log('[索引]');
  console.log(`  文件总数: ${report.fileCount}（源码 ${report.sourceFileCount}）`);
  console.log(`  符号数: ${report.symbolCount}`);
  console.log(`  import 边: ${report.importEdgeCount}`);
  console.log(`  懒加载模式: ${report.lazy ? '是（大仓库，内容按需读取）' : '否'}`);
  if (report.sourceFileCount === 0) {
    warn('未发现源码文件（.ts/.tsx/.js/.jsx/.mjs/.cjs/.py）', '上下文召回依赖源码索引');
  }

  // 3) 别名
  console.log('[别名]');
  console.log(`  包名别名（跨根互引）: ${report.packageAliasCount} 条`);
  console.log(`  tsconfig paths 别名: ${report.pathAliasCount} 条`);

  // 4) 持久化缓存
  console.log('[持久化缓存]');
  if (report.persisted) {
    const p = report.persisted;
    console.log(`  缓存版本: v${p.version}${p.savedAt ? `（保存于 ${p.savedAt}）` : ''}`);
    console.log(`  符号种子: ${p.symbolSeeds} 文件`);
    if (p.version >= 2) {
      console.log(
        p.structureOk
          ? `  import 种子: ${p.importSeeds} 文件（结构指纹一致）`
          : `  import 种子: 0（结构指纹失配，已弃用重解析）`,
      );
      if (!p.structureOk) {
        warn('缓存结构指纹与当前工作区不一致', '文件集或别名清单（package.json/tsconfig）变化后属预期行为，下次对话自动重建');
      }
    } else {
      console.log('  import 种子: 不适用（v1 缓存无 imports；对话后自动升级为 v2）');
    }
  } else {
    console.log('  无缓存（首次索引此工作区）');
  }

  // 5) 规则
  console.log('[规则]');
  console.log(`  规则文件: ${report.ruleCount} 条（项目级 CODEX.md 每根独立 + 用户级）`);

  // 6) 符号 top-5
  if (report.topFiles.length > 0) {
    console.log('[符号数 top-5]');
    for (const f of report.topFiles) {
      console.log(`  ${f.path} — ${f.symbols} 符号（${(f.size / 1024).toFixed(1)}KB）`);
    }
  }

  console.log('');
  console.log(warnings === 0 ? '体检结果: 全部正常 ✔' : `体检结果: ${warnings} 项提示`);
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
    case 'doctor':
      await handleDoctor();
      break;
    case 'plugin':
      await handlePlugin(args.slice(1));
      break;
    case 'context':
      await handleContext(args.slice(1));
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