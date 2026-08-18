/**
 * V1.1 测试 — 多 Provider 配置管理
 * ==========================================
 * 测试环境变量覆盖、默认回退、配置加载
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfigDir, getProviderDisplayName } from '../src/config/config.js';
import type { CodexConfig } from '../src/config/config.js';

// ---- 环境变量操作辅助 ----

const ENV_BACKUP: Record<string, string | undefined> = {};

function setEnv(key: string, value: string) {
  if (!(key in ENV_BACKUP)) {
    ENV_BACKUP[key] = process.env[key];
  }
  process.env[key] = value;
}

function unsetEnv(key: string) {
  if (!(key in ENV_BACKUP)) {
    ENV_BACKUP[key] = process.env[key];
  }
  delete process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ---- 测试 ----

describe('loadConfig', () => {
  beforeEach(() => {
    unsetEnv('GLM_API_KEY');
    unsetEnv('GLM_MODEL');
    unsetEnv('GLM_BASE_URL');
    unsetEnv('ANTHROPIC_API_KEY');
    unsetEnv('ANTHROPIC_MODEL');
    unsetEnv('OLLAMA_BASE_URL');
    unsetEnv('OLLAMA_MODEL');
  });

  afterEach(() => {
    restoreEnv();
  });

  it('无环境变量时默认 provider 为 mock', () => {
    const config = loadConfig();
    expect(config.provider).toBe('mock');
  });

  it('GLM_API_KEY 设置时 provider 应为 openai-compatible', () => {
    setEnv('GLM_API_KEY', 'test-glm-key-123456');
    const config = loadConfig();
    expect(config.provider).toBe('openai-compatible');
    expect(config.providers['openai-compatible'].apiKey).toBe('test-glm-key-123456');
  });

  it('GLM_MODEL 环境变量应覆盖默认模型', () => {
    setEnv('GLM_API_KEY', 'test-glm-key');
    setEnv('GLM_MODEL', 'glm-4-custom');
    const config = loadConfig();
    expect(config.providers['openai-compatible'].model).toBe('glm-4-custom');
  });

  it('GLM_BASE_URL 环境变量应覆盖默认 baseURL', () => {
    setEnv('GLM_API_KEY', 'test-glm-key');
    setEnv('GLM_BASE_URL', 'https://custom.glm.api/v1');
    const config = loadConfig();
    expect(config.providers['openai-compatible'].baseURL).toBe('https://custom.glm.api/v1');
  });

  it('ANTHROPIC_API_KEY 设置时 provider 应为 anthropic', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key-123');
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.providers.anthropic.apiKey).toBe('sk-ant-test-key-123');
  });

  it('ANTHROPIC_MODEL 环境变量应覆盖默认模型', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    setEnv('ANTHROPIC_MODEL', 'claude-opus-4-20250514');
    const config = loadConfig();
    expect(config.providers.anthropic.model).toBe('claude-opus-4-20250514');
  });

  it('OLLAMA_BASE_URL 设置时 provider 应为 local', () => {
    setEnv('OLLAMA_BASE_URL', 'http://localhost:11434/v1');
    const config = loadConfig();
    expect(config.provider).toBe('local');
    expect(config.providers.local.baseURL).toBe('http://localhost:11434/v1');
  });

  it('OLLAMA_MODEL 环境变量应覆盖默认模型', () => {
    setEnv('OLLAMA_BASE_URL', 'http://localhost:11434/v1');
    setEnv('OLLAMA_MODEL', 'codellama:13b');
    const config = loadConfig();
    expect(config.providers.local.model).toBe('codellama:13b');
  });

  it('GLM_API_KEY 优先级高于 ANTHROPIC_API_KEY', () => {
    setEnv('GLM_API_KEY', 'test-glm-key');
    setEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    const config = loadConfig();
    // GLM 优先级更高，所以 provider 应该是 openai-compatible
    expect(config.provider).toBe('openai-compatible');
    expect(config.providers['openai-compatible'].apiKey).toBe('test-glm-key');
    // detectProviderFromEnv 在找到 GLM 后提前返回，不会处理 Anthropic key
    // 所以 Anthropic apiKey 不会被覆盖为 test-anthropic-key
    expect(config.providers.anthropic.apiKey).not.toBe('test-anthropic-key');
  });

  it('全部未设置时回退到 mock', () => {
    const config = loadConfig();
    expect(config.provider).toBe('mock');
    expect(config.providers.anthropic.model).toBe('claude-sonnet-4-20250514');
    expect(config.providers.anthropic.maxTokens).toBe(4096);
  });

  it('默认配置应包含所有 provider 的默认值', () => {
    const config = loadConfig();
    expect(config.providers.anthropic).toBeTruthy();
    expect(config.providers['openai-compatible']).toBeTruthy();
    expect(config.providers.local).toBeTruthy();
    expect(config.providers.anthropic.maxTokens).toBe(4096);
    expect(config.providers['openai-compatible'].maxTokens).toBe(4096);
    expect(config.providers.local.maxTokens).toBe(4096);
  });
});

describe('getConfigDir', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('应该返回用户主目录下的 .codex', () => {
    const dir = getConfigDir();
    expect(dir).toContain('.codex');
  });

  it('CODEX_CONFIG_PATH 环境变量应覆盖默认路径', () => {
    setEnv('CODEX_CONFIG_PATH', '/custom/config/path');
    const dir = getConfigDir();
    expect(dir).toBe('/custom/config/path');
  });
});

describe('getProviderDisplayName', () => {
  function makeConfig(provider: CodexConfig['provider']): CodexConfig {
    return {
      provider,
      providers: {
        anthropic: { apiKey: '', model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
        'openai-compatible': { apiKey: '', baseURL: 'https://test/v1', model: 'glm-4.7-flash', maxTokens: 4096 },
        local: { baseURL: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', maxTokens: 4096 },
      },
    };
  }

  it('anthropic 模式应显示模型名', () => {
    const name = getProviderDisplayName(makeConfig('anthropic'));
    expect(name).toContain('Anthropic');
    expect(name).toContain('claude-sonnet-4-20250514');
  });

  it('openai-compatible 模式应显示模型名', () => {
    const name = getProviderDisplayName(makeConfig('openai-compatible'));
    expect(name).toContain('OpenAI Compatible');
    expect(name).toContain('glm-4.7-flash');
  });

  it('local 模式应显示模型名', () => {
    const name = getProviderDisplayName(makeConfig('local'));
    expect(name).toContain('Local');
    expect(name).toContain('qwen2.5-coder:7b');
  });

  it('mock 模式应显示 Mock', () => {
    const name = getProviderDisplayName(makeConfig('mock'));
    expect(name).toBe('Mock');
  });
});