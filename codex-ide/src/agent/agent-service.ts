/**
 * Agent 桥接服务 — 对应主提示词 ADR-3（事件流桥接）
 *
 * UI 层（Webview / InlineEdit）只能通过本服务的事件与 Agent 核心交互，
 * 禁止直接触碰 Provider。核心 src/ 保持 VSCode 无关。
 */

import * as vscode from 'vscode';
import { runAgentLoop, type AgentLoopResult, type TokenUsage } from '../../../src/core/agent-loop.js';
import { InMemoryFileSystem, type FsCheckpoint } from '../../../src/core/in-memory-fs.js';
import { createSandbox, type Sandbox } from '../../../src/sandbox/sandbox.js';
import { createProvider, type AIProvider } from '../../../src/utils/ai-client.js';
import { registerBuiltinTools } from '../../../src/tools/builtin.js';
import type { CodexConfig } from '../../../src/config/config.js';
import type { Message } from '../../../src/core/message-manager.js';
import {
  MODEL_PRESETS,
  AUTO_PRESET_ID,
  getPreset,
  estimateCost,
  estimateComplexity,
  pickEscalationPreset,
  type ModelPreset,
} from './presets.js';
import { SecretManager } from './secrets.js';

// ---- 事件协议（Extension Host → UI） ----

export type AgentEvent =
  | { type: 'streamStart'; presetLabel: string }
  | { type: 'delta'; text: string }
  | { type: 'streamEnd'; result: AgentLoopResult; presetLabel: string; costCny: number }
  | { type: 'tool'; name: string; input: Record<string, unknown>; phase: 'call' | 'result'; success?: boolean; output?: string }
  | { type: 'error'; message: string }
  | { type: 'queued'; text: string }
  | { type: 'dirtyChanged'; files: DirtyFile[] }
  | { type: 'usage'; usage: TokenUsage; sessionCostCny: number; presetLabel: string };

/** 持久化的会话快照（globalState） */
interface SessionSnapshot {
  messages: Message[];
  sessionCostCny: number;
  sessionUsage: TokenUsage;
  savedAt: string;
}

const SESSION_KEY = 'codex-ide.session.v1';
/** 持久化单条消息的最大长度（控制存储体积） */
const MAX_STORED_MESSAGE = 8000;

export interface DirtyFile {
  path: string; // 绝对路径
  relativePath: string;
  deleted: boolean;
}

export class AgentService {
  private messages: Message[] = [];
  private fs: InMemoryFileSystem | null = null;
  private abortController: AbortController | null = null;
  /** 内联编辑（streamOnce）的独立取消控制器 */
  private inlineAbort: AbortController | null = null;
  private running = false;
  private sessionCostCny = 0;
  private sessionUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private toolsRegistered = false;

  private readonly emitter = new vscode.EventEmitter<AgentEvent>();
  readonly onEvent = this.emitter.event;

  /** 运行中到达的排队任务（单槽，后到覆盖先到，防无限堆积） */
  private pendingTask: { text: string; context?: string } | null = null;

  /** 逐轮检查点（回滚时间线） */
  private checkpoints: Array<{ turn: number; label: string; checkpoint: FsCheckpoint }> = [];
  private checkpointSeq = 0;

  constructor(
    private readonly secrets: SecretManager,
    private readonly store?: vscode.Memento,
    private readonly log?: (msg: string) => void,
  ) {}

  /** 工作区根目录 */
  get workingDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get memoryFs(): InMemoryFileSystem | null {
    return this.fs;
  }

  get sessionStats(): { usage: TokenUsage; costCny: number } {
    return { usage: { ...this.sessionUsage }, costCny: this.sessionCostCny };
  }

  /** 当前生效的预设（auto 时按任务解析） */
  async resolvePreset(userText?: string): Promise<{ preset: ModelPreset; apiKey: string } | { error: string }> {
    const cfg = vscode.workspace.getConfiguration('codex-ide');
    const activeId = cfg.get<string>('activePreset', AUTO_PRESET_ID);

    // 非 auto：直接使用指定预设
    if (activeId !== AUTO_PRESET_ID) {
      const preset = getPreset(activeId);
      if (!preset) return { error: `未知模型预设: ${activeId}` };
      const result = await this.withKey(preset);
      if (!result) return { error: `未配置 ${preset.label} 的 API Key` };
      return result;
    }

    // auto：免费档优先，复杂任务升级低价档
    const complexity = estimateComplexity(userText ?? '');
    const autoRoute = cfg.get<boolean>('autoRoute', true);
    const free = getPreset('glm-flash')!;
    const cheap = getPreset('deepseek-chat')!;

    if (complexity === 'high' && autoRoute) {
      const cheapWithKey = await this.withKey(cheap, true);
      if (cheapWithKey && 'preset' in cheapWithKey) return cheapWithKey;
    }

    const freeWithKey = await this.withKey(free, true);
    if (freeWithKey && 'preset' in freeWithKey) return freeWithKey;

    // 免费档无 Key → 尝试任何已配置预设
    for (const preset of MODEL_PRESETS) {
      if (preset.tier === 'local' || preset.tier === 'premium') continue;
      const candidate = await this.withKey(preset, true);
      if (candidate && 'preset' in candidate) return candidate;
    }

    // 本地模型兜底
    const local = getPreset('ollama-local')!;
    return { preset: local, apiKey: '' };
  }

