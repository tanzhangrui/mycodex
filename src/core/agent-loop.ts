/**
 * V1.3 — Agent 循环调度器
 * ==========================================
 *
 * 新特性：
 * - 并行工具执行：收集所有 tool_use 后批量并行执行
 * - Token 用量统计
 * - AbortSignal 支持
 * - CODEX.md 项目规则注入
 *
 * 调用签名：
 *   runAgentLoop(provider, messages, fs, workingDir, callbacks, signal?)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { AIProvider } from '../utils/ai-client.js';
import { TOOL_SYSTEM_PROMPT } from '../utils/ai-client.js';
import { toolRegistry, type ToolContext } from '../tools/registry.js';
import type { InMemoryFileSystem } from './in-memory-fs.js';
import type { Message } from './message-manager.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import { createCommandExecutor, createCodeExecutor } from '../sandbox/sandbox.js';
import { runSubAgents, type SubAgentTask } from './sub-agent.js';
import { getSharedContextEngine } from '../context/context-engine.js';

// ---- 类型定义 ----

/**
 * V5.1 工作目录统一类型：单根（string，旧行为）或多根工作区（string[]，首根为主根）。
 * 多根时上下文引擎跨根召回；工具/沙箱/验证以主根为基准。
 */
export type WorkingDirInput = string | string[];

/** 从 WorkingDirInput 推导主根绝对路径（工具相对路径基准 / 沙箱 cwd / 规则文件位置） */
export function primaryRootOf(workingDir: WorkingDirInput): string {
  return Array.isArray(workingDir) ? resolve(workingDir[0]) : workingDir;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void;
  onToolUse: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, success: boolean, output: string) => void;
  onError: (message: string) => void;
  onDone: (fullText: string) => void;
}

export interface AgentLoopResult {
  text: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    success: boolean;
    output: string;
  }>;
  hasError: boolean;
  error?: string;
  tokenUsage: TokenUsage;
}

const MAX_TOOL_LOOPS = 10;

// ---- CODEX.md 项目规则加载 ----

/**
 * 加载项目规则文件
 * 优先级：项目级 CODEX.md > 用户级 ~/.codex/CODEX.md
 * V5.17：多根工作区逐根加载 CODEX.md（标注根名，Agent 可区分规则归属根）；
 * 单根行为与旧版完全一致（标签无根名）。
 */
export function loadCodexRules(workingDir: WorkingDirInput): string {
  const rules: string[] = [];

  // 1. 项目级 CODEX.md（多根：每根独立）
  const roots = Array.isArray(workingDir) ? workingDir : [workingDir];
  for (let i = 0; i < roots.length; i++) {
    const rootAbs = resolve(roots[i]);
    const label =
      Array.isArray(workingDir) && roots.length > 1 ? `CODEX.md（${basename(rootAbs)}）` : 'CODEX.md';
    const projectRulesPath = join(rootAbs, 'CODEX.md');
    if (existsSync(projectRulesPath)) {
      try {
        const content = readFileSync(projectRulesPath, 'utf-8').trim();
        if (content) {
          rules.push(`[项目规则 — ${label}]\n${content}`);
        }
      } catch {
        // 读取失败，忽略
      }
    }
  }

  // 2. 用户级 CODEX.md
  const userRulesPath = join(process.env.HOME || process.env.USERPROFILE || '~', '.codex', 'CODEX.md');
  if (existsSync(userRulesPath)) {
    try {
      const content = readFileSync(userRulesPath, 'utf-8').trim();
      if (content) {
        rules.push(`[用户规则 — ~/.codex/CODEX.md]\n${content}`);
      }
    } catch {
      // 读取失败，忽略
    }
  }

  return rules.join('\n\n');
}

/**
 * 构建包含项目规则与相关上下文的系统提示词。
 * V3.2：注入上下文引擎召回（符号定义处 / 关键词窗口 / import 图扩展）的结果，
 * V3.4：召回升级为四路（新增 n-gram token 覆盖率语义召回），并先做增量刷新。
 * V5.1：workingDir 支持多根（string[]）——引擎跨根召回，规则文件取主根。
 * V5.15：cwd 传入 assembleContext——召回按用户当前所在目录邻近加权排序。
 * 引擎失败静默降级，绝不阻断主循环。
 */
