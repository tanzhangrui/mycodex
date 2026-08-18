/**
 * 状态栏 — 实时展示模型、token 用量与估算成本（成本透明化是核心卖点）
 */
import * as vscode from 'vscode';
import { MODEL_PRESETS, AUTO_PRESET_ID, getPreset } from '../agent/presets.js';
import type { AgentService } from '../agent/agent-service.js';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly agent: AgentService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codex-ide.switchModel';
    this.update();
    this.item.show();
  }

  update(presetLabel?: string): void {
    const label = presetLabel ?? this.activePresetLabel();
    const { usage, costCny } = this.agent.sessionStats;
    const tokens = usage.totalTokens > 0 ? ` · ${formatTokens(usage.totalTokens)}` : '';
    const cost = costCny > 0 ? ` · ¥${costCny.toFixed(4)}` : '';
    this.item.text = `$(hubot) ${label}${tokens}${cost}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Codex IDE**\n\n模型：${label}\n\n会话 Token：${usage.totalTokens.toLocaleString()}\n\n估算成本：¥${costCny.toFixed(4)}\n\n点击切换模型`,
    );
  }

  private activePresetLabel(): string {
    const id = vscode.workspace.getConfiguration('codex-ide').get<string>('activePreset', AUTO_PRESET_ID);
    if (id === AUTO_PRESET_ID) return '自动路由';
    return getPreset(id)?.label ?? id;
  }

  /** 模型切换 QuickPick */
  async switchModel(): Promise<void> {
    interface PresetItem extends vscode.QuickPickItem {
      presetId: string;
    }
    const cfg = vscode.workspace.getConfiguration('codex-ide');
    const current = cfg.get<string>('activePreset', AUTO_PRESET_ID);

    const items: PresetItem[] = [
      {
        presetId: AUTO_PRESET_ID,
        label: '$(zap) 自动路由（推荐）',
        description: '简单任务→免费模型，复杂任务→低价强模型',
        picked: current === AUTO_PRESET_ID,
      },
      ...MODEL_PRESETS.map((p) => ({
        presetId: p.id,
        label: `${tierIcon(p.tier)} ${p.label}`,
        description: p.pricing.inputPer1M === 0 ? '免费' : `约 ¥${p.pricing.inputPer1M}/¥${p.pricing.outputPer1M} 每百万token`,
        detail: p.description,
        picked: current === p.id,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: '选择模型（点击状态栏可随时切换）',
      placeHolder: '自动路由可在零成本下覆盖大多数任务',
    });
    if (!picked) return;

    await cfg.update('activePreset', picked.presetId, vscode.ConfigurationTarget.Global);
    this.update(picked.presetId === AUTO_PRESET_ID ? '自动路由' : getPreset(picked.presetId)?.label);
  }

  dispose(): void {
    this.item.dispose();
  }
}

function tierIcon(tier: string): string {
  switch (tier) {
    case 'free':
      return '$(gift)';
    case 'cheap':
      return '$(rocket)';
    case 'local':
      return '$(device-desktop)';
    default:
      return '$(star)';
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}
