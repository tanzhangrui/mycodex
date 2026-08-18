/**
 * V1.3 — 多模型智能路由
 * ==========================================
 *
 * 根据任务复杂度自动选择模型：
 * - 简单任务（"列出文件"、"读取 foo.ts"）→ GLM-4.7-flash（免费，快）
 * - 复杂任务（"重构整个模块"、"分析架构问题"）→ 如果有 Claude Key 就用 Claude，否则用 GLM
 */

import type { Message } from './message-manager.js';
import type { AIProvider } from '../utils/ai-client.js';
import { createProvider } from '../utils/ai-client.js';
import type { CodexConfig } from '../config/config.js';

// ---- 分类 ----

export type TaskComplexity = 'simple' | 'complex';

/** 复杂任务关键词 */
const COMPLEX_KEYWORDS = [
  '重构', '重写', '架构', '设计', '分析',
  '优化', '性能', '调试', '修复bug', '修复Bug',
  '增加功能', '添加功能', '新增', '实现',
  'refactor', 'rewrite', 'architecture', 'design', 'analyze',
  'optimize', 'performance', 'debug', 'fix', 'implement',
  'migrate', '迁移', '升级', 'upgrade',
];

/** 简单任务的最大字符数 */
const SIMPLE_MAX_LENGTH = 50;

/**
 * 判断任务复杂度
 * 规则：
 * - 用户消息 < 50 字 + 不含复杂关键词 → simple
 * - 否则 → complex
 */
export function classifyTask(messages: Message[]): TaskComplexity {
  // 获取最后一条用户消息
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return 'simple';

  const content = typeof lastUserMsg.content === 'string'
    ? lastUserMsg.content
    : JSON.stringify(lastUserMsg.content);

  // 长度检查
  if (content.length > SIMPLE_MAX_LENGTH) return 'complex';

  // 关键词检查
  const lowerContent = content.toLowerCase();
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      return 'complex';
    }
  }

  return 'simple';
}

// ---- 路由结果 ----

export interface RouteResult {
  provider: AIProvider;
  displayName: string;
  isAuto: boolean;
}

/**
 * 根据任务复杂度选择 Provider
 * @param config      Codex 配置
 * @param messages    消息历史（用于判断复杂度）
 * @param forceProvider  用户手动指定的 provider（跳过路由）
 */
export function routeProvider(
  config: CodexConfig,
  messages: Message[],
  forceProvider?: string,
): RouteResult {
  // 用户手动指定了 provider，跳过路由
  if (forceProvider && forceProvider !== 'auto') {
    return {
      provider: createProvider({ ...config, provider: forceProvider as CodexConfig['provider'] }),
      displayName: forceProvider,
      isAuto: false,
    };
  }

  const complexity = classifyTask(messages);

  if (complexity === 'simple') {
    // 简单任务 → GLM
    const glmConfig = { ...config, provider: 'openai-compatible' as const };
    return {
      provider: createProvider(glmConfig),
      displayName: `GLM-4.7-flash (自动选择)`,
      isAuto: true,
    };
  }

  // 复杂任务 → 如果有 Anthropic Key 就用 Anthropic，否则回退 GLM
  if (config.providers.anthropic.apiKey) {
    const anthroConfig = { ...config, provider: 'anthropic' as const };
    return {
      provider: createProvider(anthroConfig),
      displayName: `Claude (自动选择)`,
      isAuto: true,
    };
  }

  // 回退到 GLM
  const glmConfig = { ...config, provider: 'openai-compatible' as const };
  return {
    provider: createProvider(glmConfig),
    displayName: `GLM-4.7-flash (自动选择)`,
    isAuto: true,
  };
}

/**
 * 获取当前路由决策的显示名称
 */
export function getModelDisplayName(
  _complexity: TaskComplexity,
  modelName: string,
  isAuto: boolean,
): string {
  if (!isAuto) return modelName;
  return `${modelName} (自动选择)`;
}