function buildSystemPrompt(workingDir: WorkingDirInput, userQuery: string, sessionCwd?: string): string {
  const parts: string[] = [TOOL_SYSTEM_PROMPT];

  const rules = loadCodexRules(workingDir);
  if (rules) {
    parts.push(`<project_rules>\n${rules}\n</project_rules>`);
  }

  // V3.2/V3.4 上下文引擎：自动检索与查询最相关的代码（8K token 预算）
  const engine = getSharedContextEngine(workingDir);
  if (engine) {
    try {
      // V3.4 增量刷新：Agent 上一轮编辑过的文件本轮即生效（stat-only，便宜）
      engine.refresh();
      // V5.15 会话 cwd → 键空间路径（越界/未提供 → 不加权，行为与旧版一致）
      let cwdKey: string | undefined;
      if (sessionCwd) {
        const key = engine.absToKey(sessionCwd);
        if (key) cwdKey = key || undefined; // 单根根目录本身（''）不加权
      }
      const chunks = engine.assembleContext(userQuery, { maxTokens: 8_000, cwd: cwdKey });
      if (chunks.length > 0) {
        const ctx = chunks
          .map((c) => `[${c.path}:${c.startLine}-${c.endLine}]\n\`\`\`\n${c.content}\n\`\`\``)
          .join('\n\n');
        parts.push(
          `<project_context>\n以下是与本次任务最相关的代码片段（由符号索引、语义检索与依赖图自动检索，仅供参考，以工具读取的实时内容为准）：\n\n${ctx}\n</project_context>`,
        );
      }
    } catch {
      // 上下文引擎失败不阻断 Agent 主循环
    }
  }

  return parts.join('\n\n');
}

// ---- 累积 Token 用量 ----

const sessionTokenUsage: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function getSessionTokenUsage(): TokenUsage {
  return { ...sessionTokenUsage };
}

export function resetSessionTokenUsage(): void {
  sessionTokenUsage.promptTokens = 0;
  sessionTokenUsage.completionTokens = 0;
  sessionTokenUsage.totalTokens = 0;
}

/**
 * 执行 Agent 循环
 *
 * @param provider   AI Provider 实例
 * @param messages   消息历史
 * @param fs         内存文件系统
 * @param workingDir 工作目录（V5.1：单根 string 或多根 string[]，工具以主根为基准）
 * @param callbacks  回调钩子
 * @param signal     可选的 AbortSignal 用于取消
 */
