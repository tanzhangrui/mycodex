/**
 * V3.3 — 终端命令自然语言化：VSCode 命令入口
 *
 * 流程：输入框（自然语言）→ 廉价模型转换 → 预填输入框（可编辑）+ 危险警告 → 发送到终端
 * 确认环节永久保留——命令是高危通道，模型永远不直接执行。
 */

import * as vscode from 'vscode';
import type { AgentService } from '../agent/agent-service.js';
import { buildNlCommandPrompt, parseNlCommandResponse, isDangerousCommand } from './nl-command-core.js';

export class NlTerminalCommand {
  constructor(
    private readonly agent: AgentService,
    private readonly log?: (msg: string) => void,
  ) {}

  async run(): Promise<void> {
    // 1. 自然语言输入
    const intent = await vscode.window.showInputBox({
      title: 'Codex: 自然语言 → 终端命令',
      prompt: '描述你想做的事，例如「找出本目录最大的 5 个文件」「批量把 .jpeg 改名为 .jpg」',
      placeHolder: '用一句话描述…',
      ignoreFocusOut: true,
    });
    if (!intent?.trim()) return;

    // 2. 模型转换（复用廉价模型通道；等待完成收全量文本）
    const systemPrompt = buildNlCommandPrompt({
      platform: process.platform,
      shell: this.detectShell(),
      workingDir: this.agent.workingDir,
    });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Codex: 正在生成命令…' },
      async () => {
        let raw = '';
        try {
          for await (const delta of this.agent.streamOnce(systemPrompt, intent)) {
            raw += delta;
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Codex 命令生成失败: ${(err as Error)?.message ?? err}`);
          return;
        }
        const command = parseNlCommandResponse(raw);
        if (!command) {
          vscode.window.showWarningMessage('Codex: 未能从模型输出中解析出命令，请重试或换个说法');
          return;
        }
        this.log?.(`[nl-command] "${intent}" → "${command}"`);
        await this.confirmAndSend(command, intent);
      },
    );
  }

  /** 预填确认（可编辑）→ 发送到终端（不自动执行，用户自己按回车） */
  private async confirmAndSend(command: string, intent: string): Promise<void> {
    const dangerous = isDangerousCommand(command);
    const prompt = dangerous
      ? `⚠️ 危险命令（请仔细确认）——意图：${intent}`
      : `命令已生成（意图：${intent}），可编辑后确认`;

    const confirmed = await vscode.window.showInputBox({
      title: 'Codex: 确认终端命令',
      prompt,
      value: command,
      ignoreFocusOut: true,
    });
    if (!confirmed?.trim()) return;

    // 发送到终端但不执行：sendText 第二参 false 仅填入不回车，用户审视后自行执行
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Codex');
    terminal.show();
    terminal.sendText(confirmed.trim(), false);
  }

  private detectShell(): string {
    const shell = vscode.env.shell;
    if (shell) {
      const name = shell.replace(/\\/g, '/').split('/').pop() ?? '';
      return name || 'unknown';
    }
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }
}
