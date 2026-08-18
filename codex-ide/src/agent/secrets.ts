/**
 * 密钥管理 — 对应主提示词 ADR-5 / 战略判断 #4
 *
 * 存储优先级：VSCode SecretStorage（系统级加密） > 环境变量 > 工作区 .env（只读解析）
 *
 * 红线：
 * - API Key 永不写入 settings.json、永不出现在日志 / Webview / 错误消息中
 * - .env 仅按需解析目标键，解析结果不回显、不回传
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelPreset } from './presets.js';

export class SecretManager {
  constructor(private readonly storage: vscode.SecretStorage) {}

  /** 获取 API Key（不触发交互） */
  async getApiKey(preset: ModelPreset): Promise<string | undefined> {
    if (!preset.secretKey) return undefined; // local 模型无需 Key

    // 1. SecretStorage
    const stored = await this.storage.get(preset.secretKey);
    if (stored) return stored;

    // 2. 环境变量
    for (const envKey of preset.envKeys) {
      const value = process.env[envKey];
      if (value) return value;
    }

    // 3. 工作区 .env（只读解析，提取目标键）
    const fromDotEnv = await this.readKeysFromDotEnv(preset.envKeys);
    if (fromDotEnv) return fromDotEnv;

    return undefined;
  }

  /** 交互式设置 API Key（密码输入框，存入 SecretStorage） */
  async promptAndStoreApiKey(preset: ModelPreset): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: `设置 ${preset.label} 的 API Key`,
      prompt: `将安全存储在系统密钥库（SecretStorage）中，不会写入任何配置文件。环境变量候选：${preset.envKeys.join(' / ') || '无'}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 8 ? 'Key 长度异常，请检查' : undefined),
    });
    if (!key) return undefined;
    await this.storage.store(preset.secretKey, key.trim());
    return key.trim();
  }

  /** 删除已存 Key */
  async clearApiKey(preset: ModelPreset): Promise<void> {
    if (preset.secretKey) await this.storage.delete(preset.secretKey);
  }

  /** 从工作区根目录 .env 提取指定键（只读，不回显） */
  private async readKeysFromDotEnv(keys: string[]): Promise<string | undefined> {
    if (keys.length === 0) return undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;

    try {
      const raw = await readFile(join(folder.uri.fsPath, '.env'), 'utf-8');
      const wanted = new Set(keys);
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const [, name, rawValue] = match;
        if (!wanted.has(name)) continue;
        // 去掉引号
        const value = rawValue.replace(/^["']|["']$/g, '').trim();
        if (value) return value;
      }
    } catch {
      // .env 不存在或不可读，静默跳过
    }
    return undefined;
  }
}
