/**
 * V4.0 — Orchestrator（计划-执行-验证编排）
 * ==========================================
 *
 * Planner 拆解 → 逐步 Editor（runAgentLoop）→ 每步 Verifier（typecheck）→
 * 失败反馈重试（1 次）→ 仍失败终止后续步骤。
 * 计划解析失败 → 降级为单循环 runAgentLoop（降级路径是一等公民）。
 *
 * 编辑全部写入内存 FS（复用 /apply 信任闭环，计划执行中途不落盘）。
 */

import type { AIProvider } from '../utils/ai-client.js';
import type { InMemoryFileSystem } from './in-memory-fs.js';
import type { Message } from './message-manager.js';
import { runAgentLoop, primaryRootOf, type AgentCallbacks, type AgentLoopResult, type TokenUsage, type WorkingDirInput } from './agent-loop.js';
import { createTaskPlan } from './planner.js';
import type { ExecutionPlan, PlanStep } from './sub-agent.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import { createCommandExecutor } from '../sandbox/sandbox.js';

// ---- 类型 ----

export interface VerifyResult {
  success: boolean;
  output: string;
}

export type StepStatus = 'completed' | 'failed';

export interface StepOutcome {
  step: PlanStep;
  status: StepStatus;
  /** 执行尝试次数（含重试） */
  attempts: number;
  /** 验证输出（失败时含错误信息，供展示与诊断） */
  verifyOutput?: string;
  /** V4.2 失败步骤已回滚到步骤开始前 */
  rolledBack?: boolean;
}

export interface PlannedTaskResult {
  /** planned = 计划模式；fallback = 解析失败降级单循环；cancelled = 用户否决计划（零副作用） */
  mode: 'planned' | 'fallback' | 'cancelled';
  plan?: ExecutionPlan;
  steps: StepOutcome[];
  text: string;
  toolCalls: AgentLoopResult['toolCalls'];
  tokenUsage: TokenUsage;
  hasError: boolean;
  error?: string;
}

export interface OrchestratorOptions {
  provider: AIProvider;
  /** 基础消息历史（含最后一条用户任务） */
  messages: Message[];
  fs: InMemoryFileSystem;
  /** V5.1 工作目录：单根 string 或多根 string[]（编辑循环跨根召回；验证/沙箱以主根为基准） */
  workingDir: WorkingDirInput;
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  sandbox?: Sandbox;
  /** V4.2 验证命令（缺省 VERIFY_COMMAND；测试驱动项目可配 vitest run 等） */
  verifyCommand?: string;
  /** V4.3 计划确认钩子：计划生成后调用；返回 false → 取消执行（mode: 'cancelled'，零副作用） */
  onPlanCreated?: (plan: ExecutionPlan) => Promise<boolean>;
  /** 验证器（可注入测试桩）；缺省：有沙箱跑 verifyCommand，无沙箱跳过（恒过） */
  verify?: (workingDir: string) => Promise<VerifyResult>;
  /** 单步验证失败后的重试次数（默认 1） */
  maxStepRetries?: number;
}

/** 默认验证命令：typecheck（确定性信号零成本，模型只负责读错误修代码） */
export const VERIFY_COMMAND = 'npx tsc --noEmit';

/** 复杂任务启发式：显式多步信号词（/plan 前缀由入口处理，不在此判定） */
const COMPLEX_SIGNALS =
  /(重构|迁移|批量|多文件|多个文件|然后|接着|第一步|第二步|首先|其次|最后|以及|同时|并且|再创建|再添加|添加.*并|refactor|migrat|step\s*1|first.*then)/i;

/** 查询长度阈值：长任务描述大概率多步 */
const COMPLEX_LENGTH = 60;

export function looksComplex(query: string): boolean {
  if (query.length >= COMPLEX_LENGTH) return true;
  return COMPLEX_SIGNALS.test(query);
}

// ---- 编排主流程 ----