export async function runAgentLoop(
  provider: AIProvider,
  messages: Message[],
  fs: InMemoryFileSystem,
  workingDir: WorkingDirInput,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  sandbox?: Sandbox,
): Promise<AgentLoopResult> {
  const toolCalls: AgentLoopResult['toolCalls'] = [];
  let fullText = '';
  let hasError = false;
  let errorMsg = '';
  const loopTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const conversationMessages: Message[] = [...messages];

  // 构建工具上下文（多根时工具相对路径以主根为基准）
  const toolContext: ToolContext = {
    workingDir: primaryRootOf(workingDir),
    readFile: (path) => fs.read(path),
    writeFile: (path, content) => fs.write(path, content),
    listFiles: (dir, depth) => fs.list(dir, depth),
    searchContent: (pattern, path, glob) => fs.search(pattern, path, glob),
    confirm: async () => true,
    executeCommand: sandbox ? createCommandExecutor(sandbox) : undefined,
    executeCode: sandbox ? createCodeExecutor(sandbox) : undefined,
  };

  const toolDefs = toolRegistry.getAllDefinitions();

  // V3.2：以最后一条用户消息作为上下文检索的查询
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userQuery = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const systemPrompt = buildSystemPrompt(workingDir, userQuery, process.cwd());

  // 创建 AbortController 用于传递 signal 给 provider
  const abortController = new AbortController();
  const effectiveSignal = signal || abortController.signal;
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  // Agent 循环
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    if (signal?.aborted) break;

    let hasToolUse = false;

    const apiMessages = conversationMessages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const stream = provider.streamWithTools(apiMessages as Message[], systemPrompt, toolDefs, effectiveSignal);

    // 收集本轮所有 tool_use 事件
    const pendingToolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    for await (const event of stream) {
      if (signal?.aborted) break;

      switch (event.type) {
        case 'text_delta':
          fullText += event.text;
          callbacks.onTextDelta(event.text);
          break;

        case 'tool_use':
          hasToolUse = true;
          pendingToolUses.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
          callbacks.onToolUse(event.name, event.input);
          break;

        case 'token_usage':
          loopTokenUsage.promptTokens += event.usage.promptTokens;
          loopTokenUsage.completionTokens += event.usage.completionTokens;
          loopTokenUsage.totalTokens += event.usage.totalTokens;
          break;

        case 'error':
          hasError = true;
          errorMsg = event.message;
          callbacks.onError(event.message);
          break;

        case 'done':
          break;
      }
    }

    if (signal?.aborted) break;

    // 并行执行所有收集到的 tool_use
    if (pendingToolUses.length > 0) {
      // V1.4: tool_use > 5 时使用子 Agent 委派模式
      const useSubAgent = pendingToolUses.length > 5;

      if (useSubAgent) {
        // 子 Agent 委派模式
        const tasks: SubAgentTask[] = pendingToolUses.map((tu, i) => ({
          id: `sub_${i}`,
          description: `执行工具: ${tu.name}`,
          toolName: tu.name,
          toolParams: tu.input,
        }));

        const subResults = await runSubAgents(
          tasks,
          async (name, params) => {
            const result = await toolRegistry.execute(name, params, toolContext);
            return { success: result.success, output: result.output, error: result.error };
          },
        );

        // 按原始顺序处理结果
        for (let i = 0; i < pendingToolUses.length; i++) {
          const tu = pendingToolUses[i];
          const sr = subResults[i];
          toolCalls.push({
            name: tu.name,
            input: tu.input,
            success: sr.success,
            output: sr.output,
          });

          callbacks.onToolResult(tu.name, sr.success, sr.output);

          const toolResultContent = sr.success
            ? `工具 ${tu.name} 执行成功:\n${sr.output}`
            : `工具 ${tu.name} 执行失败: ${sr.error || '未知错误'}`;

          conversationMessages.push({
            role: 'assistant' as const,
            content: `[tool_use: ${tu.name}]`,
            timestamp: new Date().toISOString(),
          });
          conversationMessages.push({
            role: 'user' as const,
            content: `[tool_result id=${tu.id}]\n${toolResultContent}`,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        // 标准并行执行模式
        const results = await Promise.all(
          pendingToolUses.map(async (tu) => {
            const result = await toolRegistry.execute(tu.name, tu.input, toolContext);
            return { ...tu, result };
          }),
        );

        // 按原始顺序处理结果
        for (const { id, name, input, result } of results) {
          toolCalls.push({
            name,
            input,
            success: result.success,
            output: result.output,
          });

          callbacks.onToolResult(name, result.success, result.output);

          const toolResultContent = result.success
            ? `工具 ${name} 执行成功:\n${result.output}`
            : `工具 ${name} 执行失败: ${result.error || '未知错误'}`;

          conversationMessages.push({
            role: 'assistant' as const,
            content: `[tool_use: ${name}]`,
            timestamp: new Date().toISOString(),
          });
          conversationMessages.push({
            role: 'user' as const,
            content: `[tool_result id=${id}]\n${toolResultContent}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    if (!hasToolUse) break;
  }

  // 累积到会话总计
  sessionTokenUsage.promptTokens += loopTokenUsage.promptTokens;
  sessionTokenUsage.completionTokens += loopTokenUsage.completionTokens;
  sessionTokenUsage.totalTokens += loopTokenUsage.totalTokens;

  callbacks.onDone(fullText);

  return {
    text: fullText,
    toolCalls,
    hasError,
    error: errorMsg || undefined,
    tokenUsage: loopTokenUsage,
  };
}