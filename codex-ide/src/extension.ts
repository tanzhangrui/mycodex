/**
 * Codex IDE 扩展入口 — 懒装配，激活预算 < 100ms（ADR-6）
 * 核心 Agent 引擎在首次使用时才初始化（AgentService 内部惰性注册/快照）。
 */

import * as vscode from 'vscode';
import { AgentService } from './agent/agent-service.js';
import { SecretManager } from './agent/secrets.js';
import { ChatViewProvider } from './chat/chat-view-provider.js';
import { DiffManager } from './editor/diff-manager.js';
import { InlineChat } from './editor/inline-chat.js';
import { registerCodeActions } from './editor/code-actions.js';
import { StatusBar } from './status/status-bar.js';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Codex IDE');
  const log = (msg: string): void => channel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);

  const secrets = new SecretManager(context.secrets);
  const agent = new AgentService(secrets, context.globalState, log);
  agent.restoreSession();
  const diff = new DiffManager(agent);
  const statusBar = new StatusBar(agent);
  const inlineChat = new InlineChat(agent);
  const chat = new ChatViewProvider(context.extensionUri, agent, diff, statusBar, secrets);

  log('[codex-ide] 扩展已激活');

  context.subscriptions.push(
    channel,
    agent,
    diff,
    statusBar,
    inlineChat,
    chat,

    // 侧栏聊天视图
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    // 虚拟文档（diff 预览）
    vscode.workspace.registerTextDocumentContentProvider('codex-ide-new', diff),
    vscode.workspace.registerTextDocumentContentProvider('codex-ide-empty', diff),
    vscode.workspace.registerTextDocumentContentProvider('codex-ide-inline', inlineChat),

    // 命令
    vscode.commands.registerCommand('codex-ide.openChat', () =>
      vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`),
    ),
    vscode.commands.registerCommand('codex-ide.inlineEdit', () => inlineChat.run()),
    vscode.commands.registerCommand('codex-ide.applyChanges', () => diff.applyAll()),
    vscode.commands.registerCommand('codex-ide.rejectChanges', () => diff.rejectAll()),
    vscode.commands.registerCommand('codex-ide.switchModel', () => statusBar.switchModel()),
    vscode.commands.registerCommand('codex-ide.newSession', () => agent.newSession()),

    // 右键 AI 命令
    ...registerCodeActions(chat),

    // 配置变更时刷新状态栏
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codex-ide.activePreset')) statusBar.update();
    }),
  );
}

export function deactivate(): void {
  // AgentService.dispose 由 subscriptions 负责
}
