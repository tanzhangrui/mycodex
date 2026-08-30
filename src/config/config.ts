/**
 * V1.1 — 多 Provider 配置管理
 * ==========================================
 *
 * 支持四种 Provider：
 * - anthropic:  Anthropic Claude (付费)
 * - openai-compatible: GLM / DeepSeek / 通义千问 / 硅基流动 (兼容 OpenAI API)
 * - local:  Ollama 等本地模型 (免费)
 * - mock:  模拟回复 (无需 API Key)
 *
 * 配置优先级：环境变量 > JSON 配置文件 > 默认值
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---- 类型定义 ----

export type ProviderType = 'anthropic' | 'openai-compatible' | 'local' | 'mock';

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens: number;
}

export interface LocalProviderConfig {
  baseURL: string;
  model: string;
  maxTokens: number;
}

export interface CodexConfig {
  /** 当前使用的 provider */
  provider: ProviderType;
  /** 各 provider 的独立配置 */
  providers: {
    anthropic: AnthropicProviderConfig;
    'openai-compatible': OpenAICompatibleProviderConfig;
    local: LocalProviderConfig;
  };
  /** 系统提示词（可选覆盖） */
  systemPrompt?: string;
  /** V4.2 多步计划每步后的验证命令（默认 npx tsc --noEmit；测试驱动项目可配 vitest run 等） */
  planVerifyCommand?: string;
  /** 插件路径列表 */
  plugins?: string[];
  /** MCP Server 配置列表 */
  mcpServers?: Array<{ command: string; args?: string[] }>;
}

// ---- 默认值 ----

const DEFAULT_CONFIG: CodexConfig = {
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
};

// ---- 路径工具 ----

export function getConfigDir(): string {
  const envPath = process.env.CODEX_CONFIG_PATH;
  if (envPath) return envPath;
  return join(homedir(), '.codex');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

// ---- 环境变量解析 ----

/**
 * 从环境变量检测可用的 Provider 配置
 * 优先级：GLM → Anthropic → Ollama → mock
 */
function detectProviderFromEnv(): {
  provider: ProviderType;
  overrides: Partial<{
    anthropic: Partial<AnthropicProviderConfig>;
    'openai-compatible': Partial<OpenAICompatibleProviderConfig>;
    local: Partial<LocalProviderConfig>;
  }>;
} {
  const overrides: Record<string, Record<string, unknown>> = {
    anthropic: {},
    'openai-compatible': {},
    local: {},
  };

  // GLM (openai-compatible)
  if (process.env.GLM_API_KEY) {
    overrides['openai-compatible'].apiKey = process.env.GLM_API_KEY;
    if (process.env.GLM_MODEL) overrides['openai-compatible'].model = process.env.GLM_MODEL;
    if (process.env.GLM_BASE_URL) overrides['openai-compatible'].baseURL = process.env.GLM_BASE_URL;
    return {
      provider: 'openai-compatible',
      overrides: overrides as typeof overrides,
    };
  }

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    overrides.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_MODEL) overrides.anthropic.model = process.env.ANTHROPIC_MODEL;
    return {
      provider: 'anthropic',
      overrides: overrides as typeof overrides,
    };
  }

  // Ollama (local)
  if (process.env.OLLAMA_BASE_URL) {
    overrides.local.baseURL = process.env.OLLAMA_BASE_URL;
    if (process.env.OLLAMA_MODEL) overrides.local.model = process.env.OLLAMA_MODEL;
    return {
      provider: 'local',
      overrides: overrides as typeof overrides,
    };
  }

  return { provider: 'mock', overrides: overrides as typeof overrides };
}

// ---- 配置读取 ----

/**
 * 读取配置：JSON 文件 → 环境变量覆盖
 */
export function loadConfig(): CodexConfig {
  // 1. 从 JSON 文件读取
  let config: CodexConfig = { ...DEFAULT_CONFIG };
  const configPath = getConfigPath();

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // 深度合并（保留旧格式兼容）
    if (typeof parsed.provider === 'string') {
      config.provider = parsed.provider;
    }
    if (parsed.providers) {
      if (parsed.providers.anthropic) {
        Object.assign(config.providers.anthropic, parsed.providers.anthropic);
      }
      if (parsed.providers['openai-compatible']) {
        Object.assign(config.providers['openai-compatible'], parsed.providers['openai-compatible']);
      }
      if (parsed.providers.local) {
        Object.assign(config.providers.local, parsed.providers.local);
      }
    }
    // 兼容旧格式（单 apiKey）
    if (parsed.apiKey && !config.providers.anthropic.apiKey) {
      config.providers.anthropic.apiKey = parsed.apiKey;
      config.provider = 'anthropic';
    }
    if (parsed.model) {
      config.providers.anthropic.model = parsed.model;
    }
    if (parsed.maxTokens) {
      config.providers.anthropic.maxTokens = parsed.maxTokens;
    }
    if (parsed.systemPrompt) {
      config.systemPrompt = parsed.systemPrompt;
    }
    if (Array.isArray(parsed.plugins)) {
      config.plugins = parsed.plugins;
    }
    if (Array.isArray(parsed.mcpServers)) {
      config.mcpServers = parsed.mcpServers;
    }
  } catch {
    // 配置文件不存在或损坏，使用默认值
  }

  // 2. 环境变量覆盖
  const { provider: envProvider, overrides } = detectProviderFromEnv();
  if (envProvider !== 'mock') {
    config.provider = envProvider;
  }
  if (overrides.anthropic && Object.keys(overrides.anthropic).length > 0) {
    Object.assign(config.providers.anthropic, overrides.anthropic);
  }
  if (overrides['openai-compatible'] && Object.keys(overrides['openai-compatible']).length > 0) {
    Object.assign(config.providers['openai-compatible'], overrides['openai-compatible']);
  }
  if (overrides.local && Object.keys(overrides.local).length > 0) {
    Object.assign(config.providers.local, overrides.local);
  }

  return config;
}

/**
 * 保存配置到磁盘
 */
export function saveConfig(config: CodexConfig): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 初始化配置目录和默认配置文件
 */
export function initConfig(): CodexConfig {
  const config = loadConfig();
  const configDir = getConfigDir();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    saveConfig(config);
  }

  return config;
}

/**
 * 获取当前 Provider 的显示名称
 */
export function getProviderDisplayName(config: CodexConfig): string {
  switch (config.provider) {
    case 'mock':
      return 'Mock';
    case 'anthropic':
      return `Anthropic (${config.providers.anthropic.model})`;
    case 'openai-compatible':
      return `OpenAI Compatible (${config.providers['openai-compatible'].model})`;
    case 'local':
      return `Local (${config.providers.local.model})`;
    default:
      return config.provider;
  }
}