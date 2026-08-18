/**
 * V0.5 — 子 Agent 委派系统
 * ==========================================
 *
 * 设计决策：
 * 1. 使用 worker_threads 实现并行子 Agent
 *    - 每个子 Agent 独立运行，通过 MessageChannel 通信
 *    - 主 Agent 负责任务拆解和结果合并
 *
 * 2. 会话分支：Git 式分支管理
 *    - 可以从任意消息点 fork 新分支
 *    - 支持切换、合并、丢弃分支
 *    - 分支数据存储在 JSON 文件中
 *
 * 3. 计划-执行模式
 *    - 复杂任务先输出计划步骤
 *    - 用户确认后逐步执行
 *    - 每个步骤可独立回滚
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { getConfigDir } from '../config/config.js';
import type { Message } from '../core/message-manager.js';

// ---- 子 Agent 类型 ----

export interface SubAgentTask {
  id: string;
  description: string;
  /** 要执行的工具调用 */
  toolName: string;
  toolParams: Record<string, unknown>;
}

export interface SubAgentResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
}

/**
 * 并行执行子任务（使用 Promise.all，fallback 到顺序执行）
 * 注：原计划使用 worker_threads，但 worker 需要独立的 .js 文件入口
 * V0.5 使用 Promise.all 并行执行工具调用，效果相同
 */
export async function runSubAgents(
  tasks: SubAgentTask[],
  executeTool: (name: string, params: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>,
): Promise<SubAgentResult[]> {
  const results = await Promise.all(
    tasks.map(async (task) => {
      try {
        const result = await executeTool(task.toolName, task.toolParams);
        return {
          taskId: task.id,
          success: result.success,
          output: result.output,
          error: result.error,
        };
      } catch (err) {
        return {
          taskId: task.id,
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return results;
}

// ---- 会话分支 ----

export interface SessionBranch {
  id: string;
  name: string;
  parentBranchId: string | null;
  /** 从哪个消息索引 fork */
  forkPoint: number;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface BranchStore {
  branches: SessionBranch[];
  currentBranchId: string;
}

/**
 * 会话分支管理器
 */
export class BranchManager {
  private store: BranchStore;
  private storePath: string;

  constructor(sessionId: string) {
    const dir = getConfigDir();
    this.storePath = join(dir, `branches_${sessionId}.json`);
    this.store = this.load();
  }

  /**
   * 创建新分支
   */
  createBranch(name: string, messages: Message[], forkPoint: number): SessionBranch {
    const branch: SessionBranch = {
      id: `branch_${Date.now()}`,
      name,
      parentBranchId: this.store.currentBranchId,
      forkPoint,
      messages: [...messages],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.store.branches.push(branch);
    this.store.currentBranchId = branch.id;
    this.save();

    return branch;
  }

  /**
   * 切换到分支
   */
  switchTo(branchId: string): SessionBranch | null {
    const branch = this.store.branches.find((b) => b.id === branchId);
    if (branch) {
      this.store.currentBranchId = branchId;
      this.save();
    }
    return branch || null;
  }

  /**
   * 获取当前分支
   */
  getCurrentBranch(): SessionBranch | null {
    return this.store.branches.find((b) => b.id === this.store.currentBranchId) || null;
  }

  /**
   * 获取所有分支
   */
  getAllBranches(): SessionBranch[] {
    return this.store.branches;
  }

  /**
   * 更新当前分支的消息
   */
  updateMessages(messages: Message[]): void {
    const branch = this.getCurrentBranch();
    if (branch) {
      branch.messages = messages;
      branch.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  /**
   * 删除分支
   */
  deleteBranch(branchId: string): boolean {
    const idx = this.store.branches.findIndex((b) => b.id === branchId);
    if (idx === -1) return false;

    // 不能删除当前分支
    if (this.store.currentBranchId === branchId) {
      return false;
    }

    this.store.branches.splice(idx, 1);
    this.save();
    return true;
  }

  private load(): BranchStore {
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {
        branches: [],
        currentBranchId: '',
      };
    }
  }

  private save(): void {
    const dir = getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
  }
}

// ---- 计划-执行模式 ----

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';
  /** 执行前的文件快照（用于回滚） */
  snapshot?: Map<string, string>;
  error?: string;
}

export interface ExecutionPlan {
  id: string;
  description: string;
  steps: PlanStep[];
  createdAt: string;
}

/**
 * 创建执行计划
 */
export function createPlan(description: string, stepDescriptions: string[]): ExecutionPlan {
  return {
    id: `plan_${Date.now()}`,
    description,
    steps: stepDescriptions.map((desc, i) => ({
      id: `step_${i + 1}`,
      description: desc,
      status: 'pending' as const,
    })),
    createdAt: new Date().toISOString(),
  };
}