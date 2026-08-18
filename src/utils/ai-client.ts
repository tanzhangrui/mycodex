/**
 * V1.4 — AI 客户端接口
 * ==========================================
 *
 * 新增：
 * - OpenAICompatibleProvider 流式重试机制
 * - AbortSignal 支持
 * - Token 用量统计
 * - Anthropic stream() 方法 Prompt Caching
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CodexConfig, ProviderType } from '../config/config.js';
import type { Message } from '../core/message-manager.js';
import type { TokenUsage } from '../core/agent-loop.js';
import { createLogger } from './logger.js';

const logger = createLogger('ai-client');

// ---- 工具定义 ----

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  description?: string;
  enum?: string[];
  items?: JSONSchema;
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// ---- 流式事件类型 ----

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ---- AI Provider 接口 ----

export interface AIProvider {
  readonly name: string;
  /** 纯文本流式回复 */
  stream(messages: Message[], systemPrompt: string, signal?: AbortSignal): AsyncGenerator<string, void, undefined>;
  /** 带工具定义的流式回复 */
  streamWithTools(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined>;
}

// ---- 系统提示词 ----

export const DEFAULT_SYSTEM_PROMPT = `You are Codex, a world-class CLI AI coding assistant.
You run in the terminal and help developers write, debug, and understand code.

Guidelines:
- Be concise and direct. The user is in a terminal, not a chat app.
- When asked about code, provide concrete examples.
- Use markdown for formatting when helpful.
- If you don't know something, say so — don't make things up.
- You have access to tools for reading, writing, editing, and searching files.
- Use tools when you need to interact with the file system.`;

export const TOOL_SYSTEM_PROMPT = `You are Codex, a world-class CLI AI coding assistant with tool access.
You run in the terminal and help developers write, debug, and understand code.

You have access to the following tools:
- read_file: Read file contents with optional line range
- write_file: Create or overwrite a file
- edit_file: Apply a unified diff patch to edit a file
- search_content: Search for patterns in files (grep)
- list_files: List directory contents

Guidelines:
- When asked to create or modify files, USE the tools — don't just describe what to do.
- Before editing a file, read it first to understand its current content.
- When searching, be specific with your patterns.
- Always confirm file operations before writing to disk.
- Use markdown in your responses for readability.
- Be concise — the user is in a terminal.`;

// ---- Mock Provider ----

export class MockProvider implements AIProvider {
  readonly name = 'mock';

  private responseIndex = 0;

  private mockResponses = [
    '你好！我是 Codex，一个 CLI AI 编程助手。\n\n我可以帮你读写文件、搜索代码、执行命令。\n\n试试让我列出文件或创建一个新文件吧！',
    '这是一个很好的问题！\n\n我可以使用以下工具：\n- read_file: 读取文件\n- write_file: 创建/覆盖文件\n- edit_file: 编辑文件\n- search_content: 搜索代码\n- list_files: 列出文件\n\n试试对我说"列出当前目录的文件"！',
    'Codex 是一个基于终端的 AI 编程工具，设计理念是：\n- 所有交互都在终端内完成\n- 性能优先\n- 对标 Claude Code 的 Agent 能力\n\n目前 V1.2 已支持多 Provider 架构和并行工具执行。',
  ];

  async *stream(_messages: Message[], _systemPrompt: string, _signal?: AbortSignal): AsyncGenerator<string, void, undefined> {
    const response = this.mockResponses[this.responseIndex % this.mockResponses.length];
    this.responseIndex++;
    for (let i = 0; i < response.length; i++) {
      yield response[i];
      await sleep(10 + Math.random() * 20);
    }
  }

  async *streamWithTools(
    messages: Message[],
    _systemPrompt: string,
    _tools: ToolDefinition[],
    _signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const userMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const isToolResult = userMsg.startsWith('[tool_result');

    if (!isToolResult) {
      if (userMsg.includes('列出') && userMsg.includes('文件')) {
        yield { type: 'text_delta', text: '让我列出当前目录的文件...\n' };
        await sleep(200);
        yield {
          type: 'tool_use',
          id: 'mock_toolu_001',
          name: 'list_files',
          input: { path: '.', depth: 2 },
        };
        yield { type: 'token_usage', usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 } };
        yield { type: 'done' };
        return;
      }

      if (userMsg.includes('创建') || userMsg.includes('新建')) {
        const filename = userMsg.match(/(\w+\.\w+)/)?.[1] || 'test.js';
        yield { type: 'text_delta', text: `好的，让我创建 ${filename}...\n` };
        await sleep(200);
        yield {
          type: 'tool_use',
          id: 'mock_toolu_002',
          name: 'write_file',
          input: {
            path: filename,
            content: '// New file created by Codex\nconsole.log("Hello from Codex!");\n',
          },
        };
        yield { type: 'token_usage', usage: { promptTokens: 150, completionTokens: 40, totalTokens: 190 } };
        yield { type: 'done' };
        return;
      }

      if (userMsg.includes('搜索') || userMsg.includes('查找')) {
        yield { type: 'text_delta', text: '让我搜索相关代码...\n' };
        await sleep(200);
        yield {
          type: 'tool_use',
          id: 'mock_toolu_003',
          name: 'search_content',
          input: { pattern: userMsg.split('搜索').pop()?.trim() || 'function', path: '.' },
        };
        yield { type: 'token_usage', usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 } };
        yield { type: 'done' };
        return;
      }

