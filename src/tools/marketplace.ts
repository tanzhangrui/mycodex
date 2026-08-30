/**
 * V4.4 — 插件市场索引协议（v1）
 * V5.5 — 远程源（url）安全下载
 * V5.8 — 插件更新（卸旧装新版本升级流）
 * V5.9 — 版本感知更新（semver 对比跳过无效升级）+ V5.10 关键词搜索
 * V5.11 — 远程市场索引（https 拉取）+ V5.12 批量更新（update --all）
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

/** V5.8 更新器：加载 + 卸载（测试可注入桩） */
export interface PluginUpdater {
  loadPlugin: (pluginPath: string) => Promise<number>;
  unloadPlugin: (pluginId: string) => number;
}

/**
 * V5.9 轻量 semver 比较（零依赖）。
 * 规则：按 '.' 分段数值比较；预发布后缀（`1.0.0-beta.1`）低于同号正式版；
 * 段数不同缺失段按 0；非数字段按字符串比较（大小写不敏感）。
 * @returns 正数 = a 更新；0 = 相等；负数 = b 更新
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // 分离预发布后缀：`1.0.0-beta.1` → [1,0,0] + ['-beta.1']
    const m = v.trim().match(/^v?([\dA-Za-z.\-]+)$/i);
    const body = m ? m[1] : v.trim();
    const dash = body.indexOf('-');
    const main = (dash === -1 ? body : body.slice(0, dash)).split('.');
    const pre = dash === -1 ? '' : body.slice(dash + 1);
    return { main, pre };
  };
  const va = parse(a);
  const vb = parse(b);
  const len = Math.max(va.main.length, vb.main.length);
  for (let i = 0; i < len; i++) {
    const sa = va.main[i] ?? '0';
    const sb = vb.main[i] ?? '0';
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    let cmp: number;
    if (na !== null && nb !== null) cmp = na - nb;
    else cmp = sa.toLowerCase().localeCompare(sb.toLowerCase());
    if (cmp !== 0) return cmp;
  }
  // 主版本相同：无预发布 > 有预发布；预发布按字符串比较
  if (va.pre === vb.pre) return 0;
  if (va.pre === '') return 1;
  if (vb.pre === '') return -1;
  return va.pre.toLowerCase().localeCompare(vb.pre.toLowerCase());
}

export interface UpdateResult {
  name: string;
  success: boolean;
  detail: string;
  /** 成功后可直接写入 config.plugins 的新版绝对路径 */
  pluginPath?: string;
  /** 成功后应从 config.plugins 移除的旧路径（与新路径相同则不含） */
  removedPaths: string[];
  /** V5.9：已是最新版本而跳过（无需任何变更） */
  upToDate?: boolean;
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
 * V5.11 从远程 https URL 拉取市场索引。
 *
 * 供应链边界：索引是元数据而非可执行代码（插件本体的执行门槛由 V5.5 的
 * sha256 pin 把关），因此索引拉取不要求 pin，但：
 * - 仅 https（http 明文可被中间人替换 → 拒绝，与插件下载红线一致）
 * - 大小上限 1MB（索引远小于插件，防巨型载荷）
 * - 不缓存：outdated/update 需要每次看到最新索引（缓存会让索引滞后静默化）
 * - 失败 → null（调用方提示，不抛错）
 *
 * baseDir 语义：远程索引的 file 源相对路径以进程 cwd 为基准（与默认
 * ./marketplace.json 一致）；远程索引条目应使用 url 源（绝对地址）。
 */
export async function loadMarketplaceIndexFromUrl(
  url: string,
  fetcher: UrlFetcher = defaultFetch,
): Promise<{ index: MarketplaceIndex; baseDir: string } | null> {
  if (!url.startsWith('https://')) return null; // http 拒绝（含本地 file 路径误传）
  const MAX_INDEX_BYTES = 1024 * 1024;
  try {
    const buf = await fetcher(url);
    if (buf.byteLength === 0) return null;
    if (buf.byteLength > MAX_INDEX_BYTES) return null;
    const raw = new TextDecoder().decode(new Uint8Array(buf));
    const index = parseMarketplaceIndex(raw);
    if (!index) return null;
    return { index, baseDir: process.cwd() };
  } catch {
    return null;
  }
}

/**
 * V5.10 市场关键词搜索。
 * 匹配域：name + description；大小写不敏感；多关键词（空白分隔）全部命中才算匹配（AND）。
 * 排序（相关性降序）：name 精确 > name 前缀 > name 包含 > 仅 description 命中。
 * 关键词数超过匹配域词数的场景自然由子串匹配覆盖（无分词依赖）。
 */
