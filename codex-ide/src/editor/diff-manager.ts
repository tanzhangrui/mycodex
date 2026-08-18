/**
 * Diff 预览与应用管理 — 对应主提示词战略判断 #3
 * 每一次 AI 修改：先预览、可逐文件应用、可整体拒绝、永远可回滚。
 *
 * 实现：内存文件系统中的变更不落盘，右侧用虚拟文档展示新内容，
 * 左侧用磁盘原文件，借助原生 vscode.diff 呈现。
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import type { AgentService } from '../agent/agent-service.js';

const SCHEME_NEW = 'codex-ide-new';
const SCHEME_EMPTY = 'codex-ide-empty';

export class DiffManager implements vscode.TextDocumentContentProvider {
  /** 虚拟文档内容缓存：uri.toString() → content */
  private readonly virtualDocs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly agent: AgentService) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme === SCHEME_EMPTY) return '';
    return this.virtualDocs.get(uri.toString()) ?? '';
  }

  /** 打开单个文件的 diff 预览 */
  async showDiff(absolutePath: string): Promise<void> {
    const fs = this.agent.memoryFs;
    if (!fs) return;
    const newContent = fs.read(absolutePath);
    const fileUri = vscode.Uri.file(absolutePath);
    const relative = vscode.workspace.asRelativePath(fileUri);

    if (newContent === null) {
      // 已删除文件：左侧原文，右侧空
      const emptyUri = vscode.Uri.parse(`${SCHEME_EMPTY}://deleted/${encodeURIComponent(relative)}`);
      await vscode.commands.executeCommand('vscode.diff', fileUri, emptyUri, `${relative}（将被删除）`);
      return;
    }

    // 判断磁盘上是否存在（新文件 vs 修改）
    let existsOnDisk = true;
    try {
      await readFile(absolutePath, 'utf-8');
    } catch {
      existsOnDisk = false;
    }

    const newUri = vscode.Uri.parse(`${SCHEME_NEW}://new/${encodeURIComponent(relative)}?${Date.now()}`);
    this.virtualDocs.set(newUri.toString(), newContent);

    if (existsOnDisk) {
      await vscode.commands.executeCommand('vscode.diff', fileUri, newUri, `${relative}（当前 ↔ Codex 修改）`);
    } else {
      const emptyUri = vscode.Uri.parse(`${SCHEME_EMPTY}://new/${encodeURIComponent(relative)}`);
      await vscode.commands.executeCommand('vscode.diff', emptyUri, newUri, `${relative}（新文件）`);
    }
  }

  /** 应用全部变更到磁盘 */
  async applyAll(): Promise<void> {
    const fs = this.agent.memoryFs;
    if (!fs || !fs.isDirty()) {
      vscode.window.showInformationMessage('没有待应用的变更');
      return;
    }
    const count = fs.getDirtyCount();
    const confirm = await vscode.window.showInformationMessage(
      `将 ${count} 个文件的变更写入磁盘？`,
      { modal: true },
      '应用',
    );
    if (confirm !== '应用') return;

    const result = fs.applyToDisk();
    this.agent.emitDirty();

    if (result.failed.length > 0) {
      vscode.window.showErrorMessage(
        `应用完成：成功 ${result.applied.length} 个，失败 ${result.failed.length} 个（${result.failed[0].path}: ${result.failed[0].error}）`,
      );
    } else {
      vscode.window.showInformationMessage(`已应用 ${result.applied.length} 个文件的变更`);
    }
  }

  /** 拒绝全部变更（重新快照 = 回滚到磁盘状态） */
  async rejectAll(): Promise<void> {
    const fs = this.agent.memoryFs;
    const workingDir = this.agent.workingDir;
    if (!fs || !workingDir || !fs.isDirty()) {
      vscode.window.showInformationMessage('没有待拒绝的变更');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `放弃全部 ${fs.getDirtyCount()} 个未应用变更？此操作不可撤销。`,
      { modal: true },
      '放弃变更',
    );
    if (confirm !== '放弃变更') return;
    await fs.snapshot(workingDir);
    this.agent.emitDirty();
    vscode.window.showInformationMessage('已回滚到磁盘状态');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
