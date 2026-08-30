/**
 * V4.0 多智能体编排测试 — 对应 V4.0-ITERATION-PROMPT.md 执行清单
 * 覆盖：计划容错解析 / createTaskPlan / looksComplex 启发式 / 编排闭环（成功/重试/耗尽终止/降级）
 */
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIProvider, StreamEvent, ToolDefinition } from '../src/utils/ai-client.js';
import type { Message } from '../src/core/message-manager.js';
import { parsePlanResponse, createTaskPlan, PLANNER_MAX_STEPS } from '../src/core/planner.js';
import { runPlannedTask, looksComplex } from '../src/core/orchestrator.js';
import { resetSharedContextEngine } from '../src/context/context-engine.js';
import type { AgentCallbacks } from '../src/core/agent-loop.js';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';
import { registerBuiltinTools, clearTools } from '../src/tools/builtin.js';

// 隔离配置目录与工作目录：上下文引擎绝不污染真实 ~/.codex，也不索引仓库本体
let configDir: string;
let workDir: string;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codex-orch-config-'));
  process.env.CODEX_CONFIG_PATH = configDir;
  workDir = mkdtempSync(join(tmpdir(), 'codex-orch-work-'));
});

afterAll(() => {
  resetSharedContextEngine();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

// ---- 测试用脚本化 Provider ----

/** stream 返回计划文本；streamWithTools 返回步骤文本（并记录收到的消息供断言） */
class FakeProvider implements AIProvider {
  readonly name = 'fake';
  /** 每次 streamWithTools 收到的最后一条用户消息（断言重试反馈注入用） */
  readonly receivedUserMsgs: string[] = [];

  constructor(
    private readonly planResponse: string,
    private readonly stepResponse = '步骤已完成。',
  ) {}

  async *stream(): AsyncGenerator<string, void, undefined> {
    yield this.planResponse;
  }

  async *streamWithTools(
    messages: Message[],
    _systemPrompt: string,
    _tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    this.receivedUserMsgs.push(typeof lastUser?.content === 'string' ? lastUser.content : '');
    yield { type: 'text_delta', text: this.stepResponse };
    yield { type: 'token_usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    yield { type: 'done' };
  }
}

/** 永远抛错的 Provider（测试规划调用失败降级） */
class ThrowingProvider extends FakeProvider {
  constructor() {
    super('unused');
  }
  async *stream(): AsyncGenerator<string, void, undefined> {
    throw new Error('provider down');
  }
}

function noopCallbacks(): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}

function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: new Date().toISOString() };
}

// ---- 计划容错解析 ----

describe('parsePlanResponse', () => {
  it('裸 JSON 解析', () => {
    const plan = parsePlanResponse('{"steps": ["读取配置", "修改代码"]}', '任务');
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[0].description).toBe('读取配置');
    expect(plan!.steps[0].status).toBe('pending');
    expect(plan!.description).toBe('任务');
  });

  it('```json 围栏块剥离', () => {
    const raw = '```json\n{"steps": ["步骤一"]}\n```';
    expect(parsePlanResponse(raw, '任务')!.steps).toHaveLength(1);
  });

  it('前后散文包裹（首个 { 到末个 }）', () => {
    const raw = '好的，计划如下：\n{"steps": ["a", "b"]}\n如果需要调整请告诉我。';
    expect(parsePlanResponse(raw, '任务')!.steps).toHaveLength(2);
  });

  it('步数超过上限裁剪到 PLANNER_MAX_STEPS', () => {
    const steps = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    const plan = parsePlanResponse(JSON.stringify({ steps }), '任务');
    expect(plan!.steps).toHaveLength(PLANNER_MAX_STEPS);
  });

  it('非字符串/空白项被过滤', () => {
    const plan = parsePlanResponse('{"steps": ["a", 1, null, "", "b"]}', '任务');
    expect(plan!.steps.map((s) => s.description)).toEqual(['a', 'b']);
  });

  it('空步数组 → null（模型判定无需拆解 = 降级）', () => {
    expect(parsePlanResponse('{"steps": []}', '任务')).toBeNull();
  });

  it('垃圾输出 → null', () => {
    expect(parsePlanResponse('我觉得这个任务不需要计划')).toBeNull();
    expect(parsePlanResponse('{"wrong": true}')).toBeNull();
    expect(parsePlanResponse('')).toBeNull();
  });
});

// ---- createTaskPlan ----