      // 模拟读取两个文件（并行工具调用）
      if (userMsg.includes('读取') && userMsg.includes('和')) {
        yield { type: 'text_delta', text: '让我同时读取这两个文件...\n' };
        yield {
          type: 'tool_use',
          id: 'mock_toolu_004',
          name: 'read_file',
          input: { path: 'src/index.ts' },
        };
        yield {
          type: 'tool_use',
          id: 'mock_toolu_005',
          name: 'read_file',
          input: { path: 'src/config/config.ts' },
        };
        yield { type: 'token_usage', usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 } };
        yield { type: 'done' };
        return;
      }
    }

    const response = this.mockResponses[this.responseIndex % this.mockResponses.length];
    this.responseIndex++;
    for (let i = 0; i < response.length; i++) {
      yield { type: 'text_delta', text: response[i] };
      await sleep(5 + Math.random() * 10);
    }
    yield { type: 'token_usage', usage: { promptTokens: 80, completionTokens: 60, totalTokens: 140 } };
    yield { type: 'done' };
  }
}

// ---- Anthropic Provider (V1.2: Prompt Caching on stream() + Token Usage) ----

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';

  private config: CodexConfig;
  private client: Anthropic | null = null;

  constructor(config: CodexConfig) {
    this.config = config;
    const apiKey = config.providers.anthropic.apiKey;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async *stream(_messages: Message[], _systemPrompt: string, _signal?: AbortSignal): AsyncGenerator<string, void, undefined> {
    if (!this.client) {
      yield '错误：未配置 Anthropic API Key。\n\n请在 ~/.codex/config.json 中设置或设置 ANTHROPIC_API_KEY 环境变量。';
      return;
    }

    try {
      // V1.2: Prompt Caching for stream() too
      const systemContent: Anthropic.TextBlockParam[] = [
        { type: 'text', text: _systemPrompt, cache_control: { type: 'ephemeral' } },
      ];

      const apiMessages = _messages.map((m, i) => {
        const isLastTwo = i >= _messages.length - 4;
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (isLastTwo && i === _messages.length - 1) {
          return {
            role: m.role as 'user' | 'assistant',
            content: [{ type: 'text' as const, text: content, cache_control: { type: 'ephemeral' as const } }],
          };
        }
        return {
          role: m.role as 'user' | 'assistant',
          content,
        };
      });

      const stream = this.client.messages.stream({
        model: this.config.providers.anthropic.model,
        max_tokens: this.config.providers.anthropic.maxTokens,
        system: systemContent,
        messages: apiMessages as Anthropic.MessageParam[],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield `\n[API 错误] ${msg}`;
    }
  }

  async *streamWithTools(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    if (!this.client) {
      yield { type: 'error', message: '未配置 Anthropic API Key。请在 ~/.codex/config.json 中设置或设置 ANTHROPIC_API_KEY 环境变量。' };
      yield { type: 'done' };
      return;
    }

    const anthropicProvider = this.config.providers.anthropic;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const anthropicTools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: {
            type: 'object' as const,
            properties: t.parameters.properties || {},
            required: t.parameters.required,
          },
        }));

        // ---- Prompt Caching ----
        const systemContent: Anthropic.TextBlockParam[] = [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ];

        const toolsWithCache: Anthropic.Tool[] = [...anthropicTools.slice(0, -1)];
        if (anthropicTools.length > 0) {
          toolsWithCache.push({
            ...anthropicTools[anthropicTools.length - 1],
            cache_control: { type: 'ephemeral' },
          } as Anthropic.Tool);
        }

        const apiMessages = messages.map((m, i) => {
          const isLastTwo = i >= messages.length - 4;
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          if (isLastTwo && i === messages.length - 1) {
            return {
              role: m.role as 'user' | 'assistant',
              content: [{ type: 'text' as const, text: content, cache_control: { type: 'ephemeral' as const } }],
            };
          }
          return {
            role: m.role as 'user' | 'assistant',
            content,
          };
        });

        const stream = this.client.messages.stream({
          model: anthropicProvider.model,
          max_tokens: anthropicProvider.maxTokens,
          system: systemContent,
          messages: apiMessages as Anthropic.MessageParam[],
          tools: toolsWithCache,
        });

        let currentToolUse: { id: string; name: string; input: string } | null = null;
        let cacheHit = false;
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const event of stream) {
          if (signal?.aborted) break;

          switch (event.type) {
            case 'message_start': {
              const msgStart = event as { message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } } };
              const usage = msgStart.message?.usage;
              if (usage) {
                promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
                if (usage.cache_read_input_tokens) {
                  cacheHit = true;
                }
              }
              break;
            }

            case 'message_delta': {
              const msgDelta = event as { usage?: { output_tokens?: number } };
              if (msgDelta.usage?.output_tokens) {
                completionTokens = msgDelta.usage.output_tokens;
              }
              break;
            }

            case 'content_block_start': {
              const block = event.content_block;
              if (block.type === 'tool_use') {
                currentToolUse = {
                  id: block.id,
                  name: block.name,
                  input: '',
                };
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta;
              if (delta.type === 'text_delta') {
                yield { type: 'text_delta', text: delta.text };
              } else if (delta.type === 'input_json_delta' && currentToolUse) {
                currentToolUse.input += delta.partial_json;
              }
              break;
            }

            case 'content_block_stop': {
              if (currentToolUse && currentToolUse.id) {
                try {
                  const input = JSON.parse(currentToolUse.input);
                  yield {
                    type: 'tool_use',
                    id: currentToolUse.id,
                    name: currentToolUse.name,
                    input,
                  };
                } catch {
                  yield {
                    type: 'error',
                    message: `工具参数解析失败: ${currentToolUse.input}`,
                  };
                }
                currentToolUse = null;
              }
              break;
            }

            default:
              break;
          }
        }

        if (signal?.aborted) break;

        if (cacheHit) {
          logger.info('Prompt Caching 命中，节省 token 消耗');
        }

        // Token 用量统计
        if (promptTokens > 0 || completionTokens > 0) {
          yield {
            type: 'token_usage',
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
          };
        }

        yield { type: 'done' };
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (isAbortError(err)) {
          yield { type: 'done' };
          return;
        }

        if (isRetryableError(err) && attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await sleep(delay);
          continue;
        }

        yield { type: 'error', message: `[API 错误] ${msg}` };
        yield { type: 'done' };
        return;
      }
    }
  }
}