  private async withKey(
    preset: ModelPreset,
    silent = false,
  ): Promise<{ preset: ModelPreset; apiKey: string } | { error: string } | null> {
    if (preset.tier === 'local') return { preset, apiKey: '' };
    let apiKey = await this.secrets.getApiKey(preset);
    if (!apiKey) {
      if (silent) return null;
      apiKey = await this.secrets.promptAndStoreApiKey(preset);
      if (!apiKey) return { error: `未配置 ${preset.label} 的 API Key` };
    }
    return { preset, apiKey };
  }

  /** 发送用户消息并运行 Agent 循环（运行中自动排队一条） */
  async send(userText: string, editorContext?: string): Promise<void> {
    if (this.running) {
      this.pendingTask = { text: userText, context: editorContext };
      this.emitter.fire({ type: 'queued', text: userText });
      this.log?.('[agent] 任务已排队，等待当前任务完成');
      return;
    }
    const workingDir = this.workingDir;
    if (!workingDir) {
      this.emitter.fire({ type: 'error', message: '请先打开一个工作区文件夹' });
      return;
    }

    // 成本预算熔断
    const budget = vscode.workspace.getConfiguration('codex-ide').get<number>('costBudgetCny', 0);
    if (budget > 0 && this.sessionCostCny >= budget) {
      this.emitter.fire({
        type: 'error',
        message: `已达成本预算上限 ¥${budget.toFixed(2)}（当前 ¥${this.sessionCostCny.toFixed(4)}）。可在设置中调整 codex-ide.costBudgetCny`,
      });
      return;
    }

    const resolved = await this.resolvePreset(userText);
    if ('error' in resolved) {
      this.emitter.fire({ type: 'error', message: resolved.error });
      return;
    }
    const { preset, apiKey } = resolved;

    // 惰性初始化：注册工具 + 快照工作区
    if (!this.toolsRegistered) {
      registerBuiltinTools();
      this.toolsRegistered = true;
    }
    if (!this.fs) {
      this.fs = new InMemoryFileSystem();
      await this.fs.snapshot(workingDir);
    }

    const sandbox = this.buildSandbox(workingDir);

    // 检查点：任务前存档（回滚时间线）
    this.pushCheckpoint(userText);

    // 组装消息（注入 IDE 上下文）
    const content = editorContext ? `${editorContext}\n\n${userText}` : userText;
    this.messages.push({ role: 'user', content, timestamp: new Date().toISOString() });

    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const runOnce = (p: ModelPreset, key: string): Promise<AgentLoopResult> => {
      const provider = this.buildProvider(p, key);
      this.emitter.fire({ type: 'streamStart', presetLabel: p.label });
      return runAgentLoop(
        provider,
        this.messages,
        this.fs!,
        workingDir,
        {
          onTextDelta: (text) => this.emitter.fire({ type: 'delta', text }),
          onToolUse: (name, input) => this.emitter.fire({ type: 'tool', name, input, phase: 'call' }),
          onToolResult: (name, success, output) => {
            this.emitter.fire({ type: 'tool', name, input: {}, phase: 'result', success, output });
            this.emitDirty();
          },
          onError: (message) => this.emitter.fire({ type: 'error', message }),
          onDone: () => {},
        },
        signal,
        sandbox,
      );
    };

    try {
      let usedPreset = preset;
      let result = await runOnce(preset, apiKey);

      // 失败自适应升档（最小反馈回路）：auto 模式 + free 档失败 → cheap 档重试一次
      const activeId = vscode.workspace.getConfiguration('codex-ide').get<string>('activePreset', AUTO_PRESET_ID);
      const escalation = result.hasError && activeId === AUTO_PRESET_ID ? pickEscalationPreset(preset) : null;
      if (escalation && !signal.aborted) {
        const esc = await this.withKey(escalation, true);
        if (esc && 'preset' in esc) {
          this.log?.(`[agent] ${preset.label} 失败，升级 ${esc.preset.label} 重试`);
          this.emitter.fire({ type: 'delta', text: `\n\n> ⚡ ${preset.label} 调用失败，已自动升级到 **${esc.preset.label}** 重试\n\n` });
          usedPreset = esc.preset;
          result = await runOnce(esc.preset, esc.apiKey);
        }
      }

      // 成本与用量
      const cost = estimateCost(usedPreset, result.tokenUsage.promptTokens, result.tokenUsage.completionTokens);
      this.sessionCostCny += cost;
      this.sessionUsage.promptTokens += result.tokenUsage.promptTokens;
      this.sessionUsage.completionTokens += result.tokenUsage.completionTokens;
      this.sessionUsage.totalTokens += result.tokenUsage.totalTokens;

      // 落历史（只保留最终文本，不含工具协议噪声）
      this.messages.push({ role: 'assistant', content: result.text, timestamp: new Date().toISOString() });
      this.trimHistory();

      this.emitter.fire({ type: 'streamEnd', result, presetLabel: usedPreset.label, costCny: cost });
      this.emitter.fire({
        type: 'usage',
        usage: { ...this.sessionUsage },
        sessionCostCny: this.sessionCostCny,
        presetLabel: usedPreset.label,
      });
      this.emitDirty();
      this.log?.(`[agent] 任务完成: ${usedPreset.label}, 本次 ¥${cost.toFixed(4)}, ${result.toolCalls.length} 次工具调用`);
      this.persistSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.(`[agent] 任务异常: ${message}`);
      this.emitter.fire({ type: 'error', message });
    } finally {
      this.running = false;
      this.abortController = null;
      // 排空队列：自动接续排队任务
      const pending = this.pendingTask;
      this.pendingTask = null;
      if (pending) {
        this.log?.('[agent] 执行排队任务');
        void this.send(pending.text, pending.context);
      }
    }
  }

