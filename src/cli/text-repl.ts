/**
 * V0.2 — 纯文本模式 REPL（非 TTY 回退）
 * ==========================================
 * 新增 Agent 循环支持
 */

import { createInterface } from 'node:readline';
import type { MessageStore } from '../core/message-manager.js';
import { addMessage, saveSessionToFile } from '../core/message-manager.js';
import type { AIProvider } from '../utils/ai-client.js';
import { InMemoryFileSystem } from '../core/in-memory-fs.js';
import { runAgentLoop, type AgentCallbacks } from '../core/agent-loop.js';
import { runPlannedTask } from '../core/orchestrator.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import type { CodexConfig } from '../config/config.js';
import { highlightCodeBlocks } from '../utils/highlight.js';
import { routeProvider } from '../core/model-router.js';

export interface TextReplOptions {
  store: MessageStore;
  provider: AIProvider;
  config: CodexConfig;
  fs: InMemoryFileSystem;
  workingDir: string;
  sandbox?: Sandbox;
  forceProvider?: string;
  onSave: (store: MessageStore) => void;
}

export async function runTextRepl(options: TextReplOptions): Promise<void> {
  let store = options.store;
  const { config, fs, workingDir, sandbox, forceProvider, onSave } = options;

  // 注册工具
  registerBuiltinTools();

  console.log('Codex v2.0.0 — 纯文本模式');
  console.log(`会话: ${store.sessionId} | 历史消息: ${store.messages.length} 条`);
  console.log(`文件系统: ${fs.isDirty() ? '有未保存修改' : '已同步'}`);
  console.log('输入消息后按 Enter 发送，/exit 退出');
  console.log('命令: /apply, /diff, /status, /save, /clear, /plan <任务>, /exit');
  console.log('');

  // 收集所有输入行（支持管道输入）
  const inputs: string[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // 先收集所有输入
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      inputs.push(line.trim());
    });
    rl.on('close', () => {
      resolve();
    });
    // 如果 stdin 已经结束（如管道），直接 resolve
    if (process.stdin.readableEnded) {
      resolve();
    }
  });

  // 流式输出回调工厂（普通消息与 /plan 共用；闭包维护增量高亮状态）
  function createCallbacks(): { callbacks: AgentCallbacks; getText: () => string } {
    let fullText = '';
    let lastHighlightedLength = 0;

    const callbacks: AgentCallbacks = {
      onTextDelta: (text) => {
        fullText += text;
        // V1.5: 流式代码高亮 — 只输出新增的高亮部分
        const highlighted = highlightCodeBlocks(fullText);
        const newPart = highlighted.substring(lastHighlightedLength);
        if (newPart) {
          process.stdout.write(newPart);
          lastHighlightedLength = highlighted.length;
        }
      },
      onToolUse: (name, input) => {
        process.stdout.write(`\n  ⚙ ${name}(${JSON.stringify(input).substring(0, 60)}...) `);
      },
      onToolResult: (_name, success, output) => {
        const icon = success ? '✓' : '✗';
        const short = output.length > 100 ? output.substring(0, 100) + '...' : output;
        process.stdout.write(`${icon} ${short}\n`);
      },
      onError: (message) => {
        process.stdout.write(`\n[错误] ${message}`);
      },
      onDone: () => {
        process.stdout.write('\n\n');
      },
    };

    return { callbacks, getText: () => fullText };
  }

  // 处理每个输入
  for (const input of inputs) {
    if (input === '/exit' || input === '/quit') {
      console.log('再见！');
      break;
    }

    if (input === '') continue;

    console.log(`> ${input}`);

    // 处理 / 命令
    if (input.startsWith('/')) {
      // /plan：多智能体编排入口（需要 provider，单独异步处理）
      if (input.toLowerCase().startsWith('/plan')) {
        const task = input.slice(5).trim();
        if (!task) {
          console.log('用法: /plan <任务描述>（复杂任务自动拆解为多步计划，每步验证）\n');
          continue;
        }
        store = addMessage(store, 'user', task);
        onSave(store);
        const route = routeProvider(config, store.messages, forceProvider);
        if (route.isAuto) {
          process.stdout.write(`[${route.displayName}] `);
        }
        await handlePlanCommand({
          provider: route.provider,
          messages: store.messages,
          fs,
          workingDir,
          sandbox,
          callbacks: createCallbacks().callbacks,
          onSummary: (summary) => {
            store = addMessage(store, 'assistant', summary);
            onSave(store);
          },
        });
        continue;
      }
      handleTextCommand(input, fs, store, onSave);
      continue;
    }

    // 添加用户消息
    store = addMessage(store, 'user', input);
    onSave(store);

    // Agent 循环
    process.stdout.write('\nCodex: ');

    // 模型路由：每次发送消息前选择 provider
    const route = routeProvider(config, store.messages, forceProvider);
    if (route.isAuto) {
      process.stdout.write(`[${route.displayName}] `);
    }

    const { callbacks, getText } = createCallbacks();
    let fullText = '';

    try {
      await runAgentLoop(
        route.provider,
        store.messages,
        fs,
        workingDir,
        callbacks,
        undefined,
        sandbox,
      );
      fullText = getText();
    } catch (err) {
      const errMsg = `[错误] ${err instanceof Error ? err.message : String(err)}`;
      process.stdout.write(errMsg + '\n\n');
      fullText = errMsg;
    }

    // 保存助手消息
    if (fullText) {
      store = addMessage(store, 'assistant', fullText);
      onSave(store);
    } else {
      store = addMessage(store, 'assistant', '[工具调用完成]');
      onSave(store);
    }
  }

  rl.close();
}