// ---- OpenAICompatibleProvider (V1.2: AbortSignal + Token Usage) ----

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string = 'openai-compatible';

  private providerConfig: CodexConfig['providers']['openai-compatible'];

  constructor(config: CodexConfig, providerType?: ProviderType) {
    if (providerType === 'local') {
      const localCfg = config.providers.local;
      this.providerConfig = {
        apiKey: '',
        baseURL: localCfg.baseURL,
        model: localCfg.model,
        maxTokens: localCfg.maxTokens,
      };
      this.name = 'local';
    } else {
      this.providerConfig = config.providers['openai-compatible'];
    }
  }

  async *stream(_messages: Message[], _systemPrompt: string, signal?: AbortSignal): AsyncGenerator<string, void, undefined> {
    if (!this.providerConfig.apiKey && this.name !== 'local') {
      yield '错误：未配置 OpenAI Compatible API Key。\n\n请设置 GLM_API_KEY 环境变量或编辑 ~/.codex/config.json。';
      return;
    }

    try {
      const body = {
        model: this.providerConfig.model,
        messages: [
          { role: 'system', content: _systemPrompt },
          ..._messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: this.providerConfig.maxTokens,
        stream: true,
      };

      const response = await fetch(`${this.providerConfig.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.providerConfig.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        yield `\n[API 错误] HTTP ${response.status}: ${response.statusText}`;
        return;
      }

      for await (const chunk of this.parseSSEStream(response)) {
        if (chunk.type === 'text') {
          yield chunk.text;
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      yield `\n[API 错误] ${msg}`;
    }
  }

  async *streamWithTools(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    if (!this.providerConfig.apiKey && this.name !== 'local') {
      yield { type: 'error', message: '未配置 API Key。请设置 GLM_API_KEY 环境变量或编辑 ~/.codex/config.json。' };
      yield { type: 'done' };
      return;
    }

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body = {
      model: this.providerConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      ],
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: this.providerConfig.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    // V1.4: 流式重试机制
    const MAX_RETRIES = 2;
    const accumulatedText: string[] = [];
    const accumulatedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      if (signal?.aborted) break;

      try {
        const response = await fetch(`${this.providerConfig.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.providerConfig.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        // HTTP 状态码处理
        if (!response.ok) {
          if (response.status === 429) {
            // 限流：等待 Retry-After 或指数退避
            const retryAfter = response.headers.get('Retry-After');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, retry) * 1000;
            if (retry < MAX_RETRIES) {
              logger.warn(`HTTP 429 限流，${delay}ms 后重试 (${retry + 1}/${MAX_RETRIES})`);
              await sleep(delay);
              continue;
            }
          } else if (response.status >= 500) {
            // 服务端错误：重试 1 次
            if (retry < MAX_RETRIES) {
              const delay = Math.pow(2, retry) * 1000;
              logger.warn(`HTTP ${response.status} 服务端错误，${delay}ms 后重试 (${retry + 1}/${MAX_RETRIES})`);
              await sleep(delay);
              continue;
            }
          }
          // 4xx 非 429 或重试耗尽 → 直接报错
          const errorText = await response.text();
          yield { type: 'error', message: `HTTP ${response.status}: ${errorText.substring(0, 200)}` };
          yield { type: 'done' };
          return;
        }

        // 流式处理
        const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

        for await (const chunk of this.parseSSEStream(response)) {
          if (signal?.aborted) break;

          switch (chunk.type) {
            case 'text':
              accumulatedText.push(chunk.text);
              yield { type: 'text_delta', text: chunk.text };
              break;

            case 'tool_call_delta': {
              const tc = chunk.toolCall;
              const existing = pendingToolCalls.get(tc.index) || { id: tc.id || '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.name) existing.name = tc.name;
              if (tc.arguments) existing.arguments += tc.arguments;
              pendingToolCalls.set(tc.index, existing);
              break;
            }

            case 'finish': {
              if (chunk.finishReason === 'tool_calls') {
                for (const [, tc] of pendingToolCalls) {
                  if (tc.name && tc.id) {
                    try {
                      const input = JSON.parse(tc.arguments || '{}');
                      accumulatedToolCalls.push({ id: tc.id, name: tc.name, input });
                      yield {
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input,
                      };
                    } catch {
                      yield {
                        type: 'error',
                        message: `工具参数解析失败: ${tc.arguments}`,
                      };
                    }
                  }
                }
                pendingToolCalls.clear();
              }
              break;
            }

            case 'usage': {
              yield {
                type: 'token_usage',
                usage: {
                  promptTokens: chunk.promptTokens,
                  completionTokens: chunk.completionTokens,
                  totalTokens: chunk.totalTokens,
                },
              };
              break;
            }
          }
        }

        yield { type: 'done' };
        return;
      } catch (err) {
        if (isAbortError(err)) {
          // 重试前累积的文本仍输出
          yield { type: 'done' };
          return;
        }

        const msg = err instanceof Error ? err.message : String(err);

        // 网络错误：重试
        if (isNetworkError(msg) && retry < MAX_RETRIES) {
          const delay = (retry + 1) * 1000;
          logger.warn(`网络错误 "${msg}"，${delay}ms 后重试 (${retry + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }

        yield { type: 'error', message: `[API 错误] ${msg}` };
        yield { type: 'done' };
        return;
      }
    }
  }

  /**
   * SSE 流式解析
   */
  private async *parseSSEStream(
    response: Response,
  ): AsyncGenerator<
    | { type: 'text'; text: string }
    | { type: 'tool_call_delta'; toolCall: { index: number; id?: string; name?: string; arguments?: string } }
    | { type: 'finish'; finishReason: string }
    | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  > {
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;

              // text_delta
              if (delta?.content) {
                yield { type: 'text', text: delta.content };
              }

              // tool_calls
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  yield {
                    type: 'tool_call_delta',
                    toolCall: {
                      index: tc.index ?? 0,
                      id: tc.id,
                      name: tc.function?.name,
                      arguments: tc.function?.arguments,
                    },
                  };
                }
              }

              // finish_reason
              if (choice?.finish_reason) {
                yield { type: 'finish', finishReason: choice.finish_reason };
              }

              // usage (OpenAI 兼容格式，通常在最后一个 chunk)
              if (parsed.usage) {
                yield {
                  type: 'usage',
                  promptTokens: parsed.usage.prompt_tokens || 0,
                  completionTokens: parsed.usage.completion_tokens || 0,
                  totalTokens: parsed.usage.total_tokens || 0,
                };
              }
            } catch {
              // 跳过无法解析的行
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ---- 工厂函数 ----

export function createProvider(config: CodexConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic':
      if (config.providers.anthropic.apiKey) {
        return new AnthropicProvider(config);
      }
      return new MockProvider();

    case 'openai-compatible':
      if (config.providers['openai-compatible'].apiKey) {
        return new OpenAICompatibleProvider(config);
      }
      return new MockProvider();

    case 'local':
      return new OpenAICompatibleProvider(config, 'local');

    case 'mock':
    default:
      return new MockProvider();
  }
}

// ---- 工具函数 ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('network');
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('aborted') || msg.includes('AbortError');
}

function isNetworkError(message: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(message);
}