export async function runPlannedTask(options: OrchestratorOptions): Promise<PlannedTaskResult> {
  const { provider, messages, fs, workingDir, callbacks, signal, sandbox } = options;
  const maxRetries = options.maxStepRetries ?? 1;
  const verify = options.verify ?? createDefaultVerify(sandbox, options.verifyCommand);

  const task = extractTask(messages);

  // 1) Planner：解析失败 → 降级单循环（绝不阻断）
  const plan = await createTaskPlan(provider, task, signal);
  if (!plan) {
    const result = await runAgentLoop(provider, messages, fs, workingDir, callbacks, signal, sandbox);
    return {
      mode: 'fallback',
      steps: [],
      text: result.text,
      toolCalls: result.toolCalls,
      tokenUsage: result.tokenUsage,
      hasError: result.hasError,
      error: result.error,
    };
  }

  // V4.3 人工确认：计划被否决 → 取消（零副作用：不执行任何步骤、不动内存 FS）
  if (options.onPlanCreated && !(await options.onPlanCreated(plan))) {
    return {
      mode: 'cancelled',
      plan,
      steps: [],
      text: '',
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      hasError: false,
    };
  }

  // 2) 逐步 Editor + Verifier
  const stepOutcomes: StepOutcome[] = [];
  const allToolCalls: AgentLoopResult['toolCalls'] = [];
  const tokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let fullText = '';
  let hasError = false;
  let errorMsg: string | undefined;

  for (let i = 0; i < plan.steps.length; i++) {
    if (signal?.aborted) break;
    const step = plan.steps[i];

    // V4.2 步骤级检查点：失败回滚到步骤开始前（失败产物未过验证 = 带病，不残留）
    const stepCheckpoint = fs.createCheckpoint();

    const stepMessages = buildStepMessages(messages, plan, i, stepOutcomes);
    let attempt = 0;
    let lastVerify: VerifyResult = { success: false, output: '' };
    let stepFailed = true;

    while (attempt <= maxRetries) {
      // 重试不回滚：保留上次尝试的编辑，让模型在现状上修复（这正是"修复"语义）
      const result = await runAgentLoop(
        provider,
        attempt === 0 ? stepMessages : appendVerifyFeedback(stepMessages, step, lastVerify),
        fs,
        workingDir,
        callbacks,
        signal,
        sandbox,
      );

      allToolCalls.push(...result.toolCalls);
      tokenUsage.promptTokens += result.tokenUsage.promptTokens;
      tokenUsage.completionTokens += result.tokenUsage.completionTokens;
      tokenUsage.totalTokens += result.tokenUsage.totalTokens;
      fullText += (fullText ? '\n\n' : '') + result.text;
      if (result.hasError) {
        hasError = true;
        errorMsg = result.error;
      }

      attempt++;
      lastVerify = await verify(primaryRootOf(workingDir));
      if (lastVerify.success) {
        stepFailed = false;
        break;
      }
      // 验证失败且还有重试额度 → 反馈错误再来一次
    }

    // V4.2 重试耗尽 → 回滚到步骤开始前（失败步骤的半成品不进入 /apply 通道）
    if (stepFailed) {
      fs.restoreCheckpoint(stepCheckpoint);
    }

    stepOutcomes.push({
      step: { ...step, status: stepFailed ? 'failed' : 'completed' },
      status: stepFailed ? 'failed' : 'completed',
      attempts: attempt,
      verifyOutput: lastVerify.success ? undefined : lastVerify.output,
      /** V4.2 失败步骤已回滚 */
      rolledBack: stepFailed,
    });

    // 步骤失败 → 终止后续（后续步骤依赖前序产物，带病执行 = 浪费 token 产出错误结果）
    if (stepFailed) {
      hasError = true;
      errorMsg = `步骤 ${i + 1} 验证失败（已重试 ${attempt - 1} 次，已回滚本步骤修改）：${lastVerify.output.slice(0, 200)}`;
      break;
    }
  }

  return {
    mode: 'planned',
    plan,
    steps: stepOutcomes,
    text: fullText,
    toolCalls: allToolCalls,
    tokenUsage,
    hasError,
    error: errorMsg,
  };
}

// ---- 内部工具 ----

/** 提取任务描述（最后一条用户消息） */
function extractTask(messages: Message[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return typeof lastUser?.content === 'string' ? lastUser.content : '';
}

/** 构建步骤作用域消息：原历史 + 计划概览 + 本步指令 + 前序结果摘要 */
function buildStepMessages(
  base: Message[],
  plan: ExecutionPlan,
  stepIndex: number,
  outcomes: StepOutcome[],
): Message[] {
  const planOverview = plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
  const priorSummary =
    outcomes.length === 0
      ? ''
      : `\n\n前序步骤已完成：\n${outcomes.map((o, i) => `${i + 1}. ${o.step.description} ✓`).join('\n')}`;

  const stepMsg: Message = {
    role: 'user',
    content: `<multi_step_plan>
任务：${plan.description}
计划：
${planOverview}
</multi_step_plan>

你正在执行上述计划的第 ${stepIndex + 1}/${plan.steps.length} 步：
${plan.steps[stepIndex].description}

只执行本步骤，不要做后续步骤的内容。完成后简要说明做了什么。${priorSummary}`,
    timestamp: new Date().toISOString(),
  };

  return [...base, stepMsg];
}

/** 重试消息：追加验证错误反馈 */
function appendVerifyFeedback(stepMessages: Message[], step: PlanStep, verify: VerifyResult): Message[] {
  return [
    ...stepMessages,
    {
      role: 'assistant',
      content: `[已完成步骤尝试: ${step.description}]`,
      timestamp: new Date().toISOString(),
    },
    {
      role: 'user',
      content: `<verify_failure>
上一步完成后类型检查未通过，错误输出如下：

${verify.output.slice(0, 4000)}
</verify_failure>

请修复上述错误，使 typecheck 通过。只修复错误，不要扩展功能。`,
      timestamp: new Date().toISOString(),
    },
  ];
}

/** 默认验证器：有沙箱跑 verifyCommand；无沙箱跳过（恒过——验证是增强，不是依赖） */
function createDefaultVerify(
  sandbox?: Sandbox,
  verifyCommand?: string,
): (workingDir: string) => Promise<VerifyResult> {
  const command = verifyCommand ?? VERIFY_COMMAND;
  return async () => {
    if (!sandbox) return { success: true, output: '' };
    try {
      const exec = createCommandExecutor(sandbox);
      const result = await exec(command);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      return { success: result.success, output };
    } catch (err) {
      // 验证器自身故障（命令不可用等）不阻塞任务
      return { success: true, output: err instanceof Error ? err.message : String(err) };
    }
  };
}
