/**
 * V2.0 — 自动更新检查
 * ==========================================
 *
 * 启动时检查 GitHub Releases 或配置的更新服务器，
 * 比较当前版本与最新版本，如有新版本提示用户。
 *
 * 简化版：仅检查 + 提示，下载和替换留到 V2.1。
 */

import { createLogger } from './logger.js';

const logger = createLogger('auto-updater');

interface UpdateInfo {
  latest: string;
  current: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string;
}

// 默认更新检查 URL（GitHub Releases API）
const DEFAULT_UPDATE_URL = 'https://api.github.com/repos/codex-ai/codex/releases/latest';

// 更新检查间隔（24 小时）
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

let lastCheck = 0;
let cachedUpdateInfo: UpdateInfo | null = null;

/**
 * 比较版本号
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * 检查更新
 * @param currentVersion 当前版本号
 * @param updateUrl 更新检查 URL（可选）
 * @returns 更新信息
 */
export async function checkForUpdates(
  currentVersion: string,
  updateUrl?: string,
): Promise<UpdateInfo | null> {
  const now = Date.now();

  // 使用缓存（24 小时内）
  if (cachedUpdateInfo && now - lastCheck < CHECK_INTERVAL) {
    return cachedUpdateInfo;
  }

  const url = updateUrl || process.env.CODEX_UPDATE_URL || DEFAULT_UPDATE_URL;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': `codex/${currentVersion}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug(`更新检查失败: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as { tag_name?: string; html_url?: string; body?: string };
    const latest = data.tag_name?.replace(/^v/, '') || '';

    if (!latest) {
      logger.debug('未能解析最新版本号');
      return null;
    }

    const hasUpdate = compareVersions(latest, currentVersion) > 0;

    const info: UpdateInfo = {
      latest,
      current: currentVersion,
      hasUpdate,
      releaseUrl: data.html_url || '',
      releaseNotes: data.body?.substring(0, 500),
    };

    lastCheck = now;
    cachedUpdateInfo = info;

    return info;
  } catch (err) {
    logger.debug(`更新检查异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 获取更新提示文本
 */
export function getUpdateMessage(info: UpdateInfo): string {
  if (!info.hasUpdate) return '';

  const lines = [
    `\n新版本 v${info.latest} 可用！当前版本: v${info.current}`,
    `运行 "codex update" 或访问 ${info.releaseUrl} 获取更新`,
  ];

  if (info.releaseNotes) {
    lines.push(`\n更新日志:\n${info.releaseNotes}`);
  }

  return lines.join('\n');
}

/**
 * 清除更新缓存
 */
export function clearUpdateCache(): void {
  cachedUpdateInfo = null;
  lastCheck = 0;
}