describe('createTaskPlan', () => {
  it('Provider 返回合法 JSON → 计划', async () => {
    const provider = new FakeProvider('{"steps": ["先读文件", "再改代码"]}');
    const plan = await createTaskPlan(provider, '重构配置模块');
    expect(plan!.steps).toHaveLength(2);
  });

  it('Provider 返回垃圾 → null', async () => {
    const provider = new FakeProvider('这个问题很简单，直接做就行');
    expect(await createTaskPlan(provider, '任务')).toBeNull();
  });

  it('Provider 抛错 → null（不向上传播）', async () => {
    const provider = new ThrowingProvider();
    expect(await createTaskPlan(provider, '任务')).toBeNull();
  });
});

// ---- 启发式 ----

describe('looksComplex', () => {
  it('多步信号词判定复杂', () => {
    expect(looksComplex('先重构 auth 模块，然后迁移到新配置')).toBe(true);
    expect(looksComplex('批量修改所有文件的导入路径')).toBe(true);
    expect(looksComplex('first read the config, then update the code')).toBe(true);
  });

  it('简单查询不判定复杂', () => {
    expect(looksComplex('这个函数是干嘛的')).toBe(false);
    expect(looksComplex('what does this do')).toBe(false);
  });

  it('超长描述判定复杂', () => {
    expect(looksComplex('a'.repeat(60))).toBe(true);
  });
});

// ---- 编排闭环 ----

describe('runPlannedTask', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
  });

  it('成功路径：全部步骤完成，无重试', async () => {
    const provider = new FakeProvider('{"steps": ["步骤甲", "步骤乙"]}');
    const verify = vi.fn().mockResolvedValue({ success: true, output: '' });

    const result = await runPlannedTask({
      provider,
      messages: [userMsg('做个两步任务')],
      fs: new InMemoryFileSystem(),
      workingDir: workDir,
      callbacks: noopCallbacks(),
      verify,
    });

    expect(result.mode).toBe('planned');
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
    expect(result.steps.every((s) => s.attempts === 1)).toBe(true);
    expect(result.hasError).toBe(false);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('验证失败 → 反馈重试 → 成功（attempts = 2）', async () => {
    const provider = new FakeProvider('{"steps": ["步骤甲"]}');
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ success: false, output: 'error TS2304: Cannot find name foo' })
      .mockResolvedValueOnce({ success: true, output: '' });

    const result = await runPlannedTask({
      provider,
      messages: [userMsg('修复类型错误')],
      fs: new InMemoryFileSystem(),
      workingDir: workDir,
      callbacks: noopCallbacks(),
      verify,
    });

    expect(result.steps[0].status).toBe('completed');
    expect(result.steps[0].attempts).toBe(2);
    // 重试消息包含验证错误反馈
    expect(provider.receivedUserMsgs[1]).toContain('verify_failure');
    expect(provider.receivedUserMsgs[1]).toContain('TS2304');
  });

  it('重试耗尽 → 步骤失败 → 后续步骤终止', async () => {
    const provider = new FakeProvider('{"steps": ["步骤甲", "步骤乙", "步骤丙"]}');
    const verify = vi.fn().mockResolvedValue({ success: false, output: 'error TS1: broken' });

    const result = await runPlannedTask({
      provider,
      messages: [userMsg('三步任务')],
      fs: new InMemoryFileSystem(),
      workingDir: workDir,
      callbacks: noopCallbacks(),
      verify,
    });

    // 只执行了第一个步骤（默认重试 1 次 → attempts = 2）
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].attempts).toBe(2);
    expect(result.steps[0].verifyOutput).toContain('TS1');
    expect(result.hasError).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('计划解析失败 → 降级单循环（mode = fallback）', async () => {
    const provider = new FakeProvider('这任务太简单了，不需要计划');
    const verify = vi.fn();

    const result = await runPlannedTask({
      provider,
      messages: [userMsg('简单任务')],
      fs: new InMemoryFileSystem(),
      workingDir: workDir,
      callbacks: noopCallbacks(),
      verify,
    });

    expect(result.mode).toBe('fallback');
    expect(result.steps).toEqual([]);
    // 降级路径直接走单循环，不触发验证器
    expect(verify).not.toHaveBeenCalled();
    expect(result.text).toBe('步骤已完成。');
  });

  it('步骤消息携带计划上下文与前序结果', async () => {
    const provider = new FakeProvider('{"steps": ["步骤甲", "步骤乙"]}');
    const verify = vi.fn().mockResolvedValue({ success: true, output: '' });

    await runPlannedTask({
      provider,
      messages: [userMsg('两步任务')],
      fs: new InMemoryFileSystem(),
      workingDir: workDir,
      callbacks: noopCallbacks(),
      verify,
    });

    // 第二步消息应包含计划概览与本步定位
    const second = provider.receivedUserMsgs[1];
    expect(second).toContain('multi_step_plan');
    expect(second).toContain('第 2/2 步');
    expect(second).toContain('步骤乙');
    expect(second).toContain('步骤甲 ✓');
  });
});