  /** 单发补全（内联编辑用，不走工具循环） */
  async *streamOnce(
    systemPrompt: string,
    userText: string,
    presetId?: string,
  ): AsyncGenerator<string, void, undefined> {
    const cfg = vscode.workspace.getConfiguration('codex-ide');
    const id = presetId ?? cfg.get<string>('activePreset', AUTO_PRESET_ID);
    const preset = id === AUTO_PRESET_ID ? getPreset('glm-flash')! : getPreset(id);
    if (!preset) {
      yield '错误：未知模型预设';
      return;
    }
    const withKey = await this.withKey(preset);
    if (!withKey || 'error' in withKey) {
      yield `错误：${withKey && 'error' in withKey ? withKey.error : '未配置 API Key'}`;
      return;
    }
    const provider = this.buildProvider(withKey.preset, withKey.apiKey);
    const messages: Message[] = [{ role: 'user', content: userText, timestamp: new Date().toISOString() }];
    // 独立的取消控制器（修复：此前取 agent 循环的 controller，inline 场景下恒为 null）
    this.inlineAbort = new AbortController();
    let text = '';
    try {
      for await (const delta of provider.stream(messages, systemPrompt, this.inlineAbort.signal)) {
        text += delta;
        yield delta;
      }
    } finally {
      this.inlineAbort = null;
    }
    // 单发也计成本（粗估：按字符近似 token）
    const approxTokens = Math.ceil((userText.length + text.length) / 2);
    const cost = estimateCost(withKey.preset, approxTokens / 2, approxTokens / 2);
    this.sessionCostCny += cost;
  }

  /** 取消当前任务（含排队任务与内联编辑） */
  cancel(): void {
    this.abortController?.abort();
    this.inlineAbort?.abort();
    this.pendingTask = null;
    this.running = false;
  }

  /** 新会话（保留文件系统快照的磁盘同步状态） */
  async newSession(): Promise<void> {
    this.cancel();
    this.messages = [];
    this.sessionCostCny = 0;
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (this.fs && this.workingDir) {
      await this.fs.snapshot(this.workingDir);
    }
    this.emitDirty();
    this.persistSession();
    this.checkpoints = [];
    this.checkpointSeq = 0;
    this.log?.('[agent] 新会话已开始');
  }

  /** 从 globalState 恢复上次会话（重启不丢对话） */
  restoreSession(): void {
    if (!this.store) return;
    try {
      const snap = this.store.get<SessionSnapshot>(SESSION_KEY);
      if (!snap || !Array.isArray(snap.messages)) return;
      this.messages = snap.messages;
      this.sessionCostCny = snap.sessionCostCny ?? 0;
      this.sessionUsage = snap.sessionUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      this.log?.(`[agent] 已恢复会话（${snap.messages.length} 条消息，保存于 ${snap.savedAt}）`);
    } catch {
      // 损坏则忽略
    }
  }

