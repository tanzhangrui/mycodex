/**
 * V4.0 — Planner（任务拆解）
 * ==========================================
 *
 * 单次廉价模型调用把复杂任务拆解为步骤 JSON。
 * 设计决策：
 * - 纯文本通道（provider.stream），不挂工具——规划只产出文本，执行另走 Editor
 * - 容错解析是核心：廉价模型输出围栏/前后缀散文是常态，解析失败返回 null
 *   （调用方降级为单循环，绝不阻断）
 * - 步数上限 8：步骤过多 = 规划幻觉，宁少勿滥
 */

import type { AIProvider } from '../utils/ai-client.js';
import type { Message } from './message-manager.js';
import type { ExecutionPlan } from './sub-agent.js';

/** 计划步数上限（超过裁剪——步骤过多是规划幻觉信号） */
export const PLANNER_MAX_STEPS = 8;

export const PLANNER_SYSTEM_PROMPT = `You are a task planner for a CLI coding agent.
Decompose the user's task into a short sequence of concrete, executable steps.

Rules:
- Output STRICT JSON only. No prose, no markdown fences.
- Format: {"steps": ["step 1", "step 2", ...]}
- 2 to ${PLANNER_MAX_STEPS} steps. Each step is one imperative sentence (what to do, which files if known).
- Each step must be independently verifiable (compiles / testable / checkable).
- If the task is trivial and needs no decomposition, return {"steps": []}.
- Respond in the same language as the user's task.`;

/**
 * 容错解析模型输出 → ExecutionPlan。纯函数。
 * 依次尝试：```json 围栏块 → 首个 { 到末个 } 的子串 → 整体。
 * 形状校验：steps 必须是非空字符串数组；空数组/垃圾 → null。
 */
export function parsePlanResponse(raw: string, taskDescription: string): ExecutionPlan | null {
  const candidates: string[] = [];

  // 1) 围栏代码块优先（```json ... ``` 或 ``` ... ```）
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // 2) 首个 { 到最后一个 } 的子串（剥离前后散文）
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));

  // 3) 整体
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const steps = extractSteps(parsed);
    if (steps === null) continue;

    // 空计划 = 模型判定无需拆解 → 视为解析失败（调用方降级单循环）
    if (steps.length === 0) return null;

    return {
      id: `plan_${Date.now()}`,
      description: taskDescription,
      steps: steps.map((desc, i) => ({
        id: `step_${i + 1}`,
        description: desc,
        status: 'pending' as const,
      })),
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

/** 形状校验 + 清洗：非空字符串数组；裁剪到 PLANNER_MAX_STEPS；形状不符返回 null */
function extractSteps(parsed: unknown): string[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rawSteps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps)) return null;

  const steps = rawSteps
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (steps.length === 0) return null;
  return steps.slice(0, PLANNER_MAX_STEPS);
}

/**
 * 生成执行计划：单次廉价模型纯文本调用。
 * 任何失败（流错误/超时/解析失败）→ null，调用方降级。
 */
export async function createTaskPlan(
  provider: AIProvider,
  task: string,
  signal?: AbortSignal,
): Promise<ExecutionPlan | null> {
  try {
    const messages: Message[] = [
      {
        role: 'user',
        content: `任务：${task}`,
        timestamp: new Date().toISOString(),
      },
    ];

    let raw = '';
    for await (const delta of provider.stream(messages, PLANNER_SYSTEM_PROMPT, signal)) {
      raw += delta;
    }

    return parsePlanResponse(raw, task);
  } catch {
    return null;
  }
}
