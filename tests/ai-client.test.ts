/**
 * V1.1 测试 — AI 客户端
 * ==========================================
 * 测试多 Provider 架构：MockProvider / AnthropicProvider / OpenAICompatibleProvider
 */

import { describe, it, expect } from 'vitest';
import {
  MockProvider,
  AnthropicProvider,
  OpenAICompatibleProvider,
  createProvider,
  DEFAULT_SYSTEM_PROMPT,
} from '../src/utils/ai-client.js';
import type { CodexConfig } from '../src/config/config.js';

// ---- 辅助函数：构建测试用的 CodexConfig ----

function makeConfig(overrides: Partial<CodexConfig> = {}): CodexConfig {
  return {
    provider: 'mock',
    providers: {
      anthropic: {
        apiKey: '',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 4096,
      },
      'openai-compatible': {
        apiKey: '',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4.7-flash',
        maxTokens: 4096,
      },
      local: {
        baseURL: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
        maxTokens: 4096,
      },
    },
    ...overrides,
  };
}

// ================================================================
// MockProvider
// ================================================================

describe('MockProvider', () => {
  it('应该返回流式响应', async () => {
    const provider = new MockProvider();
    const chunks: string[] = [];

    for await (const chunk of provider.stream([], DEFAULT_SYSTEM_PROMPT)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const fullResponse = chunks.join('');
    expect(fullResponse).toContain('Codex');
  });

  it('每次调用应该返回不同响应', { timeout: 15000 }, async () => {
    const provider = new MockProvider();

    const getResponse = async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.stream([], DEFAULT_SYSTEM_PROMPT)) {
        chunks.push(chunk);
      }
      return chunks.join('');
    };

    const response1 = await getResponse();
    const response2 = await getResponse();

    expect(response1).not.toEqual(response2);
  });

  it('streamWithTools 应该返回工具调用事件', async () => {
    const provider = new MockProvider();
    const events: unknown[] = [];

    for await (const event of provider.streamWithTools(
      [{ role: 'user', content: '列出当前目录的文件', timestamp: new Date().toISOString() }],
      DEFAULT_SYSTEM_PROMPT,
      [],
    )) {
      events.push(event);
    }

    const toolUseEvent = events.find((e: any) => e.type === 'tool_use');
    expect(toolUseEvent).toBeTruthy();
    expect((toolUseEvent as any).name).toBe('list_files');
  });
});

// ================================================================
// AnthropicProvider
// ================================================================

describe('AnthropicProvider', () => {
  it('无 API Key 时 stream 应该返回错误提示', async () => {
    const config = makeConfig({ provider: 'anthropic' });
    const provider = new AnthropicProvider(config);
    const chunks: string[] = [];

    for await (const chunk of provider.stream([], DEFAULT_SYSTEM_PROMPT)) {
      chunks.push(chunk);
    }

    const response = chunks.join('');
    expect(response).toContain('错误');
    expect(response).toContain('API Key');
  });

  it('无 API Key 时 streamWithTools 应该返回 error 事件', async () => {
    const config = makeConfig({ provider: 'anthropic' });
    const provider = new AnthropicProvider(config);
    const events: unknown[] = [];

    for await (const event of provider.streamWithTools([], DEFAULT_SYSTEM_PROMPT, [])) {
      events.push(event);
    }

    const errorEvent = events.find((e: any) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as any).message).toContain('API Key');
  });
});

// ================================================================
// OpenAICompatibleProvider
// ================================================================