function handleTextCommand(
  input: string,
  fs: InMemoryFileSystem,
  store: MessageStore,
  onSave: (store: MessageStore) => void,
): void {
  const parts = input.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/apply': {
      if (!fs.isDirty()) {
        console.log('[info] 没有未保存的修改。\n');
        return;
      }
      const result = fs.applyToDisk();
      console.log(`已应用 ${result.applied.length} 个文件:`);
      for (const f of result.applied) console.log(`  ✓ ${f}`);
      if (result.failed.length > 0) {
        console.log(`失败 ${result.failed.length} 个:`);
        for (const f of result.failed) console.log(`  ✗ ${f.path}: ${f.error}`);
      }
      console.log('');
      return;
    }

    case '/diff': {
      const diffs = fs.getAllColoredDiffs();
      if (diffs.size === 0) {
        console.log('[info] 没有未保存的修改。\n');
        return;
      }
      console.log(`变更预览 (${diffs.size} 个文件):\n`);
      for (const [path, diff] of diffs) {
        console.log(`--- ${path} ---`);
        console.log(diff);
        console.log('');
      }
      return;
    }

    case '/status': {
      console.log(`文件状态: ${fs.getDirtyCount()} 个未保存的修改。\n`);
      return;
    }

    case '/clear': {
      const cleared = { ...store, messages: [] };
      onSave(cleared);
      console.log('[info] 对话历史已清除。\n');
      return;
    }

    case '/save': {
      const path = saveSessionToFile(store);
      console.log(`会话已保存到 ${path}\n`);
      return;
    }

    default:
      console.log(`未知命令: ${command}。可用: /apply, /diff, /status, /save, /clear, /plan, /exit\n`);
  }
}

// ---- V4.0 /plan：多智能体编排入口 ----

interface PlanCommandOptions {
  provider: AIProvider;
  messages: MessageStore['messages'];
  fs: InMemoryFileSystem;
  workingDir: string;
  sandbox?: Sandbox;
  callbacks: AgentCallbacks;
  onSummary: (summary: string) => void;
}

async function handlePlanCommand(options: PlanCommandOptions): Promise<void> {
  const { provider, messages, fs, workingDir, sandbox, callbacks, onSummary } = options;

  console.log('\n[plan] 正在生成执行计划...');
  try {
    const result = await runPlannedTask({
      provider,
      messages,
      fs,
      workingDir,
      callbacks,
      sandbox,
    });

    if (result.mode === 'fallback') {
      console.log('[plan] 计划解析失败，已降级为直接执行。\n');
      onSummary(result.text || '[工具调用完成]');
      return;
    }

    console.log(`[plan] 计划（${result.plan?.steps.length ?? 0} 步）：`);
    for (const s of result.plan?.steps ?? []) console.log(`  ${s.id}. ${s.description}`);
    console.log('');

    result.steps.forEach((outcome, i) => {
      const icon = outcome.status === 'completed' ? '✓' : '✗';
      console.log(
        `[plan] 步骤 ${i + 1} ${icon} ${outcome.step.description}` +
          (outcome.attempts > 1 ? `（重试 ${outcome.attempts - 1} 次）` : ''),
      );
      if (outcome.verifyOutput) {
        const short = outcome.verifyOutput.length > 200 ? outcome.verifyOutput.slice(0, 200) + '...' : outcome.verifyOutput;
        console.log(`      ${short}`);
      }
    });

    const failed = result.steps.filter((s) => s.status === 'failed').length;
    if (failed > 0) {
      console.log(`\n[plan] ${failed} 个步骤失败，后续步骤已终止。可用 /diff 查看已完成部分的修改。`);
    } else {
      console.log(`\n[plan] 全部步骤完成。可用 /diff 预览、/apply 写盘。`);
    }
    console.log('');

    onSummary(
      `[多步计划执行${failed > 0 ? '（部分失败）' : '完成'}]\n${result.steps
        .map((s, i) => `${i + 1}. ${s.status === 'completed' ? '✓' : '✗'} ${s.step.description}`)
        .join('\n')}${result.text ? `\n\n${result.text}` : ''}`,
    );
  } catch (err) {
    const errMsg = `[plan 执行错误] ${err instanceof Error ? err.message : String(err)}`;
    console.log(errMsg + '\n');
    onSummary(errMsg);
  }
}