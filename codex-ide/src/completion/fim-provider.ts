/**
 * V3.3 — 本地 FIM Tab 补全：VSCode Provider 包装
 *
 * - Ollama /api/generate（qwen2.5-coder FIM 模板），纯本地零外发（隐私宪法）
 * - 防抖（默认 400ms）+ 单飞行请求（新请求 abort 旧请求）
 * - Ollama 不可达熔断 5 分钟（静默降级，OutputChannel 记录，不打扰编辑）
 * - 激活预算：注册即轻量，首次补全才探测 Ollama
 */

import * as vscode from 'vscode';
import { shouldTrigger, buildFimPrompt, cleanFimResponse, DEFAULT_FIM_LIMITS, type FimContextLimit } from './fim-core.js';

/** Ollama 不可达后的熔断时长 */
const CIRCUIT_BREAK_MS = 5 * 60 * 1000;

export class FimCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private circuitOpenUntil = 0;
  private inFlight: AbortController | null = null;
  /** 防抖序号：新调用递增，旧等待据此判定自己被抢占 */
  private debounceSeq = 0;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly log?: (msg: string) => void) {
    this.disposable = vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file' },
      this,
    );
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = vscode.workspace.getConfiguration('codex-ide.fim');
    if (!cfg.get<boolean>('enabled', true)) return undefined;
    if (Date.now() < this.circuitOpenUntil) return undefined;

    // 触发判定：当前行光标前内容
    const linePrefix = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
    if (!shouldTrigger(linePrefix)) return undefined;

    const debounceMs = cfg.get<number>('debounceMs', 400);
    if (debounceMs > 0) {
      // 防抖：等待击键停顿；期间有新调用则旧等待作废
      const settled = await this.waitForDebounce(debounceMs);
      if (!settled || token.isCancellationRequested) return undefined;
    }

    // 竞态：abort 旧请求
    this.inFlight?.abort();
    const req = new AbortController();
    this.inFlight = req;
    try {
      const prefix = document.getText(new vscode.Range(Math.max(0, position.line - DEFAULT_FIM_LIMITS.maxPrefixLines), 0, position.line, position.character));
      const suffixEndLine = Math.min(document.lineCount - 1, position.line + DEFAULT_FIM_LIMITS.maxSuffixLines);
      const suffix = document.getText(new vscode.Range(position.line, position.character, suffixEndLine, document.lineAt(suffixEndLine).range.end.character));

      const limits: FimContextLimit = {
        maxPrefixLines: cfg.get<number>('maxPrefixLines', DEFAULT_FIM_LIMITS.maxPrefixLines),
        maxSuffixLines: cfg.get<number>('maxSuffixLines', DEFAULT_FIM_LIMITS.maxSuffixLines),
        maxTokens: cfg.get<number>('maxTokens', DEFAULT_FIM_LIMITS.maxTokens),
      };
      const prompt = buildFimPrompt(prefix, suffix, limits);

      const raw = await this.queryOllama(prompt, limits.maxTokens, req.signal, cfg);
      if (req.signal.aborted || token.isCancellationRequested) return undefined;

      const completion = cleanFimResponse(raw);
      if (!completion) return undefined;

      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return undefined;
      // Ollama 不可达：熔断 + 记录（不打扰编辑）
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
      this.log?.(`[fim] Ollama 不可达，补全熔断 ${CIRCUIT_BREAK_MS / 60000} 分钟: ${(err as Error)?.message ?? err}`);
      return undefined;
    } finally {
      if (this.inFlight === req) this.inFlight = null;
    }
  }

  /** 防抖等待：期间被新调用抢占则返回 false */
  private waitForDebounce(ms: number): Promise<boolean> {
    const seq = ++this.debounceSeq;
    return new Promise((resolve) => {
      setTimeout(() => resolve(seq === this.debounceSeq), ms);
    });
  }

  private async queryOllama(
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
    cfg: vscode.WorkspaceConfiguration,
  ): Promise<string> {
    const url = cfg.get<string>('ollamaUrl', 'http://localhost:11434');
    const model = cfg.get<string>('model', 'qwen2.5-coder:1.5b');

    const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: maxTokens,
          stop: ['<|fim_end|>', '<|endoftext|>'],
          temperature: 0.1,
        },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { response?: string };
    return data.response ?? '';
  }

  dispose(): void {
    this.inFlight?.abort();
    this.disposable.dispose();
  }
}
