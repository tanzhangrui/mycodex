/**
 * 编辑器右键 AI 命令 — 解释 / 修复 / 重构选中代码
 * 统一走聊天面板，保留完整 Agent 能力（可读项目文件佐证解释）
 */

import * as vscode from 'vscode';
import type { ChatViewProvider } from '../chat/chat-view-provider.js';

interface SelectionInfo {
  code: string;
  language: string;
  fileName: string;
  range: string;
}

function getSelection(): SelectionInfo | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const selection = editor.selection;
  const code = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
  if (!code.trim()) {
    vscode.window.showInformationMessage('请先选中代码（或不选中则分析整个文件）');
    return undefined;
  }
  const range = selection.isEmpty
    ? '整个文件'
    : `第 ${selection.start.line + 1}-${selection.end.line + 1} 行`;
  return {
    code: code.length > 12000 ? code.slice(0, 12000) + '\n// …（过长已截断）' : code,
    language: editor.document.languageId,
    fileName: vscode.workspace.asRelativePath(editor.document.uri),
    range,
  };
}

export function registerCodeActions(chat: ChatViewProvider): vscode.Disposable[] {
  const make = (instruction: string) => async () => {
    const sel = getSelection();
    if (!sel) return;
    await chat.askWithCode(instruction, sel.code, sel.language, sel.fileName, sel.range);
  };

  return [
    vscode.commands.registerCommand(
      'codex-ide.explainSelection',
      make('请逐层解释这段代码的功能、设计意图与潜在问题。回答用中文，简洁有条理。'),
    ),
    vscode.commands.registerCommand(
      'codex-ide.fixSelection',
      make('请找出这段代码中的 bug 或隐患，说明原因，然后使用 edit_file 工具直接修复它。'),
    ),
    vscode.commands.registerCommand(
      'codex-ide.refactorSelection',
      make('请重构这段代码：提升可读性、消除重复、遵循该语言最佳实践。使用 edit_file 工具直接修改，改动前先说明思路。'),
    ),
  ];
}
