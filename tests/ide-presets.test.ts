/**
 * IDE 模型预设与成本路由测试 — 扩展层纯逻辑（经 vitest 直测）
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_PRESETS,
  getPreset,
  estimateCost,
  estimateComplexity,
  pickEscalationPreset,
} from '../codex-ide/src/agent/presets.js';

describe('模型预设', () => {
  it('包含免费档与低价档', () => {
    const free = MODEL_PRESETS.filter((p) => p.tier === 'free');
    const cheap = MODEL_PRESETS.filter((p) => p.tier === 'cheap');
    expect(free.length).toBeGreaterThanOrEqual(2); // GLM flash + 硅基流动
    expect(cheap.length).toBeGreaterThanOrEqual(2); // DeepSeek 等
  });

  it('免费档定价必须为 0', () => {
    for (const p of MODEL_PRESETS.filter((x) => x.tier === 'free' || x.tier === 'local')) {
      expect(p.pricing.inputPer1M).toBe(0);
      expect(p.pricing.outputPer1M).toBe(0);
    }
  });

  it('getPreset 查找', () => {
    expect(getPreset('glm-flash')?.model).toBe('glm-4.7-flash');
    expect(getPreset('deepseek-chat')?.baseURL).toContain('deepseek');
    expect(getPreset('nonexistent')).toBeUndefined();
  });

  it('每个预设的 secretKey 不泄露到描述字段', () => {
    for (const p of MODEL_PRESETS) {
      expect(p.description).not.toMatch(/sk-|key/i);
    }
  });
});

describe('estimateCost', () => {
  it('免费模型成本为 0', () => {
    expect(estimateCost(getPreset('glm-flash')!, 1e6, 1e6)).toBe(0);
  });

  it('DeepSeek 成本按定价计算', () => {
    const cost = estimateCost(getPreset('deepseek-chat')!, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(2 + 3, 5);
  });
});

describe('estimateComplexity', () => {
  it('简单任务 → low', () => {
    expect(estimateComplexity('修复这个函数的拼写错误')).toBe('low');
    expect(estimateComplexity('解释这段代码')).toBe('low');
  });

  it('复杂任务 → high', () => {
    expect(estimateComplexity('重构整个模块架构')).toBe('high');
    expect(estimateComplexity('refactor the whole codebase')).toBe('high');
    expect(estimateComplexity('x'.repeat(600))).toBe('high');
  });
});

describe('pickEscalationPreset（失败升档）', () => {
  it('free 档失败 → 升级 deepseek-chat', () => {
    const esc = pickEscalationPreset(getPreset('glm-flash')!);
    expect(esc?.id).toBe('deepseek-chat');
  });

  it('cheap/premium/local 档失败 → 不升级（防账单失控）', () => {
    expect(pickEscalationPreset(getPreset('deepseek-chat')!)).toBeNull();
    expect(pickEscalationPreset(getPreset('claude-sonnet')!)).toBeNull();
    expect(pickEscalationPreset(getPreset('ollama-local')!)).toBeNull();
  });
});