  /** 供 UI 回放的历史（只含 role/content，不含内部协议噪声） */
  getHistory(): Array<{ role: string; content: string }> {
    return this.messages
      .filter((m) => !m.content.startsWith('[tool_result'))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  // ---- 检查点（回滚时间线） ----

  private pushCheckpoint(userText: string): void {
    if (!this.fs) return;
    this.checkpoints.push({
      turn: ++this.checkpointSeq,
      label: userText.slice(0, 40),
      checkpoint: this.fs.createCheckpoint(),
    });
    // 只保留最近 20 轮，控制内存
    if (this.checkpoints.length > 20) this.checkpoints.shift();
  }

  /** 可回滚的轮次列表（供 QuickPick 展示） */
  getCheckpoints(): Array<{ turn: number; label: string }> {
    return this.checkpoints.map((c) => ({ turn: c.turn, label: c.label }));
  }

  /**
   * 回滚到第 N 轮任务之前的状态。
   * 恢复后与磁盘重新对齐：若期间有变更已写盘，重新标记 dirty，
   * 用户通过「全部应用」即可把回滚状态写回磁盘（时间旅行闭环）。
   */
  rollbackTo(turn: number): boolean {
    const idx = this.checkpoints.findIndex((c) => c.turn === turn);
    if (idx < 0 || !this.fs) return false;
    this.fs.restoreCheckpoint(this.checkpoints[idx].checkpoint);
    this.fs.rebaseAgainstDisk();
    this.checkpoints = this.checkpoints.slice(0, idx + 1);
    this.emitDirty();
    this.log?.(`[agent] 已回滚到第 ${turn} 轮之前`);
    return true;
  }

  private persistSession(): void {
    if (!this.store) return;
    const snap: SessionSnapshot = {
      messages: this.messages.slice(-40).map((m) => ({
        ...m,
        content: m.content.length > MAX_STORED_MESSAGE ? m.content.slice(0, MAX_STORED_MESSAGE) : m.content,
      })),
      sessionCostCny: this.sessionCostCny,
      sessionUsage: this.sessionUsage,
      savedAt: new Date().toISOString(),
    };
    void this.store.update(SESSION_KEY, snap);
  }

  /** 通知 UI 未保存变更列表 */
  emitDirty(): void {
    if (!this.fs) {
      this.emitter.fire({ type: 'dirtyChanged', files: [] });
      return;
    }
    const workingDir = this.workingDir ?? '';
    const diffs = this.fs.getAllDiffs();
    const files: DirtyFile[] = [...diffs.keys()].map((abs) => ({
      path: abs,
      relativePath: abs.startsWith(workingDir) ? abs.slice(workingDir.length + 1) : abs,
      deleted: diffs.get(abs)?.startsWith('[已删除]') ?? false,
    }));
    this.emitter.fire({ type: 'dirtyChanged', files });
  }

  private buildProvider(preset: ModelPreset, apiKey: string): AIProvider {
    const config: CodexConfig = {
      provider: preset.providerType,
      providers: {
        anthropic: {
          apiKey: preset.providerType === 'anthropic' ? apiKey : '',
          model: preset.providerType === 'anthropic' ? preset.model : 'claude-sonnet-4-20250514',
          maxTokens: preset.maxTokens,
        },
        'openai-compatible': {
          apiKey: preset.providerType === 'openai-compatible' ? apiKey : '',
          baseURL: preset.baseURL,
          model: preset.model,
          maxTokens: preset.maxTokens,
        },
        local: {
          baseURL: preset.providerType === 'local' ? preset.baseURL : 'http://localhost:11434/v1',
          model: preset.model,
          maxTokens: preset.maxTokens,
        },
      },
    };
    return createProvider(config);
  }

  private buildSandbox(workingDir: string): Sandbox {
    return createSandbox(workingDir, async (command) => {
      const choice = await vscode.window.showWarningMessage(
        `Codex 请求执行命令：\n${command}`,
        { modal: true },
        '允许一次',
        '拒绝',
      );
      return choice === '允许一次';
    });
  }

  /** 控制历史长度，防止 token 膨胀（成本意识） */
  private trimHistory(): void {
    const MAX_MESSAGES = 40;
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
  }

  dispose(): void {
    this.cancel();
    this.emitter.dispose();
  }
}
