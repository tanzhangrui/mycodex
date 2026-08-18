/**
 * V0.2 — CLI 界面 (Ink)
 * ==========================================
 *
 * 新增：
 * - Agent 循环集成：tool_use 检测 → 工具执行 → 结果展示
 * - 工具调用在 UI 中显示为彩色折叠区域
 * - 支持 /apply, /diff, /status 命令
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, Static, useInput, useApp } from 'ink';
import type { Message, MessageStore } from '../core/message-manager.js';
import { saveSessionToFile } from '../core/message-manager.js';
import type { AIProvider } from '../utils/ai-client.js';
import { InMemoryFileSystem } from '../core/in-memory-fs.js';
import { runAgentLoop, type AgentCallbacks } from '../core/agent-loop.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import type { CodexConfig } from '../config/config.js';
import { routeProvider } from '../core/model-router.js';
import { highlightCodeBlocks } from '../utils/highlight.js';

// ---- Props ----

export interface ChatAppProps {
  store: MessageStore;
  provider: AIProvider;
  config: CodexConfig;
  fs: InMemoryFileSystem;
  workingDir: string;
  sandbox?: Sandbox;
  forceProvider?: string;
  onSave: (store: MessageStore) => void;
  onExit: () => void;
}

// ---- 工具调用显示 ----

interface ToolCallDisplay {
  id: string;
  name: string;
  input: Record<string, unknown>;
  success: boolean;
  output: string;
}

// ---- 组件 ----

export const ChatApp: React.FC<ChatAppProps> = ({ store: initialStore, provider, config, fs, workingDir, sandbox, forceProvider, onSave, onExit }) => {
  const { exit } = useApp();
  const [store, setStore] = useState<MessageStore>(initialStore);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallDisplay[]>([]);
  const [currentModel, setCurrentModel] = useState(forceProvider ? provider.name : 'auto');

  // 确保工具已注册
  React.useEffect(() => {
    registerBuiltinTools();
  }, []);

  const persist = useCallback(
    (updated: MessageStore) => {
      onSave(updated);
    },
    [onSave],
  );

  // 处理 / 命令
  const handleCommand = useCallback(
    (cmd: string) => {
      const parts = cmd.trim().split(/\s+/);
      const command = parts[0].toLowerCase();

      switch (command) {
        case '/apply': {
          if (!fs.isDirty()) {
            setStreamingText('[info] 没有未保存的修改。');
            return;
          }
          const result = fs.applyToDisk();
          const msgs = [`已应用 ${result.applied.length} 个文件:`];
          for (const f of result.applied) {
            msgs.push(`  ✓ ${f}`);
          }
          if (result.failed.length > 0) {
            msgs.push(`失败 ${result.failed.length} 个:`);
            for (const f of result.failed) {
              msgs.push(`  ✗ ${f.path}: ${f.error}`);
            }
          }
          setStreamingText(msgs.join('\n'));
          return;
        }

        case '/diff': {
          const diffs = fs.getAllColoredDiffs();
          if (diffs.size === 0) {
            setStreamingText('[info] 没有未保存的修改。');
            return;
          }
          const lines: string[] = [`变更预览 (${diffs.size} 个文件):`, ''];
          for (const [path, diff] of diffs) {
            lines.push(`--- ${path} ---`);
            lines.push(diff);
            lines.push('');
          }
          setStreamingText(lines.join('\n'));
          return;
        }

        case '/status': {
          const dirty = fs.getDirtyCount();
          setStreamingText(`文件状态: ${dirty} 个未保存的修改。使用 /diff 查看变更，/apply 写入磁盘。`);
          return;
        }

        case '/clear': {
          setStore({ ...store, messages: [] });
          persist({ ...store, messages: [] });
          setStreamingText('[info] 对话历史已清除。');
          return;
        }

        case '/save': {
          const path = saveSessionToFile(store);
          setStreamingText(`会话已保存到 ${path}`);
          return;
        }

        default:
          setStreamingText(`未知命令: ${command}。可用命令: /apply, /diff, /status, /save, /clear, /exit`);
      }
    },
    [fs, store, persist],
  );

  // 发送消息（使用 Agent 循环）
  const sendMessage = useCallback(
    async (userInput: string) => {
      if (userInput.trim() === '' || isLoading) return;

      // 处理 / 命令
      if (userInput.startsWith('/')) {
        if (userInput === '/exit' || userInput === '/quit') {
          onExit();
          exit();
          return;
        }
        handleCommand(userInput);
        return;
      }

      setIsLoading(true);
      setStreamingText('');
      setRawText('');
      setToolCalls([]);

      // 添加用户消息
      const userMsg: Message = {
        role: 'user',
        content: userInput,
        timestamp: new Date().toISOString(),
      };
      const withUser = { ...store, messages: [...store.messages, userMsg] };
      setStore(withUser);
      persist(withUser);

      // 模型路由：每次发送消息前选择 provider
      const route = routeProvider(config, withUser.messages, forceProvider);
      setCurrentModel(route.displayName);

      // Agent 循环回调
      const callbacks: AgentCallbacks = {
        onTextDelta: (text) => {
          setRawText((prev) => prev + text);
          setStreamingText((prev) => highlightCodeBlocks(prev + text));
        },
        onToolUse: (name, input) => {
          setToolCalls((prev) => [
            ...prev,
            {
              id: `tool_${Date.now()}`,
              name,
              input,
              success: false,
              output: '执行中...',
            },
          ]);
        },
        onToolResult: (name, success, output) => {
          setToolCalls((prev) =>
            prev.map((tc) =>
              tc.name === name && tc.output === '执行中...' ? { ...tc, success, output } : tc,
            ),
          );
        },
        onError: (message) => {
          setStreamingText((prev) => prev + `\n[错误] ${message}`);
        },
        onDone: (fullText) => {
          // 使用原始文本（不含 ANSI）保存
          const textToSave = rawText || fullText;
          if (textToSave) {
            const assistantMsg: Message = {
              role: 'assistant',
              content: textToSave,
              timestamp: new Date().toISOString(),
            };
            const updated = {
              ...withUser,
              messages: [...withUser.messages, assistantMsg],
            };
            setStore(updated);
            persist(updated);
          }
          setStreamingText('');
          setRawText('');
          setIsLoading(false);
        },
      };

      try {
        await runAgentLoop(
        route.provider,
        withUser.messages,
        fs,
        workingDir,
        callbacks,
        undefined,
        sandbox,
      );
      } catch (err) {
        setStreamingText(`[错误] ${err instanceof Error ? err.message : String(err)}`);
        setIsLoading(false);
      }
    },
    [store, isLoading, provider, persist, fs, workingDir, onExit, exit, handleCommand],
  );

  // 键盘输入
  useInput(
    (inputChar, key) => {
      if (key.ctrl && inputChar === 'c') {
        onExit();
        exit();
        return;
      }

      if (isLoading) return;

      if (key.return) {
        const currentInput = input;
        setInput('');
        sendMessage(currentInput);
        return;
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      if (inputChar && !key.ctrl && !key.meta) {
        setInput((prev) => prev + inputChar);
      }
    },
    { isActive: true },
  );

  // 消息历史项
  const historyItems = store.messages.map((msg) => ({
    id: `${msg.timestamp}_${msg.role}`,
    role: msg.role,
    content: msg.content,
    isTool: msg.content.startsWith('[tool_'),
  }));

  return (
    <Box flexDirection="column" padding={0}>
      {/* 标题栏 */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⚡ Codex
        </Text>
        <Text dimColor> v2.0.0 — {currentModel}</Text>
        {fs.isDirty() && (
          <Text color="yellow"> [{fs.getDirtyCount()} 个文件已修改]</Text>
        )}
      </Box>

      {/* 消息历史 */}
      <Static items={historyItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={item.role === 'user' ? 'green' : 'blue'} bold>
                {item.role === 'user' ? '▸ You' : '▸ Codex'}
              </Text>
              {item.isTool && (
                <Text color="yellow" dimColor>
                  {' '}
                  [工具调用]
                </Text>
              )}
            </Box>
            {!item.isTool && (
              <Box paddingLeft={2}>
                <Text>{item.content}</Text>
              </Box>
            )}
          </Box>
        )}
      </Static>

      {/* 工具调用展示 */}
      {toolCalls.map((tc) => (
        <Box key={tc.id} flexDirection="column" marginBottom={1} marginLeft={2}>
          <Box>
            <Text color="yellow" bold>
              ⚙ {tc.name}
            </Text>
            <Text dimColor> {JSON.stringify(tc.input).substring(0, 80)}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color={tc.success ? 'green' : 'red'}>
              {tc.success ? '✓ ' : '✗ '}
              {tc.output.length > 200 ? tc.output.substring(0, 200) + '...' : tc.output}
            </Text>
          </Box>
        </Box>
      ))}

      {/* 流式输出 */}
      {streamingText && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="blue" bold>
              ▸ Codex
            </Text>
            <Text dimColor> (streaming...)</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>{streamingText}</Text>
          </Box>
        </Box>
      )}

      {/* 分隔线 */}
      <Box marginY={1}>
        <Text dimColor>{'─'.repeat(Math.min(process.stdout.columns || 80, 80))}</Text>
      </Box>

      {/* 输入区域 */}
      <Box>
        <Text color="cyan" bold>
          {'> '}
        </Text>
        <Text>{input}</Text>
        {isLoading && <Text dimColor> [处理中...]</Text>}
      </Box>

      {/* 命令提示 */}
      <Box marginTop={1}>
        <Text dimColor>/apply | /diff | /status | /save | /clear | /exit | Ctrl+C 退出</Text>
      </Box>
    </Box>
  );
};

export default ChatApp;