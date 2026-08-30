/**
 * V4.4 — 插件市场索引协议（v1）
 * V5.5 — 远程源（url）安全下载
 * ==========================================
 *
 * 索引是静态 JSON，可托管在任意位置（GitHub raw / 内网文件服务器 / 本地）。
 * 协议先行、服务后建：核心价值是格式的标准化与容错解析。
 *
 * V5.5 供应链安全红线（url 源）：
 * - 仅 https（http 明文传输可被中间人替换 → 拒绝）
 * - sha256 校验和必填（无 pin 的远程下载执行 = 任意代码注入入口）
 * - 下载落缓存目录（config/plugins/），校验通过后才 loadPlugin
 * - 大小上限 2MB（防巨型载荷/慢速消耗）
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getConfigDir } from '../config/config.js';

/** 结构化依赖：只需 loadPlugin（测试可注入桩） */
export interface PluginLoader {
  loadPlugin: (pluginPath: string) => Promise<number>;
}

/** 下载器（默认 globalThis.fetch；测试注入桩避免真实网络） */
export type UrlFetcher = (url: string) => Promise<ArrayBuffer>;

// ---- 类型 ----

export type MarketplaceSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; sha256: string };

export interface MarketplaceEntry {
  /** 插件名（非空字符串，与插件自身的 name 一致性由安装时 loadPlugin 校验） */
  name: string;
  version: string;
  description?: string;
  source: MarketplaceSource;
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
/** 远程插件下载大小上限（2MB） */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

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

/** 单条目形状校验（file / url 双源） */
function extractEntry(item: unknown): MarketplaceEntry | null {
  if (typeof item !== 'object' || item === null) return null;
  const e = item as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    source?: { kind?: unknown; path?: unknown; url?: unknown; sha256?: unknown };
  };
  if (typeof e.name !== 'string' || e.name.trim().length === 0) return null;
  if (typeof e.version !== 'string' || e.version.trim().length === 0) return null;
  if (typeof e.source !== 'object' || e.source === null) return null;

  if (e.source.kind === 'file') {
    if (typeof e.source.path !== 'string' || e.source.path.trim().length === 0) return null;
    return {
      name: e.name.trim(),
      version: e.version.trim(),
      description: typeof e.description === 'string' ? e.description : undefined,
      source: { kind: 'file', path: e.source.path.trim() },
    };
  }

  if (e.source.kind === 'url') {
    // 供应链红线：https + sha256 必填，缺失即拒绝（不降级）
    if (typeof e.source.url !== 'string' || !e.source.url.startsWith('https://')) return null;
    if (typeof e.source.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.source.sha256)) return null;
    return {
      name: e.name.trim(),
      version: e.version.trim(),
      description: typeof e.description === 'string' ? e.description : undefined,
      source: { kind: 'url', url: e.source.url.trim(), sha256: e.source.sha256.toLowerCase() },
    };
  }

  return null;
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
 * 安装条目：file 源解析路径（相对索引目录）；url 源下载到缓存目录并校验 sha256。
 * 两者最终都走 registry.loadPlugin（复用 V4.1 全部校验与去重）。
 * 成功返回 pluginPath（绝对路径，可直接写入 config.plugins 实现常驻）。
 */
export async function installPlugin(
  loaded: { index: MarketplaceIndex; baseDir: string },
  entry: MarketplaceEntry,
  registry: PluginLoader,
  fetcher: UrlFetcher = defaultFetch,
): Promise<InstallResult> {
  let pluginPath: string;
  try {
    pluginPath =
      entry.source.kind === 'url'
        ? await downloadRemotePlugin(entry, fetcher)
        : isAbsolute(entry.source.path)
          ? entry.source.path
          : resolve(loaded.baseDir, entry.source.path);
  } catch (err) {
    return {
      name: entry.name,
      success: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

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

/** 默认下载器：global fetch（Node 18+） */
async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * V5.5 远程插件下载 + 校验。
 * 缓存命中（同 url sha256 一致）直接复用本地文件，不重复下载；
 * 校验失败删除落盘文件（不留污染缓存）。
 */
async function downloadRemotePlugin(entry: MarketplaceEntry, fetcher: UrlFetcher): Promise<string> {
  const { url, sha256 } = entry.source as { kind: 'url'; url: string; sha256: string };
  if (!url.startsWith('https://')) {
    throw new Error('远程源必须使用 https（http 明文传输已拒绝）');
  }

  const cacheDir = join(getConfigDir(), 'plugins');
  mkdirSync(cacheDir, { recursive: true });
  // 文件名含 url 短哈希：同 name@version 不同 url 不冲突
  const urlTag = createHash('sha256').update(url).digest('hex').slice(0, 8);
  const safeName = entry.name.replace(/[^a-z0-9-]/gi, '_');
  const filePath = join(cacheDir, `${safeName}-${entry.version}-${urlTag}.mjs`);

  // 缓存命中：内容 sha256 复核（防缓存被篡改后绕过校验）
  if (existsSync(filePath)) {
    const cached = readFileSync(filePath);
    if (sha256Of(cached) === sha256) return filePath;
    rmSync(filePath, { force: true }); // 缓存与 pin 不符 → 作废重下
  }

  const buf = await fetcher(url);
  if (buf.byteLength === 0) throw new Error('下载内容为空');
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`插件超过大小上限（${buf.byteLength} > ${MAX_DOWNLOAD_BYTES} 字节）`);
  }

  const actual = sha256Of(new Uint8Array(buf));
  if (actual !== sha256) {
    throw new Error(`sha256 校验失败（期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）——内容与索引 pin 不符，已拒绝安装`);
  }

  writeFileSync(filePath, new Uint8Array(buf));
  return filePath;
}

function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
