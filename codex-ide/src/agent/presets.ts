/**
 * 模型预设与成本路由 — 对应主提示词 ADR-4
 *
 * 三级成本路由：
 * - free:    GLM-4.7-flash / SiliconFlow 免费档（默认，¥0）
 * - cheap:   DeepSeek 系列（复杂任务自动升级，约为旗舰 1/30 价格）
 * - premium: Claude（仅用户显式配置时启用）
 * - local:   Ollama 本地模型（离线免费，6G 显存可跑 7B 量化档）
 *
 * 价格为约数（CNY / 百万 token），仅供成本估算展示，可在设置中校正。
 */

import type { ProviderType } from '../../../src/config/config.js';

export type CostTier = 'free' | 'cheap' | 'premium' | 'local';

export interface ModelPreset {
  id: string;
  label: string;
  providerType: ProviderType;
  baseURL: string;
  model: string;
  maxTokens: number;
  /** 用于查找 API Key 的环境变量名（按优先级） */
  envKeys: string[];
  /** SecretStorage 存储键 */
  secretKey: string;
  tier: CostTier;
  /** 约数价格（¥ / 百万 token），0 = 免费 */
  pricing: { inputPer1M: number; outputPer1M: number };
  description: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'glm-flash',
    label: 'GLM-4.7-flash（免费）',
    providerType: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    maxTokens: 4096,
    envKeys: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    secretKey: 'codex-ide.apiKey.glm-flash',
    tier: 'free',
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    description: '智谱免费模型，日常任务默认选择，¥0 成本',
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek-V3（低价强模型）',
    providerType: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    maxTokens: 8192,
    envKeys: ['DEEPSEEK_API_KEY'],
    secretKey: 'codex-ide.apiKey.deepseek',
    tier: 'cheap',
    pricing: { inputPer1M: 2, outputPer1M: 3 },
    description: '复杂任务自动升级档，价格约为旗舰模型 1/30',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek-R1（深度推理）',
    providerType: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-reasoner',
    maxTokens: 8192,
    envKeys: ['DEEPSEEK_API_KEY'],
    secretKey: 'codex-ide.apiKey.deepseek',
    tier: 'cheap',
    pricing: { inputPer1M: 4, outputPer1M: 16 },
    description: '数学/架构级推理任务',
  },
  {
    id: 'glm-plus',
    label: 'GLM-4.6（智谱旗舰）',
    providerType: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    maxTokens: 8192,
    envKeys: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    secretKey: 'codex-ide.apiKey.glm-flash',
    tier: 'cheap',
    pricing: { inputPer1M: 4, outputPer1M: 16 },
    description: '智谱付费旗舰，中文能力强',
  },
  {
    id: 'qwen-plus',
    label: '通义千问 Qwen-Plus',
    providerType: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    maxTokens: 8192,
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    secretKey: 'codex-ide.apiKey.qwen',
    tier: 'cheap',
    pricing: { inputPer1M: 0.8, outputPer1M: 2 },
    description: '阿里云百炼，新用户有免费额度',
  },
  {
    id: 'kimi-k2',
    label: 'Kimi K2（Moonshot）',
    providerType: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    maxTokens: 8192,
    envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    secretKey: 'codex-ide.apiKey.kimi',
    tier: 'cheap',
    pricing: { inputPer1M: 4, outputPer1M: 16 },
    description: '月之暗面，长上下文与工具调用强',
  },
  {
    id: 'siliconflow-free',
    label: '硅基流动 免费档（Qwen2.5-7B）',
    providerType: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    maxTokens: 4096,
    envKeys: ['SILICONFLOW_API_KEY'],
    secretKey: 'codex-ide.apiKey.siliconflow',
    tier: 'free',
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    description: '硅基流动永久免费模型，备用免费档',
  },
  {
    id: 'ollama-local',
    label: 'Ollama 本地（离线免费）',
    providerType: 'local',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    maxTokens: 4096,
    envKeys: [],
    secretKey: '',
    tier: 'local',
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    description: '完全离线，隐私最强；6G 显存建议 7B 量化档',
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet（旗舰，可选）',
    providerType: 'anthropic',
    baseURL: '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
    envKeys: ['ANTHROPIC_API_KEY'],
    secretKey: 'codex-ide.apiKey.anthropic',
    tier: 'premium',
    pricing: { inputPer1M: 22, outputPer1M: 108 },
    description: '仅在免费/低价档无法胜任时显式启用',
  },
];

export const AUTO_PRESET_ID = 'auto';

export function getPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}

/** 估算单次调用成本（¥） */
export function estimateCost(
  preset: ModelPreset,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000_000) * preset.pricing.inputPer1M +
    (completionTokens / 1_000_000) * preset.pricing.outputPer1M
  );
}

/**
 * 任务复杂度启发式 — 廉价模型补位策略的核心：
 * 简单任务绝不浪费强模型（主提示词战略判断 #2）
 */
export function estimateComplexity(userText: string): 'low' | 'high' {
  const highPatterns =
    /重构|架构|重写|迁移|整体设计|多文件|整个(项目|模块|代码库)|refactor|architecture|migrate|rewrite|optimi[sz]e.*(all|whole)|审查.*(全部|整个)/i;
  if (highPatterns.test(userText)) return 'high';
  if (userText.length > 500) return 'high';
  return 'low';
}
