/**
 * V4.4 — 插件市场索引协议（v1）
 * ==========================================
 *
 * 索引是静态 JSON，可托管在任意位置（GitHub raw / 内网文件服务器 / 本地）。
 * 协议先行、服务后建：核心价值是格式的标准化与容错解析。
 *
 * 诚实边界：
 * - source.kind 只支持 file（本地/相对索引文件的路径）
 * - 远程自动下载执行刻意未实现——签名/校验和/沙箱隔离的供应链安全设计单独交付
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';

/** 结构化依赖：只需 loadPlugin（测试可注入桩） */
export interface PluginLoader {
  loadPlugin: (pluginPath: string) => Promise<number>;
}

// ---- 类型 ----

export interface MarketplaceEntry {
  /** 插件名（非空字符串，与插件自身的 name 一致性由安装时 loadPlugin 校验） */
  name: string;
  version: string;
  description?: string;
  source: {
    /** v1 仅 file：相对索引文件（或绝对）的插件模块路径 */
    kind: 'file';
    path: string;
  };
}

export interface MarketplaceIndex {
  version: 1;
  plugins: MarketplaceEntry[];
}

export interface InstallResult {
  name: string;
  success: boolean;
  /** 成功：加载的工具数；失败：原因 */
  detail: string;
  /** 成功后可直接写入 config.plugins 的绝对路径 */
  pluginPath?: string;
}

/** 单索引文件条目上限（防恶意巨型索引） */
const MAX_ENTRIES = 200;

/**
 * 容错解析市场索引。纯函数。
 * 三级尝试：整体 → 围栏块 → 首末大括号子串；
 * 逐条形状校验（name/version 非空字符串 + source.kind === 'file' + path 非空），
 * 非法条目跳过；name 去重（首个保留）。
 */
export function parseMarketplaceIndex(raw: string): MarketplaceIndex | null {
  const candidates: string[] = [raw.trim()];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const index = extractIndex(parsed);
    if (index) return index;
  }
  return null;
}

/** 形状校验 + 清洗：version===1 / plugins 数组 / 逐条过滤 + name 去重 */
function extractIndex(parsed: unknown): MarketplaceIndex | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { version?: unknown; plugins?: unknown };
  if (obj.version !== 1) return null;
  if (!Array.isArray(obj.plugins)) return null;

  const seen = new Set<string>();
  const plugins: MarketplaceEntry[] = [];
  for (const item of obj.plugins.slice(0, MAX_ENTRIES)) {
    const entry = extractEntry(item);
    if (!entry) continue;
    if (seen.has(entry.name)) continue; // 同名去重，首个保留
    seen.add(entry.name);
    plugins.push(entry);
  }
  return { version: 1, plugins };
}

/** 单条目形状校验 */
function extractEntry(item: unknown): MarketplaceEntry | null {
  if (typeof item !== 'object' || item === null) return null;
  const e = item as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    source?: { kind?: unknown; path?: unknown };
  };
  if (typeof e.name !== 'string' || e.name.trim().length === 0) return null;
  if (typeof e.version !== 'string' || e.version.trim().length === 0) return null;
  if (typeof e.source !== 'object' || e.source === null) return null;
  if (e.source.kind !== 'file') return null;
  if (typeof e.source.path !== 'string' || e.source.path.trim().length === 0) return null;

  return {
    name: e.name.trim(),
    version: e.version.trim(),
    description: typeof e.description === 'string' ? e.description : undefined,
    source: { kind: 'file', path: e.source.path.trim() },
  };
}

/**
 * 从本地文件加载市场索引。
 * 返回索引 + 索引所在目录（条目的相对路径以此为基准）。
 * 文件不存在 / 解析失败 → null（调用方提示，不抛错）。
 */
export function loadMarketplaceIndex(indexFilePath: string): {
  index: MarketplaceIndex;
  baseDir: string;
} | null {
  try {
    const raw = readFileSync(indexFilePath, 'utf-8');
    const index = parseMarketplaceIndex(raw);
    if (!index) return null;
    return { index, baseDir: dirname(resolve(indexFilePath)) };
  } catch {
    return null;
  }
}

/**
 * 按名查找条目（精确匹配）。
 */
export function findEntry(loaded: { index: MarketplaceIndex }, name: string): MarketplaceEntry | null {
  return loaded.index.plugins.find((p) => p.name === name) ?? null;
}

/**
 * 安装条目：解析插件路径（相对索引目录）→ registry.loadPlugin（复用 V4.1 全部校验与去重）。
 * 成功返回 pluginPath（绝对路径，可直接写入 config.plugins 实现常驻）。
 */
export async function installPlugin(
  loaded: { index: MarketplaceIndex; baseDir: string },
  entry: MarketplaceEntry,
  registry: PluginLoader,
): Promise<InstallResult> {
  const pluginPath = isAbsolute(entry.source.path)
    ? entry.source.path
    : resolve(loaded.baseDir, entry.source.path);

  try {
    const count = await registry.loadPlugin(pluginPath);
    // name@version 去重命中 → count 0，这是幂等成功而非失败
    const deduped = count === 0;
    return {
      name: entry.name,
      success: true,
      detail: deduped ? '已加载（重复加载被去重跳过）' : `已加载 ${count} 个工具`,
      pluginPath,
    };
  } catch (err) {
    return {
      name: entry.name,
      success: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
