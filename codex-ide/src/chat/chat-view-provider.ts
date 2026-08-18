/**
 * 聊天面板（WebviewView）— Trae 式侧栏对话体验
 *
 * 通信协议（ADR-3）：
 *   Webview → Host: send / cancel / applyAll / rejectAll / showDiff / setApiKey / newSession / ready
 *   Host → Webview: 见 agent-service 的 AgentEvent + state/userEcho
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { AgentService } from '../agent/agent-service.js';
import type { DiffManager } from '../editor/diff-manager.js';
import type { StatusBar } from '../status/status-bar.js';
import type { SecretManager } from '../agent/secrets.js';
import { MODEL_PRESETS, AUTO_PRESET_ID } from '../agent/presets.js';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codex-ide.chat';

  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly diff: DiffManager,
    private readonly statusBar: StatusBar,
    private readonly secrets: SecretManager,
  ) {
    // Agent 事件 → Webview
    this.disposables.push(
      this.agent.onEvent((event) => {
        this.postMessage(event);
        if (event.type === 'streamEnd') this.statusBar.update(event.presetLabel);
        if (event.type === 'usage') this.statusBar.update(event.presetLabel);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.type) {
          case 'ready':
            this.pushState();
            this.postMessage({ type: 'history', messages: this.agent.getHistory() });
            this.agent.emitDirty();
            break;
          case 'send':
            await this.agent.send(msg.text, this.buildEditorContext());
            break;
          case 'cancel':
            this.agent.cancel();
            break;
          case 'applyAll':
            await this.diff.applyAll();
            break;
          case 'rejectAll':
            await this.diff.rejectAll();
            break;
          case 'showDiff':
            await this.diff.showDiff(msg.path);
            break;
          case 'setApiKey': {
            const preset = MODEL_PRESETS.find((p) => p.id === msg.presetId);
            if (preset) {
              const key = await this.secrets.promptAndStoreApiKey(preset);
              if (key) {
                vscode.window.showInformationMessage(`${preset.label} 的 API Key 已安全保存`);
                this.pushState();
              }
            }
            break;
          }
          case 'newSession':
            await this.agent.newSession();
            break;
          case 'setModel': {
            const cfg = vscode.workspace.getConfiguration('codex-ide');
            await cfg.update('activePreset', msg.presetId, vscode.ConfigurationTarget.Global);
            this.statusBar.update(
              msg.presetId === AUTO_PRESET_ID
                ? '自动路由'
                : MODEL_PRESETS.find((p) => p.id === msg.presetId)?.label,
            );
            this.pushState();
            break;
          }
          case 'switchModel':
            await this.statusBar.switchModel();
            this.pushState();
            break;
        }
      },
      null,
      this.disposables,
    );

    view.onDidDispose(() => {
      this.view = null;
    });
  }

  /** 供右键命令使用：聚焦面板并发送带代码上下文的请求 */
  async askWithCode(instruction: string, code: string, language: string, fileName: string, range: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    const prompt = `${instruction}\n\n文件：${fileName}（${range}）\n\`\`\`${language}\n${code}\n\`\`\``;
    this.postMessage({ type: 'userEcho', text: prompt });
    await this.agent.send(prompt);
  }

  postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  /** 推送模型/密钥状态到 Webview */
  private async pushState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codex-ide');
    const activePreset = cfg.get<string>('activePreset', AUTO_PRESET_ID);
    const keyStatus: Record<string, boolean> = {};
    for (const preset of MODEL_PRESETS) {
      if (preset.tier === 'local') {
        keyStatus[preset.id] = true;
        continue;
      }
      keyStatus[preset.id] = Boolean(await this.secrets.getApiKey(preset));
    }
    this.postMessage({
      type: 'state',
      activePreset,
      presets: MODEL_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        tier: p.tier,
        pricing: p.pricing,
        description: p.description,
      })),
      keyStatus,
    });
  }

  /** 提取当前编辑器上下文（成本意识：只带选中内容，不盲目全文投喂） */
  private buildEditorContext(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const doc = editor.document;
    const selection = editor.selection;
    const relative = vscode.workspace.asRelativePath(doc.uri);

    if (selection.isEmpty) {
      return `[IDE 上下文]\n当前打开文件：${relative}（共 ${doc.lineCount} 行，未选中文本）`;
    }

    const selected = doc.getText(selection);
    if (selected.length > 8000) {
      return `[IDE 上下文]\n当前打开文件：${relative}（选中内容过长已省略，请缩小选区）`;
    }
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    return `[IDE 上下文]\n当前文件：${relative}，选中第 ${startLine}-${endLine} 行：\n\`\`\`${doc.languageId}\n${selected}\n\`\`\``;
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Codex IDE</title>
</head>
<body>
  <header id="topbar">
    <span class="brand">Codex IDE</span>
    <select id="model-select" title="选择模型"></select>
    <button id="key-btn" title="设置 API Key">🔑</button>
    <button id="new-session-btn" title="新会话">＋</button>
  </header>

  <main id="messages"></main>

  <section id="dirty-bar" class="hidden">
    <div id="dirty-header">
      <span id="dirty-title"></span>
      <span>
        <button id="apply-all" class="primary">全部应用</button>
        <button id="reject-all" class="danger">全部拒绝</button>
      </span>
    </div>
    <ul id="dirty-list"></ul>
  </section>

  <footer id="composer">
    <textarea id="input" placeholder="描述你的任务…（Enter 发送，Shift+Enter 换行）" rows="3"></textarea>
    <div id="composer-bar">
      <span id="usage"></span>
      <button id="send-btn" class="primary">发送</button>
      <button id="cancel-btn" class="danger hidden">停止</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
