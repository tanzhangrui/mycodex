/**
 * 内联编辑（Ctrl+I）— Cursor 式体验
 *
 * 流程：选中代码 → 输入指令 → 流式生成替换 → 原生 diff 预览 → 应用/拒绝
 * 单发调用（无工具循环），成本最低化。
 */

import * as vscode from 'vscode';
import type { AgentService } from '../agent/agent-service.js';

const SCHEME = 'codex-ide-inline';

export class InlineChat implements vscode.TextDocumentContentProvider {
  private readonly virtualDocs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly agent: AgentService) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.virtualDocs.get(uri.toString()) ?? '';
  }

  async run(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('请先打开一个文件');
      return;
    }
    const doc = editor.document;
    const selection = editor.selection;
    const targetRange = selection.isEmpty
      ? doc.lineAt(selection.active.line).range
      : selection;
    const originalText = doc.getText(targetRange);

    const instruction = await vscode.window.showInputBox({
      title: 'Codex 内联编辑（Ctrl+I）',
      prompt: '描述如何修改选中代码',
      placeHolder: '例如：添加错误处理 / 重构为 async-await / 补全注释',
      ignoreFocusOut: true,
    });
    if (!instruction) return;

    const systemPrompt = `你是精确的代码修改引擎。用户给出一段 ${doc.languageId} 代码和修改指令。
规则：
1. 只输出修改后的完整代码，不要任何解释、不要 markdown 代码围栏
2. 保持原有缩进风格与命名习惯
3. 未要求改动的部分原样保留`;

    const userText = `文件语言：${doc.languageId}\n修改指令：${instruction}\n\n原始代码：\n${originalText}`;

    let generated = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Codex 生成中…', cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => this.agent.cancel());
        for await (const delta of this.agent.streamOnce(systemPrompt, userText)) {
          generated += delta;
        }
      },
    );

    // 清理可能的代码围栏（模型不总是守规矩）
    generated = generated.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trimEnd();
    if (!generated || generated.startsWith('错误：')) {
      vscode.window.showErrorMessage(generated || '生成失败');
      return;
    }

    // 构造替换后的完整文档用于 diff 预览
    const fullNew = doc.getText().replace(originalText, generated);
    const newUri = vscode.Uri.parse(`${SCHEME}://inline/${encodeURIComponent(doc.fileName)}?${Date.now()}`);
    this.virtualDocs.set(newUri.toString(), fullNew);

    await vscode.commands.executeCommand(
      'vscode.diff',
      doc.uri,
      newUri,
      `${vscode.workspace.asRelativePath(doc.uri)}（当前 ↔ Codex 内联编辑）`,
    );

    const choice = await vscode.window.showInformationMessage(
      '应用内联编辑结果？',
      '应用',
      '拒绝',
    );
    if (choice === '应用') {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, targetRange, generated);
      await vscode.workspace.applyEdit(edit);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } else {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