describe('OpenAICompatibleProvider', () => {
  it('无 API Key 时 stream 应该返回错误提示', async () => {
    const config = makeConfig({
      provider: 'openai-compatible',
      providers: {
        ...makeConfig().providers,
        'openai-compatible': { apiKey: '', baseURL: 'https://test.api/v1', model: 'test-model', maxTokens: 4096 },
      },
    });
    const provider = new OpenAICompatibleProvider(config);
    const chunks: string[] = [];

    for await (const chunk of provider.stream([], DEFAULT_SYSTEM_PROMPT)) {
      chunks.push(chunk);
    }

    const response = chunks.join('');
    expect(response).toContain('错误');
    expect(response).toContain('API Key');
  });

  it('无 API Key 时 streamWithTools 应该返回 error 事件', async () => {
    const config = makeConfig({
      provider: 'openai-compatible',
      providers: {
        ...makeConfig().providers,
        'openai-compatible': { apiKey: '', baseURL: 'https://test.api/v1', model: 'test-model', maxTokens: 4096 },
      },
    });
    const provider = new OpenAICompatibleProvider(config);
    const events: unknown[] = [];

    for await (const event of provider.streamWithTools([], DEFAULT_SYSTEM_PROMPT, [])) {
      events.push(event);
    }

    const errorEvent = events.find((e: any) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    const msg = (errorEvent as any).message;
    expect(msg.includes('API Key') || msg.includes('GLM_API_KEY')).toBe(true);
  });

  it('有 API Key 时应该发送正确的请求格式', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: { url: string; options: RequestInit }[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, options: init || {} });

      const stream = new ReadableStream({
        start(controller) {
          const sseData = [
            'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
            'data: {"choices":[{"delta":{"content":" World"},"index":0}]}\n\n',
            'data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n',
            'data: [DONE]\n\n',
          ];
          for (const chunk of sseData) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    try {
      const config = makeConfig({
        provider: 'openai-compatible',
        providers: {
          ...makeConfig().providers,
          'openai-compatible': {
            apiKey: 'test-key-123',
            baseURL: 'https://test.api/v1',
            model: 'test-model',
            maxTokens: 4096,
          },
        },
      });
      const provider = new OpenAICompatibleProvider(config);
      const chunks: string[] = [];

      for await (const chunk of provider.stream([], DEFAULT_SYSTEM_PROMPT)) {
        chunks.push(chunk);
      }

      expect(fetchCalls.length).toBe(1);
      const call = fetchCalls[0];

      expect(call.url).toContain('/chat/completions');

      const headers = (call.options.headers as Record<string, string>) || {};
      expect(headers['Authorization']).toBe('Bearer test-key-123');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(call.options.body as string);
      expect(body.model).toBe('test-model');
      expect(body.stream).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);

      const response = chunks.join('');
      expect(response).toContain('Hello');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('streamWithTools 应该正确处理 tool_calls 累积', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          // 将所有 SSE 数据放在一个 chunk 中，避免分片问题
          const sseData = [
            'data: {"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"list_files","arguments":""}}]}}]}\n\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": \\".\\"}"}}]}}]}\n\n' +
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
            'data: [DONE]\n\n',
          ];
          for (const chunk of sseData) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    try {
      const config = makeConfig({
        provider: 'openai-compatible',
        providers: {
          ...makeConfig().providers,
          'openai-compatible': {
            apiKey: 'test-key-123',
            baseURL: 'https://test.api/v1',
            model: 'test-model',
            maxTokens: 4096,
          },
        },
      });
      const provider = new OpenAICompatibleProvider(config);
      const events: unknown[] = [];

      for await (const event of provider.streamWithTools(
        [{ role: 'user', content: '列出文件', timestamp: new Date().toISOString() }],
        DEFAULT_SYSTEM_PROMPT,
        [{ name: 'list_files', description: '列出文件', parameters: { type: 'object', properties: {} } }],
      )) {
        events.push(event);
      }

      const toolUseEvent = events.find((e: any) => e.type === 'tool_use');
      expect(toolUseEvent).toBeTruthy();
      expect((toolUseEvent as any).name).toBe('list_files');
      expect((toolUseEvent as any).id).toBe('call_123');
      // 验证 input 存在且有 path 属性
      const input = (toolUseEvent as any).input;
      expect(input).toBeTruthy();
      expect(input.path).toBe('.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('local 模式无 API Key 也应该正常工作', () => {
    const config = makeConfig({
      provider: 'local',
      providers: {
        ...makeConfig().providers,
        local: { baseURL: 'http://localhost:11434/v1', model: 'test-model', maxTokens: 4096 },
      },
    });
    const provider = new OpenAICompatibleProvider(config, 'local');
    expect(provider.name).toBe('local');
  });
});

// ================================================================
// createProvider 工厂函数
// ================================================================

describe('createProvider', () => {
  it('provider=anthropic 有 Key → AnthropicProvider', () => {
    const config = makeConfig({
      provider: 'anthropic',
      providers: {
        ...makeConfig().providers,
        anthropic: { apiKey: 'test-key-123', model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
      },
    });
    const provider = createProvider(config);
    expect(provider.name).toBe('anthropic');
  });

  it('provider=anthropic 无 Key → MockProvider', () => {
    const config = makeConfig({ provider: 'anthropic' });
    const provider = createProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('provider=openai-compatible 有 Key → OpenAICompatibleProvider', () => {
    const config = makeConfig({
      provider: 'openai-compatible',
      providers: {
        ...makeConfig().providers,
        'openai-compatible': { apiKey: 'test-key-123', baseURL: 'https://test.api/v1', model: 'test', maxTokens: 4096 },
      },
    });
    const provider = createProvider(config);
    expect(provider.name).toBe('openai-compatible');
  });

  it('provider=openai-compatible 无 Key → MockProvider', () => {
    const config = makeConfig({ provider: 'openai-compatible' });
    const provider = createProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('provider=local → OpenAICompatibleProvider (local)', () => {
    const config = makeConfig({ provider: 'local' });
    const provider = createProvider(config);
    expect(provider.name).toBe('local');
  });

  it('provider=mock → MockProvider', () => {
    const config = makeConfig({ provider: 'mock' });
    const provider = createProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('未设置 provider → MockProvider', () => {
    const config = makeConfig();
    const provider = createProvider(config);
    expect(provider.name).toBe('mock');
  });
});