export function searchEntries(loaded: { index: MarketplaceIndex }, query: string): MarketplaceEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ entry: MarketplaceEntry; score: number }> = [];
  for (const entry of loaded.index.plugins) {
    const name = entry.name.toLowerCase();
    const desc = (entry.description ?? '').toLowerCase();
    const hit = terms.every((t) => name.includes(t) || desc.includes(t));
    if (!hit) continue;
    const score = terms.reduce((s, t) => {
      if (name === t) return s + 4; // 精确名命中
      if (name.startsWith(t)) return s + 3; // 前缀
      if (name.includes(t)) return s + 2; // 名包含
      return s + 1; // 仅描述命中
    }, 0);
    scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
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
 * V5.8 插件更新：卸旧 → 装新（版本升级流）。
 *
 * 顺序红线：必须先 unloadPlugin(旧) 再 installPlugin(新)——
 * registry 去重键是 name@version，卸载按名前缀匹配；
 * 若先装新后卸旧，按名卸载可能误删刚注册的新版。
 *
 * 原子性：安装失败时 removedPaths 恒为空——调用方不动 config.plugins，
 * 旧版配置原样保留（下次启动仍加载旧版，升级失败不留半成品）。
 *
 * @param currentPaths 旧版在 config.plugins 中的路径（与新路径相同 → 原地刷新）
 * @param currentVersion V5.9 已装版本号——大于等于索引版本时直接跳过（零下载零变更）
 */
export async function updatePlugin(
  loaded: { index: MarketplaceIndex; baseDir: string },
  entry: MarketplaceEntry,
  registry: PluginUpdater,
  currentPaths: string[],
  fetcher: UrlFetcher = defaultFetch,
  currentVersion?: string,
): Promise<UpdateResult> {
  // V5.9 版本感知：已装版本 >= 索引版本 → 已是最新，跳过下载与卸载
  if (currentVersion && compareVersions(currentVersion, entry.version) >= 0) {
    return {
      name: entry.name,
      success: true,
      upToDate: true,
      detail:
        compareVersions(currentVersion, entry.version) === 0
          ? `已是最新版本 ${entry.version}`
          : `已装 ${currentVersion} 比索引 ${entry.version} 更新，无需更新`,
      removedPaths: [],
    };
  }

  // 先卸旧（按名）：本进程未加载时返回 -1，无副作用
  const unloadedTools = registry.unloadPlugin(entry.name);

  const result = await installPlugin(loaded, entry, registry, fetcher);
  if (!result.success) {
    return {
      name: entry.name,
      success: false,
      detail: `升级到 ${entry.version} 失败: ${result.detail}（旧版配置未动）`,
      removedPaths: [],
    };
  }

  const removedPaths = currentPaths.filter((p) => p !== result.pluginPath);
  const unloadNote = unloadedTools > 0 ? `，卸载旧版 ${unloadedTools} 个工具` : '';
  return {
    name: entry.name,
    success: true,
    detail: `已升级到 ${entry.version}${unloadNote}（${result.detail}）`,
    pluginPath: result.pluginPath,
    removedPaths,
  };
}

// ---- V5.12 批量更新 ----

/** 已装插件信息（名称 / 版本 / 配置中的路径） */
export interface InstalledPlugin {
  name: string;
  version: string;
  paths: string[];
}

export interface BatchUpdateSummary {
  /** 成功升级：name + 旧版本 + 新版本 */
  updated: Array<{ name: string; from: string; to: string; pluginPath?: string; removedPaths: string[] }>;
  /** 已是最新（含比索引新）：插件名 */
  upToDate: string[];
  /** 升级失败：插件名 + 原因（旧版配置未动，可重试） */
  failed: Array<{ name: string; detail: string }>;
  /** 索引中无此插件（无更新来源）：插件名 */
  noSource: string[];
}

/**
 * V5.12 批量更新全部已装插件（update --all）。
 *
 * 逐插件走 V5.9 版本感知 updatePlugin：已是最新跳过、失败不阻断后续
 * （单插件失败不影响其他插件的升级与配置变更——失败项旧版配置原样保留）。
 * 调用方负责按 summary.updated 的 removedPaths 与 pluginPath 做配置原子替换。
 */
export async function updateAllPlugins(
  loaded: { index: MarketplaceIndex; baseDir: string },
  registry: PluginUpdater,
  installed: InstalledPlugin[],
  fetcher: UrlFetcher = defaultFetch,
): Promise<BatchUpdateSummary> {
  const summary: BatchUpdateSummary = { updated: [], upToDate: [], failed: [], noSource: [] };

  for (const p of installed) {
    const entry = findEntry(loaded, p.name);
    if (!entry) {
      summary.noSource.push(p.name);
      continue;
    }
    // 比索引新也算 upToDate（无需变更），由 updatePlugin 统一判定
    if (compareVersions(p.version, entry.version) >= 0) {
      summary.upToDate.push(p.name);
      continue;
    }
    const result = await updatePlugin(loaded, entry, registry, p.paths, fetcher, p.version);
    if (result.success) {
      summary.updated.push({
        name: p.name,
        from: p.version,
        to: entry.version,
        pluginPath: result.pluginPath,
        removedPaths: result.removedPaths,
      });
    } else {
      summary.failed.push({ name: p.name, detail: result.detail });
    }
  }
  return summary;
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
