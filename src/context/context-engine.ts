/**
 * V3.2 — 上下文引擎
 * ==========================================
 *
 * 三路召回融合（符号 → 关键词 → 依赖图），全部按需加载：
 * - 符号索引：零依赖正则近似 AST（TS/JS/TSX/JSX/Python 的 class/function/method/
 *   interface/type/const + 行号），惰性构建 + 进程内缓存
 * - import 图：解析相对 import/require/from 语句，BFS 扩展自动收集相关文件
 * - 大仓库懒加载：扫描阶段只 stat 不读内容；文件内容/符号/imports 均按需读取 + LRU
 * - 隐私：复用 privacy-guard.isSensitivePath，敏感文件（.env*、私钥、凭据等）绝不入索引
 *
 * 调用签名：
 *   const engine = new ContextEngine();
 *   engine.index(workingDir);              // 轻量扫描（零内容读取）
 *   engine.assembleContext(query);         // 三路召回 + 预算裁剪
 *   engine.getRelatedFiles(['src/a.ts']);  // import 图 BFS
 *   engine.resolveQuerySymbols(query);     // 符号名 → 定义位置
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, relative, resolve, dirname, normalize, sep, basename } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { isSensitivePath } from '../core/privacy-guard.js';
import { WorkspaceResolver, type WorkspaceRoot } from '../core/workspace.js';

// ---- 类型 ----

export interface FileIndexEntry {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
  /** 文件摘要（前 500 字符）——懒加载，按需填充 */
  preview?: string;
}

export interface ContextChunk {
  path: string;
  content: string;
  relevance: number;
  /** 起始行号 */
  startLine: number;
  /** 结束行号 */
  endLine: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  keywords: string[];
  timestamp: string;
  weight: number;
}

export interface CodexRule {
  content: string;
  source: 'project' | 'user';
  path: string;
}

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'function'
  | 'method'
  | 'const'
  | 'variable';

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  /** 1 起始行号 */
  line: number;
}

export interface AssembleOptions {
  /** 额外种子文件（如 @引用 / 当前打开文件），优先走 import 图扩展 */
  seedFiles?: string[];
  /** 上下文 token 预算（默认 12K） */
  maxTokens?: number;
  /**
   * V5.13 当前工作目录（键空间内路径，多根含根名前缀如 `web/src`，单根 `src`）。
   * 召回排序前做邻近加权：cwd 子树内文件 +15、同根（多根）+8——
   * 用户正在看的区域优先于语义等价但远处的命中。
   */
  cwd?: string;
  /**
   * V5.24 最近变更文件（键空间路径，来自 git status/diff）。
   * 排序前 relevance +10——正在改的文件几乎总是相关上下文；
   * 只影响排序不改召回集合（与 cwd 加权同一原则）。
   */
  recentFiles?: string[];
}

/** V5.18 索引体检报告（`codex context stats` 数据源） */
export interface ContextReport {
  mode: 'single' | 'multi';
  roots: Array<{ name: string; abs: string; fileCount: number }>;
  fileCount: number;
  sourceFileCount: number;
  symbolCount: number;
  importEdgeCount: number;
  packageAliasCount: number;
  pathAliasCount: number;
  ruleCount: number;
  memoryCount: number;
  lazy: boolean;
  /** 无持久化缓存 / 被拒（版本不符、persistKey 不符、损坏）→ null */
  persisted: {
    version: number;
    structureOk: boolean;
    savedAt: string | null;
    symbolSeeds: number;
    importSeeds: number;
    cacheFile: string | null;
  } | null;
  /** 符号数 top-5 文件 */
  topFiles: Array<{ path: string; symbols: number; size: number }>;
  /**
   * V5.27 召回加权信号概览（`context stats` 第六段）。
   * 三路排序加权（cwd 邻近 / git 最近变更 / 会话活动）的可观测面：
   * 权重参数 + 当前生效的信号文件集合（键空间）。
   */
  signals: {
    /** 排序加权参数（均只改排序不改召回集合） */
    weights: { cwdSubtree: number; cwdSameRoot: number; gitRecent: number; sessionActivity: number };
    /** git 最近变更映射到键空间后的文件（仅保留索引内；空 = 非 git 仓 / 无变更 / 采集失败） */
    gitRecentFiles: string[];
    /** 会话活动文件（最近操作在后；独立实例 stats 恒为空，共享实例对话中非空） */
    sessionActivityFiles: string[];
  };
}

/** V5.20 四路召回分解（`codex context query` 数据源） */
export interface RecallBreakdown {
  /** 查询提取的关键词 */
  keywords: string[];
  /** 符号召回：定义位置 */
  symbols: SymbolEntry[];
  /** 语义召回：token 覆盖率命中 */
  semantic: ContextChunk[];
  /** 关键词召回：内容窗口命中 */
  keywordsHits: ContextChunk[];
  /** import 图 1 跳扩展 */
  related: string[];
  /** V5.19 使用点：符号定义文件的 importers（re-export 链穿透 barrel） */
  usageSites: string[];
  /** 最终组装结果（含 cwd 加权 + 预算裁剪） */
  assembled: ContextChunk[];
}

/** V5.23 单文件召回诊断（`codex context why` 数据源） */
export interface FileRecallExplanation {
  file: string;
  /** 是否在索引内 */
  indexed: boolean;
  /** 符号路：此文件中被查询命中的符号定义 */
  symbolDefs: SymbolEntry[];
  /** 语义路：IDF 加权覆盖率（不过阈值也返回——诊断需要知道差多少）；未入候选池为 null */
  semanticCoverage: number | null;
  /** 语义阈值（诊断参照） */
  semanticThreshold: number;
  /** 关键词路：最优窗口命中数（0 = 内容无关键词；null = 未入候选池） */
  keywordScore: number | null;
  /** import 图路：此文件 import 的种子 / import 此文件的种子（双向 1 跳） */
  importsSeeds: string[];
  importedBySeeds: string[];
  /** 使用点路：此文件是哪些符号定义文件的 hop-N importer（re-export 链穿透） */
  usageOf: Array<{ defFile: string; hop: number }>;
  /** 最终组装：命中块（null = 未进入最终结果） */
  assembledChunk: ContextChunk | null;
  /** 人读诊断结论（召回路径 / 未召回原因） */
  reasons: string[];
}

// ---- 常量 ----

/** 单文件符号解析的大小上限（512KB） */
const SYMBOL_FILE_MAX_BYTES = 512 * 1024;
/** 符号索引总文件数上限 */
const SYMBOL_INDEX_MAX_FILES = 3000;
/** 内容级关键词匹配的仓库规模上限（超过则只对 top-N 候选读内容） */
const FULL_CONTENT_SCAN_MAX_FILES = 200;
/** 关键词候选读取上限 */
const KEYWORD_CANDIDATE_LIMIT = 20;
/** import 图扩展文件数上限 */
const IMPORT_EXPAND_MAX_FILES = 3;
/** LRU 缓存大小 */
const LRU_SIZE = 200;
/** V5.25 会话活动记录上限（FIFO，超出淘汰最旧） */
const SESSION_ACTIVITY_MAX_FILES = 50;

// ---- V3.4 语义检索（n-gram token 覆盖率匹配） ----

/** 单文件参与匹配的内容截断（字符） */
const EMBED_CONTENT_CAP = 20_000;
/** 语义召回覆盖率阈值（查询 token 权重被文件命中的比例，低于则弃） */
const SEMANTIC_THRESHOLD = 0.15;
/** 语义召回 top-K */
const SEMANTIC_TOP_K = 5;

// ---- V3.4 索引持久化 ----

/** 持久化文件数上限 */
const MAX_PERSIST_FILES = 1500;
/** 单文件持久化符号数上限 */
const MAX_PERSIST_SYMBOLS_PER_FILE = 200;
/** V5.16 单文件持久化 import 数上限 */
const MAX_PERSIST_IMPORTS_PER_FILE = 100;
/**
 * V5.18 import 解析器版本——纳入结构指纹。
 * 解析逻辑升级（如 `.js`→`.ts` 后缀剥离）后旧缓存里的解析结果全部失配弃用，
 * 避免"旧解析器写入的空/错 imports 种子被新解析器永久继承"。
 * 改动 resolveImport / resolvePackageImport / resolvePathAliasImport 行为时必须 +1。
 */
const IMPORT_RESOLVER_VERSION = 3;

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

/** import 说明符解析候选扩展（按序探测） */
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py'];
const RESOLVE_INDEX_FILES = ['index.ts', 'index.tsx', 'index.js'];

// ---- 符号提取（零依赖正则近似 AST） ----

const TS_SYMBOL_PATTERNS: Array<{ kind: SymbolKind; re: RegExp }> = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
];

const PY_SYMBOL_PATTERNS: Array<{ kind: SymbolKind; re: RegExp }> = [
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
];

/** 类方法：2+ 空格缩进的 `name(...) {` 形态（TS/JS） */
const METHOD_RE = /^\s{2,}(?:(?:private|public|protected|static|readonly|async|override|abstract|get|set)\s+)*(\*?\s*[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

/** 方法名误报黑名单（控制流关键字） */
const METHOD_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do',
  'try', 'new', 'delete', 'typeof', 'await', 'yield', 'throw', 'case', 'default',
]);

/** 从源码提取符号（带行号）。失败返回空数组——永不抛出。 */
export function extractSymbols(content: string, lang: 'ts' | 'py'): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split('\n');
  const patterns = lang === 'py' ? PY_SYMBOL_PATTERNS : TS_SYMBOL_PATTERNS;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let matched = false;
    for (const { kind, re } of patterns) {
      const m = line.match(re);
      if (m && m[1]) {
        symbols.push({ name: m[1], kind, file: '', line: i + 1 });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (lang === 'ts') {
      const m = line.match(METHOD_RE);
      if (m && m[1]) {
        const name = m[1].replace(/\*\s*/, '').trim();
        if (name && !METHOD_EXCLUDE.has(name)) {
          symbols.push({ name, kind: 'method', file: '', line: i + 1 });
        }
      }
    }
  }
  return symbols;
}

// ---- import 解析 ----

const TS_IMPORT_RES: RegExp[] = [
  /import\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
];

const PY_IMPORT_RES: RegExp[] = [
  /from\s+([.\w]+)\s+import\s/g,
  /import\s+([\w.]+)/g,
];

/**
 * V5.19 re-export 说明符（TS/JS barrel 形态）：
 * `export * from './x'` / `export * as ns from './x'` / `export { a, b } from './x'`。
 * 与 import 边分开维护——import 边用于依赖扩展，re-export 边用于"穿透 barrel 找真实消费者"。
 */
const TS_REEXPORT_RES: RegExp[] = [
  /export\s+\*\s*(?:as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]/g,
  /export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
];

/**
 * 从源码提取相对 import 说明符（未解析）
 */
function extractImportSpecifiers(content: string, lang: 'ts' | 'py', includeBare = false): string[] {
  const specs: string[] = [];
  if (lang === 'py') {
    // V5.6 `from . import a, b` / `from .. import (a, b)` 形态：
    // 说明符是纯 dots，导入的是包内名字 → 展开为 './a' / '../b' 走相对解析
    const dotImport = /from\s+(\.+)\s+import\s+(?:\(([^)]+)\)|([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*))/g;
    let dm: RegExpExecArray | null;
    while ((dm = dotImport.exec(content)) !== null) {
      const dots = dm[1].length;
      const names = (dm[2] ?? dm[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const prefix = dots === 1 ? './' : '../'.repeat(dots - 1);
      for (const name of names) specs.push(`${prefix}${name}`);
    }
  }
  const res = lang === 'py' ? PY_IMPORT_RES : TS_IMPORT_RES;
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (lang === 'ts') {
        // TS/JS：相对说明符（./ 或 ../）恒收集；
        // 裸说明符（包名）仅在多根别名模式下收集（跨根互引解析用）
        if (spec.startsWith('./') || spec.startsWith('../')) specs.push(spec);
        else if (includeBare && !spec.startsWith('.')) specs.push(spec);
      } else {
        // Python：`from .mod import x`（dots+模块）恒收集；
        // 纯 dots（`from . import x`）已由上方展开规则处理，跳过；
        // 裸模块（`from mylib.core import x` / `import mylib`）仅在多根别名模式下收集
        if (/^\.+\w/.test(spec)) specs.push(spec);
        else if (includeBare && !spec.startsWith('.')) specs.push(spec);
      }
    }
  }
  return [...new Set(specs)];
}

/**
 * JSONC 容错：去行/块注释与尾逗号（tsconfig.json 场景）。
 * 字符串感知状态机——行内注释（`"a": 1, // note`）安全剥离，
 * 字符串字面量内的 `//`（如 URL）不会被误删。
 */
function stripJsonc(raw: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const c = raw[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < raw.length) {
        out += raw[i + 1]; // 转义序列原样保留
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1'); // 尾逗号
}

/** 路径分隔符归一化（反斜杠 → 斜杠） */
const BACKSLASH_RE = /\\/g;
/** 去开头斜杠（别名剩余段拼接用） */
const LEADING_SLASH_RE = /^\//;

// ---- V3.4 n-gram 分词（轻量语义检索：token 覆盖率匹配） ----

/**
 * 分词：英文词 unigram/bigram + 词内字符 trigram（≥4 字符词）+ CJK 字 bigram。
 * 判别力来源是共享 n-gram token 覆盖率（词形变体靠字符 trigram：login/logging 共享 log/gin）。
 */
export function tokenizeForEmbedding(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9_$]+/g) ?? [];
  for (const w of words) {
    tokens.push(w);
    // 字符 trigram：词形变体/拼写容错的模糊信号
    if (w.length >= 4) {
      for (let i = 0; i + 3 <= w.length; i++) tokens.push(w.slice(i, i + 3));
    }
  }
  for (let i = 0; i < words.length - 1; i++) tokens.push(`${words[i]}_${words[i + 1]}`);
  const cjk = lower.match(/[\u4e00-\u9fa5]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
  return tokens;
}

/** FNV-1a 哈希（32 位） */
function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---- Trie 树文件索引（路径前缀检索） ----

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isFile = false;
  path: string = '';
}

class FileTrie {
  root = new TrieNode();

  insert(filePath: string): void {
    const parts = filePath.split(/[/\\]/);
    let node = this.root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, new TrieNode());
      }
      node = node.children.get(part)!;
    }
    node.isFile = true;
    node.path = filePath;
  }

  search(prefix: string): string[] {
    const parts = prefix.split(/[/\\]/);
    let node = this.root;
    for (const part of parts) {
      if (!node.children.has(part)) return [];
      node = node.children.get(part)!;
    }
    return this.collect(node);
  }

  private collect(node: TrieNode): string[] {
    const results: string[] = [];
    if (node.isFile) results.push(node.path);
    for (const child of node.children.values()) {
      results.push(...this.collect(child));
    }
    return results;
  }

  /** 模糊搜索文件名 */
  fuzzySearch(query: string): string[] {
    const results: string[] = [];
    const lowerQuery = query.toLowerCase();
    this.fuzzyCollect(this.root, '', lowerQuery, results);
    return results;
  }

  private fuzzyCollect(node: TrieNode, prefix: string, query: string, results: string[]): void {
    if (node.isFile && prefix.toLowerCase().includes(query)) {
      results.push(node.path);
    }
    for (const [name, child] of node.children) {
      this.fuzzyCollect(child, prefix ? `${prefix}/${name}` : name, query, results);
    }
  }
}

// ---- LRU 缓存 ----

class LRUCache<K, V> {
  private map = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** V3.4 增量刷新：删除单个条目（文件变更时失效缓存） */
  delete(key: K): void {
    this.map.delete(key);
  }

  /** V5.16 持久化序列化用：遍历当前缓存条目 */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

// ---- 上下文引擎 ----

export class ContextEngine {
  private workingDir: string = '';
  /** V5.0 多根工作区（null = 单根模式，键空间无前缀，完全向后兼容） */
  private multiRoots: WorkspaceRoot[] | null = null;
  /** V5.3 跨根包名互引：根 package.json name → 根名（多根模式构建；单根恒空） */
  private packageAliases = new Map<string, string>();
  /** V5.7 tsconfig paths 别名：alias 前缀 → 候选键空间前缀列表（单根/多根均构建） */
  private pathAliases = new Map<string, string[]>();
  /** 持久化指纹键：单根 = workingDir（兼容旧缓存）；多根 = 全部根路径拼接（缓存隔离） */
  private persistKey: string = '';
  private fileIndex: FileIndexEntry[] = [];
  private filePathSet = new Set<string>();
  private fileTrie = new FileTrie();
  private fileCache = new LRUCache<string, string>(LRU_SIZE);
  private importCache = new LRUCache<string, string[]>(LRU_SIZE);
  private symbolCache = new LRUCache<string, SymbolEntry[]>(LRU_SIZE);
  /** V3.4 文件 token 集缓存（path → n-gram token 集，覆盖率匹配用） */
  private tokenCache = new LRUCache<string, Set<string>>(LRU_SIZE);
  /** V3.4 持久化符号种子（path → 符号列表，指纹校验通过后加载；refresh 时按文件失效） */
  private persistedSymbols = new Map<string, SymbolEntry[]>();
  /**
   * V5.16 持久化 import 种子（path → 已解析的仓库内键路径列表）。
   * 双门控加载：单文件 size+mtime 指纹 + 工作区结构指纹（路径集 + 别名清单指纹）——
   * imports 的解析结果依赖"当时"的文件集与别名表，任一变化即整体弃用（宁重读勿陈旧）。
   */
  private persistedImports = new Map<string, string[]>();
  /** V5.18 上次加载的持久化缓存诊断（无缓存/被拒 → null；context stats 用） */
  private persistedInfo: { version: number; structureOk: boolean; savedAt: string | null } | null = null;
  /** 全局符号索引（name 小写 → 符号列表），惰性构建 */
  private symbolIndex: Map<string, SymbolEntry[]> | null = null;
  private memoryStore: MemoryEntry[] = [];
  private rules: CodexRule[] = [];
  private indexed = false;

  /**
   * V5.25 会话活动记录（键空间路径，最近操作在后）。
   * Agent 本会话内通过工具读过/改过的文件——"刚亲手操作过"比 git 变更更近的相关性信号。
   * FIFO 上限 50：长会话防膨胀，淘汰最旧的活动；重复操作移到队尾（保"最近"语义）。
   */
  private sessionActivityKeys: string[] = [];

  /** V3.4 持久化写盘串行链 + 防重入标记 */
  private saveChain: Promise<void> = Promise.resolve();
  private savePending = false;

  /**
   * 扫描项目目录，构建文件索引。
   * V3.2 懒加载：扫描阶段只 stat 不读内容——文件内容/符号/imports 全部按需读取。
   * V3.4：扫描后加载持久化符号缓存（指纹校验通过的直接种子，免读盘）。
   * V5.0：支持多根（string[]）——键空间统一为 rootName/rel，四路召回与 import 图零改动即跨根。
   * 单根（string）行为与旧版完全一致（无前缀键）。
   * 隐私：敏感文件（.env*、私钥、凭据等）绝不入索引。
   */
  async index(workingDir: string | string[]): Promise<void> {
    if (Array.isArray(workingDir) && workingDir.length > 1) {
      // 静态导入（非动态 import）：保证 index() 全程同步完成——
      // 共享单例是 void 调用，首次查询的系统提示词不能与扫描竞态
      const resolver = new WorkspaceResolver(workingDir);
      this.multiRoots = [...resolver.rootList];
      this.workingDir = resolver.primaryRoot;
      this.persistKey = this.multiRoots.map((r) => r.abs).join('|');
      this.buildPackageAliases();
      this.buildPathAliases();
    } else {
      this.multiRoots = null;
      this.workingDir = resolve(Array.isArray(workingDir) ? workingDir[0] : workingDir);
      this.persistKey = this.workingDir;
      this.packageAliases = new Map(); // 单根：包名别名模式关闭，行为与旧版完全一致
      this.buildPathAliases(); // V5.7：tsconfig paths 单根也生效（有别名才收集裸说明符，无 tsconfig 零回归）
    }

    this.fileCache = new LRUCache<string, string>(LRU_SIZE);
    this.importCache = new LRUCache<string, string[]>(LRU_SIZE);
    this.symbolCache = new LRUCache<string, SymbolEntry[]>(LRU_SIZE);
    this.tokenCache = new LRUCache<string, Set<string>>(LRU_SIZE);
    this.persistedSymbols = new Map();
    this.persistedImports = new Map();
    this.persistedInfo = null;
    this.symbolIndex = null;
    this.reverseIndex = null;

    const files: FileIndexEntry[] = [];
    this.scanAllRoots(files);
    this.applyFileList(files);
    this.indexed = true;

    // V3.4：持久化缓存种子（size+mtime 指纹逐文件校验，不匹配即弃）
    this.loadPersistedIndex();

    // 加载规则文件
    this.loadRules();
  }

  /** 扫描全部根：单根无前缀；多根以 rootName/ 前缀统一键空间 */
  private scanAllRoots(out: FileIndexEntry[]): void {
    if (this.multiRoots) {
      for (const root of this.multiRoots) {
        this.scanDirectory(root.abs, 0, out, root.abs, `${root.name}/`);
      }
    } else {
      this.scanDirectory(this.workingDir, 0, out, this.workingDir, '');
    }
  }

  /**
   * V5.3 跨根包名互引：读各根 package.json 的 name → 包名别名映射。
   * V5.6 Python 根：无 package.json 时读 pyproject.toml 的 name（连字符归一化为
   * 下划线——PEP 8 包名约束，pyproject name "my-lib" 对应 import my_lib）。
   * monorepo 场景（backend import '@acme/shared-lib' / app `from mylib.core import x`）
   * 经此映射进入目标根的键空间。
   * 无清单 / name 缺失 / 内容损坏 → 该根无别名（静默跳过）。
   */
  private buildPackageAliases(): void {
    this.packageAliases = new Map();
    if (!this.multiRoots) return;
    for (const root of this.multiRoots) {
      try {
        const pkg = JSON.parse(readFileSync(join(root.abs, 'package.json'), 'utf-8')) as { name?: unknown };
        if (typeof pkg.name === 'string' && pkg.name.trim().length > 0) {
          this.packageAliases.set(pkg.name.trim(), root.name);
          continue;
        }
      } catch {
        // 无 package.json → 尝试 pyproject.toml（Python 根）
      }
      try {
        const pyproject = readFileSync(join(root.abs, 'pyproject.toml'), 'utf-8');
        const m = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        if (m && m[1].trim().length > 0) {
          // Python 包名不含连字符：my-lib → my_lib
          this.packageAliases.set(m[1].trim().replace(/-/g, '_'), root.name);
        }
      } catch {
        // 无 pyproject.toml → 该根无别名
      }
    }
  }

  /**
   * V5.7 tsconfig paths 别名：读各根 tsconfig.json 的 compilerOptions.paths，
   * 将别名前缀映射到键空间前缀（rootName/baseUrl/target）。
   * - JSONC 容错（行/块注释、尾逗号）
   * - `@shared/*` → 前缀 `@shared`；目标 `src/shared/*` → 前缀 `<root>/src/shared`
   * - 一个别名可有多个目标（按序探测）；无 tsconfig / 无 paths → 该根无别名
   * - 单根键空间无前缀（target 直接是 baseUrl 相对路径）
   */
  private buildPathAliases(): void {
    this.pathAliases = new Map();
    const roots: Array<{ name: string; abs: string }> = this.multiRoots
      ? this.multiRoots.map((r) => ({ name: r.name, abs: r.abs }))
      : [{ name: '', abs: this.workingDir }];

    for (const root of roots) {
      let paths: Record<string, string[]> | null = null;
      let baseUrl = '.';
      try {
        const raw = readFileSync(join(root.abs, 'tsconfig.json'), 'utf-8');
        const tsconfig = JSON.parse(stripJsonc(raw)) as {
          compilerOptions?: { baseUrl?: unknown; paths?: unknown };
        };
        const co = tsconfig.compilerOptions;
        if (typeof co?.baseUrl === 'string' && co.baseUrl.trim()) baseUrl = co.baseUrl.trim();
        if (co?.paths && typeof co.paths === 'object') {
          paths = co.paths as Record<string, string[]>;
        }
      } catch {
        continue; // 无 tsconfig / 损坏 → 跳过
      }
      if (!paths) continue;

      for (const [alias, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const aliasPrefix = alias.replace(/\/\*$/, '').trim();
        if (!aliasPrefix) continue;
        const candidates: string[] = [];
        for (const t of targets) {
          if (typeof t !== 'string' || !t.trim()) continue;
          const targetRel = t.replace(/\/\*$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
          // 键空间前缀：多根 rootName/baseUrl/target；单根 baseUrl/target（无前缀）
          const withBase = normalize(`${baseUrl}/${targetRel}`).replace(/\\/g, '/');
          candidates.push(root.name ? `${root.name}/${withBase}` : withBase);
        }
        if (candidates.length > 0) {
          // 同名别名跨根共存：合并候选（按根声明序探测）
          const existing = this.pathAliases.get(aliasPrefix) ?? [];
          this.pathAliases.set(aliasPrefix, [...existing, ...candidates]);
        }
      }
    }
  }

  /**
   * V3.4 增量刷新：重扫目录（stat-only 便宜），按 size/mtime 双指纹
   * 只失效变更文件的缓存（内容/符号/imports/嵌入/持久化种子）。
   * 符号索引置空惰性重建——未变文件命中逐文件缓存，无重读盘。
   * V5.0：多根模式下重扫全部根（统一键空间不变）。
   */
  refresh(): void {
    if (!this.indexed || !this.workingDir) return;

    const prev = new Map(this.fileIndex.map((e) => [e.path, e]));
    const files: FileIndexEntry[] = [];
    this.scanAllRoots(files);
    const nextPaths = new Set(files.map((e) => e.path));

    // 删除的文件 → 失效全部缓存
    for (const path of prev.keys()) {
      if (!nextPaths.has(path)) this.invalidateFile(path);
    }
    // 新增/变更的文件 → 失效全部缓存（同 size 不同 mtime 也失效，宁多勿漏）
    for (const entry of files) {
      const old = prev.get(entry.path);
      if (!old || old.size !== entry.size || old.modifiedAt.getTime() !== entry.modifiedAt.getTime()) {
        this.invalidateFile(entry.path);
      }
    }

    this.applyFileList(files);
    this.symbolIndex = null;
    this.reverseIndex = null; // V5.19：文件增删改会影响反向边，重建
    this.reExportIndex = null; // V5.19：re-export 边同理，重建
  }

  /** 失效单文件的全部派生缓存 */
  private invalidateFile(relPath: string): void {
    this.fileCache.delete(relPath);
    this.importCache.delete(relPath);
    this.symbolCache.delete(relPath);
    this.tokenCache.delete(relPath);
    this.persistedSymbols.delete(relPath);
    this.persistedImports.delete(relPath);
  }

  private applyFileList(files: FileIndexEntry[]): void {
    this.fileIndex = files;
    this.filePathSet = new Set(files.map((f) => f.path));
    this.fileTrie = new FileTrie();
    for (const f of files) this.fileTrie.insert(f.path);
  }

  /**
   * 递归扫描目录。V5.0：baseDir + prefix 参数化——多根时以 rootName/ 前缀
   * 生成统一键空间，单根时 prefix 为空串与旧行为完全一致。
   */
  private scanDirectory(dir: string, depth: number, out: FileIndexEntry[], baseDir: string, prefix: string): void {
    if (depth > 10) return;

    const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage']);

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') && entry !== '.gitignore') continue;
        if (ignored.has(entry)) continue;

        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            this.scanDirectory(fullPath, depth + 1, out, baseDir, prefix);
          } else if (stat.isFile() && stat.size < 1_048_576) {
            const relPath = prefix + normalizeRelPath(relative(baseDir, fullPath));

            // 隐私红线：敏感文件绝不入索引（复用 privacy-guard 判定）
            if (isSensitivePath(relPath) || isSensitivePath(entry)) continue;
            if (!this.isTextFile(entry)) continue;

            out.push({
              path: relPath,
              name: entry,
              size: stat.size,
              modifiedAt: stat.mtime,
            });
          }
        } catch {
          // 跳过
        }
      }
    } catch {
      // 跳过
    }
  }

  private isTextFile(filename: string): boolean {
    // 注意：.env 系列已由 isSensitivePath 拦截，此处不再列入
    const textExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.yaml', '.yml', '.toml', '.xml', '.sql', '.sh', '.gitignore']);
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
    return textExts.has(ext) || textExts.has(filename);
  }

  private langOf(path: string): 'ts' | 'py' | null {
    if (path.endsWith('.py')) return 'py';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'ts';
    return null;
  }

  /**
   * V5.0 统一键 → 绝对路径。多根模式按 rootName 前缀路由到对应根；
   * 单根模式与旧行为完全一致（join(workingDir, key)）。
   */
  private keyToAbs(key: string): string {
    if (this.multiRoots) {
      const sepIdx = key.indexOf('/');
      const rootName = sepIdx === -1 ? key : key.slice(0, sepIdx);
      const root = this.multiRoots.find((r) => r.name === rootName);
      if (root) {
        const rest = sepIdx === -1 ? '' : key.slice(sepIdx + 1);
        return rest ? join(root.abs, rest) : root.abs;
      }
    }
    return join(this.workingDir, key);
  }

  /**
   * V5.15 绝对路径 → 统一键（keyToAbs 的逆映射）。
   * 多根：按根前缀匹配（最长根优先防嵌套根误配）→ `rootName/rel`；
   * 单根：相对 workingDir；越界（不在任何根下）返回 null。
   * agent-loop 用它把会话实际 cwd 转成键空间路径传给 assembleContext。
   */
  absToKey(absPath: string): string | null {
    const abs = resolve(absPath);
    if (this.multiRoots) {
      // 最长根优先：嵌套根（a 与 a/b）时更具体的根胜出
      const sorted = [...this.multiRoots].sort((x, y) => y.abs.length - x.abs.length);
      for (const root of sorted) {
        if (abs === root.abs) return root.name;
        if (abs.startsWith(root.abs + sep)) {
          const rest = abs.slice(root.abs.length + 1).replace(/\\/g, '/');
          return `${root.name}/${rest}`;
        }
      }
      return null;
    }
    if (abs === this.workingDir) return '';
    if (abs.startsWith(this.workingDir + sep)) {
      return abs.slice(this.workingDir.length + 1).replace(/\\/g, '/');
    }
    return null;
  }

  /**
   * 获取文件内容（懒加载 + LRU 缓存）
   */
  getFileContent(relPath: string): string | null {
    const key = normalizeRelPath(relPath);
    const cached = this.fileCache.get(key);
    if (cached !== undefined) return cached;
    if (!this.filePathSet.has(key)) return null;

    const fullPath = this.keyToAbs(key);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      this.fileCache.set(key, content);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * 获取文件摘要（懒加载，前 500 字符）
   */
  getPreview(relPath: string): string {
    const entry = this.fileIndex.find((e) => e.path === normalizeRelPath(relPath));
    if (entry?.preview) return entry.preview;
    const content = this.getFileContent(relPath);
    const preview = content ? content.substring(0, 500) : '';
    if (entry) entry.preview = preview;
    return preview;
  }

  // ---- 符号索引 ----

  /**
   * 解析单个文件的符号（LRU 缓存 → 持久化种子 → 读盘解析）
   */
  extractFileSymbols(relPath: string): SymbolEntry[] {
    const key = normalizeRelPath(relPath);
    const cached = this.symbolCache.get(key);
    if (cached !== undefined) return cached;

    // V3.4：持久化种子（指纹已校验，免读盘）
    const persisted = this.persistedSymbols.get(key);
    if (persisted) {
      this.symbolCache.set(key, persisted);
      return persisted;
    }

    const lang = this.langOf(key);
    if (!lang) return [];

    const entry = this.fileIndex.find((e) => e.path === key);
    if (entry && entry.size > SYMBOL_FILE_MAX_BYTES) return [];

    const content = this.getFileContent(key);
    if (!content) return [];

    const symbols = extractSymbols(content, lang).map((s) => ({ ...s, file: key }));
    this.symbolCache.set(key, symbols);
    return symbols;
  }

  /**
   * 构建全局符号索引（惰性：首次符号查询时触发）
   */
  private buildSymbolIndex(): Map<string, SymbolEntry[]> {
    if (this.symbolIndex) return this.symbolIndex;

    const index = new Map<string, SymbolEntry[]>();
    let count = 0;
    for (const entry of this.fileIndex) {
      if (count >= SYMBOL_INDEX_MAX_FILES) break;
      if (!SOURCE_EXTS.has(extOf(entry.path))) continue;
      if (entry.size > SYMBOL_FILE_MAX_BYTES) continue;

      for (const sym of this.extractFileSymbols(entry.path)) {
        const lower = sym.name.toLowerCase();
        const list = index.get(lower);
        if (list) list.push(sym);
        else index.set(lower, [sym]);
      }
      count++;
    }
    this.symbolIndex = index;

    // V3.4：构建完成后异步落盘（串行链，不阻塞查询）
    this.queueSavePersistedIndex();
    return index;
  }

  /**
   * 查询文本中提到的符号 → 定义位置（文件 + 行号）
   */
  resolveQuerySymbols(query: string, limit = 5): SymbolEntry[] {
    if (!this.indexed) return [];

    const tokens = extractIdentifierTokens(query);
    if (tokens.length === 0) return [];

    const index = this.buildSymbolIndex();
    const hits: SymbolEntry[] = [];
    const seen = new Set<string>();

    // 第一轮：精确匹配（大小写不敏感）
    for (const token of tokens) {
      const lower = token.toLowerCase();
      const list = index.get(lower);
      if (list) {
        for (const sym of list) {
          const k = `${sym.file}:${sym.line}:${sym.name}`;
          if (!seen.has(k)) {
            seen.add(k);
            hits.push(sym);
          }
        }
      }
    }

    // 第二轮：前缀匹配（符号名 ≥ 3 字符）
    if (hits.length < limit) {
      for (const token of tokens) {
        if (token.length < 3 || hits.length >= limit) break;
        const lower = token.toLowerCase();
        for (const [name, list] of index) {
          if (name.length < 3) continue;
          if (name.startsWith(lower) || lower.startsWith(name)) {
            for (const sym of list) {
              const k = `${sym.file}:${sym.line}:${sym.name}`;
              if (!seen.has(k)) {
                seen.add(k);
                hits.push(sym);
                if (hits.length >= limit) break;
              }
            }
          }
          if (hits.length >= limit) break;
        }
      }
    }

    return hits.slice(0, limit);
  }

  // ---- import 图 ----

  /**
   * 解析单文件的相对 import（已解析为仓库内 relPath，带 LRU 缓存）
   */
  parseImports(relPath: string): string[] {
    const key = normalizeRelPath(relPath);
    const cached = this.importCache.get(key);
    if (cached !== undefined) return cached;

    // V5.16：持久化种子（单文件指纹 + 结构指纹双门控已过，免读盘）
    const persisted = this.persistedImports.get(key);
    if (persisted) {
      this.importCache.set(key, persisted);
      return persisted;
    }

    const lang = this.langOf(key);
    if (!lang) return [];

    const content = this.getFileContent(key);
    if (!content) return [];

    const resolved: string[] = [];
    // 多根模式 + 存在包名别名，或任一根有 tsconfig paths → 收集裸说明符（别名互引解析用）
    const includeBare =
      (this.multiRoots !== null && this.packageAliases.size > 0) || this.pathAliases.size > 0;
    for (const spec of extractImportSpecifiers(content, lang, includeBare)) {
      const target = this.resolveImport(key, spec, lang);
      if (target && target !== key) resolved.push(target);
    }
    const unique = [...new Set(resolved)];
    this.importCache.set(key, unique);
    return unique;
  }

  /**
   * 将相对 import 说明符解析为索引内的 relPath（扩展名/索引文件探测）
   * V5.18：TS ESM 约定——`./x.js` 常实际指 `./x.ts`（tsc emit 后扩展名不变），
   * 探测失败时剥离 `.js/.mjs/.cjs` 后缀再探测一轮。
   * V5.22：Python dots 前缀归一——`.mod` → `./mod`、`..mod` → `../mod`
   * （此前 `.mod` 被当字面路径段，根级文件相对导入全部解析失败）。
   */
  private resolveImport(fromFile: string, spec: string, lang: 'ts' | 'py'): string | null {
    // V5.7 tsconfig paths 优先：`@shared/utils` → 键空间前缀替换后探测
    // V5.3 跨根包名互引：裸说明符（非 ./ ../ 开头）走包名别名解析。
    // 未命中任何别名的外部包（node:fs / react / lodash 等）不属于工作区 → 直接放弃，
    // 与旧版"裸说明符不收集"行为等价（不会误拼出 dirname/pkg 假路径）。
    if (!spec.startsWith('.') && (this.pathAliases.size > 0 || this.packageAliases.size > 0)) {
      const viaPaths = this.resolvePathAliasImport(spec);
      if (viaPaths) return viaPaths;
      return this.resolvePackageImport(spec);
    }

    // V5.22 Python 相对说明符形态归一（`from .mod import x` 捕获 `.mod`）
    if (lang === 'py') {
      const dots = spec.match(/^(\.+)(.*)$/);
      if (dots && dots[2]) {
        spec = (dots[1].length === 1 ? './' : '../'.repeat(dots[1].length - 1)) + dots[2];
      }
    }

    const base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, '/');

    // V5.18 候选基名：原样 + 剥离 JS 扩展（TS ESM `.js` → `.ts` 约定；Python 不适用）
    const bases = [base];
    if (lang !== 'py') {
      const jsExt = base.match(/\.(js|mjs|cjs)$/)?.[0];
      if (jsExt) bases.push(base.slice(0, -jsExt.length));
    }

    for (const b of bases) {
      for (const ext of RESOLVE_EXTS) {
        const candidate = b + ext;
        if (this.filePathSet.has(candidate)) return candidate;
      }
    }
    if (lang !== 'py') {
      for (const b of bases) {
        for (const idx of RESOLVE_INDEX_FILES) {
          const candidate = `${b}/${idx}`;
          if (this.filePathSet.has(candidate)) return candidate;
        }
      }
    } else {
      // V5.22 Python 目录导入：`from .pkg import X` 实指包入口 pkg/__init__.py
      for (const b of bases) {
        const candidate = `${b}/__init__.py`;
        if (this.filePathSet.has(candidate)) return candidate;
      }
    }
    return null;
  }

  /**
   * V5.7 tsconfig paths 别名解析：`@shared/utils` → 候选前缀逐一替换探测。
   * 最长前缀匹配（`@app/*` 与 `@app/legacy/*` 并存时优先后者）；
   * 精确别名（无 `/*` 的 `@app`）与通配别名统一处理。
   */
  private resolvePathAliasImport(spec: string): string | null {
    if (this.pathAliases.size === 0) return null;
    const normalized = spec.replace(BACKSLASH_RE, '/');

    // 最长前缀匹配：spec === prefix 或 spec 以 prefix/ 开头
    let bestPrefix = '';
    for (const prefix of this.pathAliases.keys()) {
      if (
        (normalized === prefix || normalized.startsWith(prefix + '/')) &&
        prefix.length > bestPrefix.length
      ) {
        bestPrefix = prefix;
      }
    }
    if (!bestPrefix) return null;

    const rest = normalized.slice(bestPrefix.length).replace(LEADING_SLASH_RE, '');
    for (const candidate of this.pathAliases.get(bestPrefix) ?? []) {
      const base = rest.length > 0 ? candidate + '/' + rest : candidate;
      const hit = this.probeEntry(base);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * V5.3 裸说明符 → 跨根键解析。
   * 形态：`@scope/pkg` / `@scope/pkg/sub` / `pkg` / `pkg/sub`（TS/JS）；
   * V5.6 dotted 形态：`mylib` / `mylib.core` / `mylib.core.util`（Python）。
   * 包名（含 scope / pyproject 归一化名）命中别名 → 目标根键空间内探测：
   *   - 无子路径：根入口（TS：index.*；Python：__init__.py）
   *   - 有子路径：`root/sub`（+扩展名/index/__init__）→ dist/src/lib 前缀兜底
   */
  private resolvePackageImport(spec: string): string | null {
    const normalized = spec.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || normalized.startsWith('node:')) return null;

    // Python dotted 说明符（无 '/'，含 '.'）：按 '.' 分段（mylib.core → mylib + core）
    const isDotted = !normalized.includes('/') && normalized.includes('.');
    const segs = isDotted ? normalized.split('.') : normalized.split('/');
    let pkg: string;
    let rest: string[];
    if (!isDotted && segs[0].startsWith('@')) {
      if (segs.length < 2) return null; // 裸 '@scope' 不是合法包名
      pkg = `${segs[0]}/${segs[1]}`;
      rest = segs.slice(2);
    } else {
      pkg = segs[0];
      rest = segs.slice(1);
    }

    const rootName = this.packageAliases.get(pkg);
    if (!rootName) return null;

    const base = rest.length === 0 ? rootName : `${rootName}/${rest.join('/')}`;
    const direct = this.probeEntry(base);
    if (direct) return direct;
    // src-layout 兜底：根下与包同名的目录（rootName/mylib/core.py / rootName/pkg/sub.ts）
    const asPath = isDotted ? normalized.replace(/\./g, '/') : normalized;
    const nested = this.probeEntry(`${rootName}/${asPath}`);
    if (nested) return nested;
    // 发布产物布局差异兜底：dist/ src/ lib/
    for (const prefix of ['dist', 'src', 'lib']) {
      const alt = this.probeEntry(`${rootName}/${prefix}${rest.length > 0 ? `/${rest.join('/')}` : ''}`);
      if (alt) return alt;
    }
    return null;
  }

  /** 键空间内探测：base+扩展名 → base/index.* → base/__init__.py（Python 包入口） */
  private probeEntry(base: string): string | null {
    for (const ext of RESOLVE_EXTS) {
      if (this.filePathSet.has(base + ext)) return base + ext;
    }
    for (const idx of [...RESOLVE_INDEX_FILES, '__init__.py']) {
      const candidate = `${base}/${idx}`;
      if (this.filePathSet.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * import 图 BFS：从种子文件出发收集相关文件（直接依赖优先）。
   * V5.19 direction：'deps'（默认，文件 → 其 import，旧行为）/ 'importers'
   * （文件 → 谁 import 它，反向）/ 'both'（双向合并）——barrel 场景 'both' 两跳
   * 即可从源文件穿到 barrel 再穿到消费者（re-export 链路天然打通）。
   */
  getRelatedFiles(
    seedFiles: string[],
    maxHops = 1,
    maxFiles = IMPORT_EXPAND_MAX_FILES,
    direction: 'deps' | 'importers' | 'both' = 'deps',
  ): string[] {
    if (!this.indexed) return [];

    const results: string[] = [];
    const visited = new Set(seedFiles.map(normalizeRelPath));
    let frontier = [...visited];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: string[] = [];
      for (const file of frontier) {
        const edges =
          direction === 'deps'
            ? this.parseImports(file)
            : direction === 'importers'
              ? this.getImportedBy(file)
              : [...this.parseImports(file), ...this.getImportedBy(file)];
        for (const dep of edges) {
          if (!visited.has(dep)) {
            visited.add(dep);
            next.push(dep);
            if (results.length < maxFiles) results.push(dep);
          }
        }
      }
      frontier = next;
      if (results.length >= maxFiles) break;
    }
    return results.slice(0, maxFiles);
  }

  // ---- V5.19 反向依赖索引（imported-by） ----

  /**
   * 反向依赖索引：文件 → 直接 import 它的文件列表。
   * 惰性构建（首次反向查询触发），全量解析源码文件 imports（含持久化种子），
   * 与符号索引同一文件集边界（源码扩展名 + 512KB 上限 + 3000 文件上限）。
   * refresh 时置空重建（任一文件 imports 变化都会影响反向边）。
   */
  private reverseIndex: Map<string, string[]> | null = null;

  private buildReverseIndex(): Map<string, string[]> {
    if (this.reverseIndex) return this.reverseIndex;

    const index = new Map<string, string[]>();
    let scanned = 0;
    for (const entry of this.fileIndex) {
      if (scanned >= SYMBOL_INDEX_MAX_FILES) break;
      if (!SOURCE_EXTS.has(extOf(entry.path))) continue;
      if (entry.size > SYMBOL_FILE_MAX_BYTES) continue;
      scanned++;
      for (const dep of this.parseImports(entry.path)) {
        const list = index.get(dep);
        if (list) {
          if (!list.includes(entry.path)) list.push(entry.path);
        } else {
          index.set(dep, [entry.path]);
        }
      }
    }
    this.reverseIndex = index;
    return index;
  }

  /** V5.19 谁 import 了此文件（直接一级，键空间路径） */
  getImportedBy(relPath: string): string[] {
    if (!this.indexed) return [];
    return [...(this.buildReverseIndex().get(normalizeRelPath(relPath)) ?? [])];
  }

  /**
   * V5.19 re-export 链索引：被 re-export 的文件 → 转发它的 barrel 文件集合。
   * `index.ts` 里 `export * from './widget'` → widget.ts → { index.ts }。
   * V5.22 Python：`pkg/__init__.py` 里 `from .helper import Helper` 视为转发
   * （helper 的名字经包入口对外可见）——pkg/helper.py → { pkg/__init__.py }。
   * 惰性构建，refresh 时随 reverseIndex 一同置空重建。
   */
  private reExportIndex: Map<string, Set<string>> | null = null;

  private buildReExportIndex(): Map<string, Set<string>> {
    if (this.reExportIndex) return this.reExportIndex;

    const index = new Map<string, Set<string>>();
    const addEdge = (target: string | null, barrel: string) => {
      if (target && target !== barrel) {
        const set = index.get(target);
        if (set) set.add(barrel);
        else index.set(target, new Set([barrel]));
      }
    };

    let scanned = 0;
    for (const entry of this.fileIndex) {
      if (scanned >= SYMBOL_INDEX_MAX_FILES) break;
      if (!SOURCE_EXTS.has(extOf(entry.path))) continue;
      if (entry.size > SYMBOL_FILE_MAX_BYTES) continue;
      scanned++;

      const lang = this.langOf(entry.path);
      // V5.22：Python 仅包入口 __init__.py 视为 barrel（普通模块的 import 不是转发）
      const isPyInit = lang === 'py' && entry.name === '__init__.py';
      if (lang !== 'ts' && !isPyInit) continue;

      const content = this.getFileContent(entry.path);
      if (!content) continue;

      if (lang === 'ts') {
        for (const re of TS_REEXPORT_RES) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(content)) !== null) {
            // 相对说明符恒解析；裸说明符走别名表（跨根 barrel）
            addEdge(this.resolveImport(entry.path, m[1], 'ts'), entry.path);
          }
        }
      } else {
        // __init__.py：全部（相对）import 说明符都是转发候选
        // （`from .mod import X` / `from . import mod` 两种形态均覆盖）
        for (const spec of extractImportSpecifiers(content, 'py', false)) {
          addEdge(this.resolveImport(entry.path, spec, 'py'), entry.path);
        }
      }
    }
    this.reExportIndex = index;
    return index;
  }

  /** importer 是否对 target 做 re-export（barrel 转发判定） */
  private isReExportOf(importer: string, target: string): boolean {
    return (this.buildReExportIndex().get(target) ?? new Set()).has(normalizeRelPath(importer));
  }

  /**
   * V5.19 re-export 链追踪：穿过 barrel 的间接 importer（真实消费者）。
   * 链路：widget.ts ← index.ts（`export * from './widget'`）← consumer.ts
   * `getImportedBy('widget.ts')` 只见 index.ts——消费者 import 的是 barrel 不是源文件；
   * expanded 穿透 barrel 连带 consumer.ts。穿透条件严格限定 re-export 边
   * （普通 import 不穿透，避免"传递依赖全算使用点"的过度扩散），默认 3 跳防环。
   */
  getImportedByExpanded(relPath: string, maxHops = 3): string[] {
    return [...this.importedByWithDepth(relPath, maxHops).keys()];
  }

  /**
   * V5.21 分层使用点：文件 → 距定义处的跳数（hop 1 = 直接 importer，
   * hop 2+ = 经 re-export 链的 barrel 间接消费者）。同一文件经多条链可达时取最短跳。
   */
  getImportedByLayered(relPath: string, maxHops = 3): Array<{ file: string; hop: number }> {
    return [...this.importedByWithDepth(relPath, maxHops)].map(([file, hop]) => ({ file, hop }));
  }

  /** V5.21 带跳数的 BFS 穿透（getImportedByExpanded / getImportedByLayered 共用） */
  private importedByWithDepth(relPath: string, maxHops: number): Map<string, number> {
    if (!this.indexed) return new Map();
    const start = normalizeRelPath(relPath);
    const depth = new Map<string, number>();
    const visited = new Set<string>([start]);
    let frontier = [start];

    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const importer of this.getImportedBy(file)) {
          const prev = depth.get(importer);
          if (prev === undefined || hop < prev) depth.set(importer, hop);
          if (!visited.has(importer) && this.isReExportOf(importer, file)) {
            visited.add(importer);
            next.push(importer); // barrel 转发：barrel 的消费者也是源文件的间接使用点
          }
        }
      }
      frontier = next;
    }
    return depth;
  }

  // ---- 四路召回融合 ----

  /**
   * V3.4 语义召回：查询 token 覆盖率匹配（无哈希碰撞、可预测、可调试）。
   * V5.4 IDF 加权：覆盖率 = 文件命中的查询 token IDF 权重 / 总 IDF 权重——
   * 常见 token（export/const 等）权重被文档频率压低，区分性 token 主导排序。
   * 轻量语义（模糊词法），兜底符号/关键词都未命中的口语化查询。
   */
  semanticRecall(query: string, topK = SEMANTIC_TOP_K): ContextChunk[] {
    if (!this.indexed) return [];
    const keywords = this.extractKeywords(query);

    const scored = [...this.semanticScores(query).entries()]
      .filter(([, coverage]) => coverage > SEMANTIC_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    const chunks: ContextChunk[] = [];
    for (const [path, coverage] of scored) {
      const content = this.getFileContent(path);
      if (!content) continue;
      // 窗口优先关键词命中处，否则文件头
      const chunk = this.findBestChunk(content, keywords, path) ?? this.chunkAroundLine(path, 1, 60);
      if (chunk) {
        // 语义相关性上限 80：低于符号精确命中（100），高于关键词（≤50）
        chunk.relevance = Math.min(80, Math.max(1, Math.round(coverage * 100)));
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  /**
   * V5.23 语义路逐文件 IDF 加权覆盖率（semanticRecall / explainRecall 共用）。
   * 返回全部候选文件（含未过阈值的——诊断"为什么没过阈值"需要知道差多少）。
   */
  private semanticScores(query: string): Map<string, number> {
    if (!this.indexed) return new Map();

    const queryTokens = tokenizeForEmbedding(query);
    if (queryTokens.length === 0) return new Map();

    // 查询 token 权重（类 TF：越靠前的 token 越重要）
    const queryWeights = new Map<string, number>();
    queryTokens.forEach((tok, idx) => {
      const weight = 1 / Math.log2(idx + 2);
      queryWeights.set(tok, (queryWeights.get(tok) || 0) + weight);
    });
    const totalQueryWeight = [...queryWeights.values()].reduce((a, b) => a + b, 0);
    if (totalQueryWeight === 0) return new Map();

    const keywords = this.extractKeywords(query);

    // 候选池：小仓全量；大仓只取名称相关性 top-30（与关键词召回同一闸门）
    let candidates: FileIndexEntry[];
    if (this.fileIndex.length <= FULL_CONTENT_SCAN_MAX_FILES) {
      candidates = this.fileIndex;
    } else {
      candidates = this.fileIndex
        .map((entry) => ({ entry, score: this.nameRelevance(entry, keywords) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .map((s) => s.entry);
    }

    // V5.4 两遍扫描 + IDF 加权：
    // 第一遍收集候选 token 集并统计查询 token 的文档频率（df）；
    // 第二遍以 idf = ln(1 + N/df) 加权命中率——常见 token（export/const/function
    // 等几乎每文件都有的）权重被压到接近 ln2，区分性 token（createUser、
    // token-store、领域词等）主导覆盖率与排序，常见词虚高覆盖率的问题消除。
    const tokenSets: Array<{ entry: FileIndexEntry; tokens: Set<string> }> = [];
    const df = new Map<string, number>();
    for (const entry of candidates) {
      const fileTokens = this.getFileTokens(entry.path);
      if (!fileTokens) continue;
      tokenSets.push({ entry, tokens: fileTokens });
      for (const tok of queryWeights.keys()) {
        if (fileTokens.has(tok)) df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
    const N = tokenSets.length;
    if (N === 0) return new Map();

    // IDF 加权查询权重（df=0 的 token 无文件命中，仅稀释分母，与旧版语义一致）
    const idfWeights = new Map<string, number>();
    let totalIdfWeight = 0;
    for (const [tok, w] of queryWeights) {
      const d = df.get(tok) ?? 0;
      const idf = Math.log(1 + N / Math.max(1, d));
      const weight = w * idf;
      idfWeights.set(tok, weight);
      totalIdfWeight += weight;
    }
    if (totalIdfWeight <= 0) return new Map();

    const scores = new Map<string, number>();
    for (const { entry, tokens } of tokenSets) {
      let hitWeight = 0;
      for (const [tok, weight] of idfWeights) {
        if (tokens.has(tok)) hitWeight += weight;
      }
      scores.set(entry.path, hitWeight / totalIdfWeight);
    }
    return scores;
  }

  /** 文件 token 集（路径 + 内容截断分词，LRU 缓存；未索引/不可读返回 null） */
  private getFileTokens(relPath: string): Set<string> | null {
    const key = normalizeRelPath(relPath);
    const cached = this.tokenCache.get(key);
    if (cached !== undefined) return cached;
    if (!this.filePathSet.has(key)) return null;

    const content = this.getFileContent(key);
    if (content === null) return null;

    const text = `${key}\n${content.slice(0, EMBED_CONTENT_CAP)}`;
    const tokens = new Set(tokenizeForEmbedding(text));
    this.tokenCache.set(key, tokens);
    return tokens;
  }

  /**
   * 根据查询组装上下文（符号定义处 → 关键词最优窗口 → 语义召回 → import 图扩展）
   */
  assembleContext(query: string, opts: AssembleOptions = {}): ContextChunk[] {
    if (!this.indexed) return [];
    const maxTokens = opts.maxTokens ?? 20_000;

    const keywords = this.extractKeywords(query);
    const byPath = new Map<string, ContextChunk>();

    // 1) 符号命中：定义处 ±20 行（相关性 100+，远高于其他召回）
    const symbolHits = this.resolveQuerySymbols(query);
    for (const sym of symbolHits) {
      const chunk = this.chunkAroundLine(sym.file, sym.line, 20);
      if (chunk) {
        const existing = byPath.get(chunk.path);
        chunk.relevance = 100;
        if (!existing || existing.relevance < chunk.relevance) byPath.set(chunk.path, chunk);
      }
    }

    // 2) 关键词召回：名称/路径排序 → 内容最优窗口（相关性 ≤50）
    const keywordChunks = this.keywordRecall(keywords);
    for (const chunk of keywordChunks) {
      const existing = byPath.get(chunk.path);
      if (!existing || existing.relevance < chunk.relevance) byPath.set(chunk.path, chunk);
    }

    // 3) V3.4 语义召回：n-gram token 覆盖率匹配（相关性 ≤80，介于符号与关键词之间）
    const semanticChunks = this.semanticRecall(query);
    for (const chunk of semanticChunks) {
      const existing = byPath.get(chunk.path);
      if (!existing || existing.relevance < chunk.relevance) byPath.set(chunk.path, chunk);
    }

    // 4) import 图扩展：从（符号命中 + 关键词/语义命中 + 种子文件）出发 1 跳
    const seeds = [
      ...symbolHits.map((s) => s.file),
      ...keywordChunks.map((c) => c.path),
      ...semanticChunks.map((c) => c.path),
      ...(opts.seedFiles ?? []).map(normalizeRelPath),
    ].filter((p) => this.filePathSet.has(p));
    const related = this.getRelatedFiles([...new Set(seeds)], 1, IMPORT_EXPAND_MAX_FILES);
    for (const file of related) {
      if (byPath.has(file)) continue;
      const chunk = this.chunkAroundLine(file, 1, 60);
      if (chunk) {
        chunk.relevance = 5;
        byPath.set(file, chunk);
      }
    }

    // 4b) V5.19 使用点召回：符号定义文件的 importers（调用方/消费方），
    // 经 re-export 链穿透 barrel（消费者 import 的常是 index.ts 而非源文件）。
    // "改这个函数会影响谁"是高频上下文需求——定义处 + 使用处一并注入。
    // V5.21 分层：直接 importer（hop 1）relevance 20，barrel 间接消费者（hop 2+）15——
    // 越近的使用点越可能是"真正要改的地方"。多符号命中取最短跳。
    const usageDepth = new Map<string, number>();
    for (const sym of symbolHits) {
      for (const [file, hop] of this.importedByWithDepth(sym.file, 3)) {
        if (byPath.has(file)) continue;
        const prev = usageDepth.get(file);
        if (prev === undefined || hop < prev) usageDepth.set(file, hop);
      }
    }
    for (const [file, hop] of usageDepth) {
      const chunk = this.chunkAroundLine(file, 1, 40);
      if (chunk) {
        chunk.relevance = hop === 1 ? 20 : 15; // 使用点分层：均低于定义（100）高于普通依赖扩展（5）
        byPath.set(file, chunk);
      }
    }

    // V5.13 cwd 邻近加权：用户正在看的区域优先（仅影响排序，不改召回集合）
    const cwd = opts.cwd ? normalizeRelPath(opts.cwd) : '';
    if (cwd) {
      const cwdRoot = cwd.includes('/') ? cwd.split('/')[0] : null;
      for (const chunk of byPath.values()) {
        if (chunk.path === cwd || chunk.path.startsWith(cwd + '/')) {
          chunk.relevance += 15; // cwd 子树内
        } else if (cwdRoot && this.multiRoots && chunk.path.startsWith(cwdRoot + '/')) {
          chunk.relevance += 8; // 多根模式下同根
        }
      }
    }

    // V5.24 最近变更加权：正在改的文件几乎总是相关上下文（仅影响排序，与 cwd 加权同一原则）
    if (opts.recentFiles && opts.recentFiles.length > 0) {
      const recentSet = new Set(opts.recentFiles.map(normalizeRelPath));
      for (const chunk of byPath.values()) {
        if (recentSet.has(chunk.path)) chunk.relevance += 10;
      }
    }

    // V5.25 会话活动加权：本会话刚通过工具读过/改过的文件 +12
    // （略高于 git 变更 +10——"刚刚亲手操作"是比"最近一轮提交工作"更近的信号；
    // 与 cwd/git recent 同一原则：只改排序不改召回集合）
    if (this.sessionActivityKeys.length > 0) {
      const activeSet = new Set(this.sessionActivityKeys);
      for (const chunk of byPath.values()) {
        if (activeSet.has(chunk.path)) chunk.relevance += 12;
      }
    }

    // 排序 + 预算裁剪
    const chunks = [...byPath.values()].sort((a, b) => b.relevance - a.relevance);
    let totalTokens = 0;
    const result: ContextChunk[] = [];
    for (const chunk of chunks) {
      const tokens = Math.ceil(chunk.content.length / 4);
      if (totalTokens + tokens > maxTokens) break;
      totalTokens += tokens;
      result.push(chunk);
    }

    return result;
  }

  /** 关键词召回：名称/路径相关性排序 → 内容最优窗口 */
  private keywordRecall(keywords: string[]): ContextChunk[] {
    if (keywords.length === 0) return [];

    // 候选排序（名称/路径匹配 + mtime 加权，不读内容）
    const scored = this.fileIndex
      .map((entry) => ({ entry, score: this.nameRelevance(entry, keywords) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // 大仓库只读 top-N 候选；小仓库全量内容匹配
    const candidates =
      this.fileIndex.length <= FULL_CONTENT_SCAN_MAX_FILES
        ? scored.map((s) => s.entry)
        : scored.slice(0, KEYWORD_CANDIDATE_LIMIT).map((s) => s.entry);

    const chunks: ContextChunk[] = [];
    for (const entry of candidates) {
      const content = this.getFileContent(entry.path);
      if (!content) continue;
      const best = this.findBestChunk(content, keywords, entry.path);
      if (best) {
        best.relevance = Math.min(best.relevance, 50); // 低于符号命中
        chunks.push(best);
      }
    }
    return chunks;
  }

  /** 文件名/路径与关键词的相关性（不读内容） */
  private nameRelevance(entry: FileIndexEntry, keywords: string[]): number {
    let score = 0;
    const name = entry.name.toLowerCase();
    const path = entry.path.toLowerCase();

    for (const kw of keywords) {
      const lowerKw = kw.toLowerCase();
      if (name.includes(lowerKw)) score += 5;
      if (path.includes(lowerKw)) score += 2;
    }

    // 最近修改的文件加权
    const hoursSinceModified = (Date.now() - entry.modifiedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceModified < 24) score *= 1.5;

    return score;
  }

  /** 以某行为中心取 ±range 行的 chunk */
  private chunkAroundLine(relPath: string, line: number, range: number): ContextChunk | null {
    const content = this.getFileContent(relPath);
    if (!content) return null;

    const lines = content.split('\n');
    const start = Math.max(0, line - 1 - range);
    const end = Math.min(lines.length, line - 1 + range + 1);
    if (end <= start) return null;

    return {
      path: normalizeRelPath(relPath),
      content: lines.slice(start, end).join('\n'),
      relevance: 0,
      startLine: start + 1,
      endLine: end,
    };
  }

  // ---- 系统提示词 ----

  /**
   * 构建系统提示词（包含上下文和规则）
   */
  buildSystemPrompt(userQuery: string, basePrompt: string, opts: AssembleOptions = {}): string {
    const parts: string[] = [basePrompt];

    // 加载规则
    for (const rule of this.rules) {
      parts.push(`\n--- ${rule.source === 'project' ? '项目' : '用户'}规则 ---\n${rule.content}`);
    }

    // 组装上下文
    const chunks = this.assembleContext(userQuery, opts);
    if (chunks.length > 0) {
      parts.push('\n--- 相关文件上下文 ---');
      for (const chunk of chunks) {
        parts.push(`\n[${chunk.path}:${chunk.startLine}-${chunk.endLine}] (相关性: ${chunk.relevance.toFixed(2)})`);
        parts.push('```');
        parts.push(chunk.content);
        parts.push('```');
      }
    }

    return parts.join('\n');
  }

  // ---- 记忆系统 ----

  /**
   * 记忆系统：添加记忆
   */
  addMemory(content: string, keywords?: string[]): void {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      content,
      keywords: keywords || this.extractKeywords(content),
      timestamp: new Date().toISOString(),
      weight: 1.0,
    };
    this.memoryStore.push(entry);

    // 限制记忆数量
    if (this.memoryStore.length > 100) {
      this.memoryStore.sort((a, b) => b.weight - a.weight);
      this.memoryStore = this.memoryStore.slice(0, 100);
    }
  }

  /**
   * 记忆系统：检索相关记忆
   */
  retrieveMemories(query: string, limit = 5): MemoryEntry[] {
    const keywords = this.extractKeywords(query);

    const scored = this.memoryStore.map((m) => {
      let score = 0;
      for (const kw of keywords) {
        if (m.content.toLowerCase().includes(kw.toLowerCase())) score += 1;
        if (m.keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))) score += 2;
      }
      // 时间衰减（越新的记忆权重越高）
      const age = Date.now() - new Date(m.timestamp).getTime();
      const timeDecay = Math.max(0.1, 1 - age / (7 * 24 * 60 * 60 * 1000)); // 7天衰减
      score *= timeDecay;

      return { entry: m, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /**
   * 生成对话摘要并存入记忆
   */
  summarizeConversation(userMsg: string, assistantMsg: string): void {
    const summary = `用户: ${userMsg.substring(0, 200)}\n助手: ${assistantMsg.substring(0, 200)}`;
    const keywords = this.extractKeywords(`${userMsg} ${assistantMsg}`);
    this.addMemory(summary, keywords);
  }

  // ---- 规则加载 ----

  private loadRules(): void {
    this.rules = [];

    // 项目级 CODEX.md
    const projectRulePath = join(this.workingDir, 'CODEX.md');
    if (existsSync(projectRulePath)) {
      try {
        this.rules.push({
          content: readFileSync(projectRulePath, 'utf-8'),
          source: 'project',
          path: projectRulePath,
        });
      } catch {
        // 忽略
      }
    }

    // 用户级规则
    const userRulePath = join(getConfigDir(), 'CODEX.md');
    if (existsSync(userRulePath)) {
      try {
        this.rules.push({
          content: readFileSync(userRulePath, 'utf-8'),
          source: 'user',
          path: userRulePath,
        });
      } catch {
        // 忽略
      }
    }
  }

  // ---- V3.4 索引持久化（V5.16 格式 v2） ----

  /**
   * V5.16 别名清单指纹：各根的 package.json / pyproject.toml / tsconfig.json
   * （别名表的全部来源）的 size+mtime。清单变化 → 别名表变化 → imports 种子弃用。
   */
  private manifestFingerprints(): Array<{ path: string; size: number; mtime: number }> {
    const roots = this.multiRoots
      ? this.multiRoots.map((r) => ({ name: r.name, abs: r.abs }))
      : [{ name: '', abs: this.workingDir }];
    const fps: Array<{ path: string; size: number; mtime: number }> = [];
    for (const root of roots) {
      for (const manifest of ['package.json', 'pyproject.toml', 'tsconfig.json']) {
        try {
          const st = statSync(join(root.abs, manifest));
          fps.push({ path: `${root.name}/${manifest}`, size: st.size, mtime: st.mtimeMs });
        } catch {
          // 清单不存在 → 无指纹条目（存在性本身也是指纹的一部分：缺席与在场不同）
        }
      }
    }
    return fps.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /**
   * V5.16 工作区结构指纹：全部键空间路径（排序后）+ 别名清单指纹 + 解析器版本的哈希。
   * imports 解析结果依赖解析时刻的文件集、别名表与解析器逻辑——任一变化此指纹即变，
   * 回载时用于整体门控 persistedImports（符号种子不受影响：只依赖自身内容）。
   * V5.18：纳入 IMPORT_RESOLVER_VERSION——解析器升级后旧缓存种子整体失效。
   */
  private structureFingerprint(): string {
    const paths = this.fileIndex.map((e) => e.path).sort();
    const manifests = this.manifestFingerprints().map((m) => `${m.path}:${m.size}:${m.mtime}`);
    return fnv1a(`rv${IMPORT_RESOLVER_VERSION}##` + paths.join('|') + '##' + manifests.join('|')).toString(36);
  }

  /** 持久化文件条目（符号/import 省略冗余字段，回载时回填） */
  private serializeIndex(): string {
    const byFile = new Map<
      string,
      { size: number; mtime: number; symbols: SymbolEntry[]; imports: string[] }
    >();
    const entryByPath = new Map(this.fileIndex.map((e) => [e.path, e]));

    if (this.symbolIndex) {
      for (const list of this.symbolIndex.values()) {
        for (const sym of list) {
          const entry = entryByPath.get(sym.file);
          if (!entry) continue;
          let slot = byFile.get(sym.file);
          if (!slot) {
            slot = { size: entry.size, mtime: entry.modifiedAt.getTime(), symbols: [], imports: [] };
            byFile.set(sym.file, slot);
          }
          if (slot.symbols.length < MAX_PERSIST_SYMBOLS_PER_FILE) {
            slot.symbols.push({ name: sym.name, kind: sym.kind, file: sym.file, line: sym.line });
          }
        }
      }
    }

    // V5.16 imports：本次会话解析结果（LRU）∪ 历史种子（仍存活于当前文件索引的）。
    // 空数组也持久化——区分"无仓库内 import"与"未解析"，前者回载免读盘。
    const importSources: Array<[string, string[]]> = [
      ...this.importCache.entries(),
      ...this.persistedImports.entries(),
    ];
    const importSeen = new Set<string>();
    for (const [path, imports] of importSources) {
      const entry = entryByPath.get(path);
      if (!entry || importSeen.has(path)) continue;
      importSeen.add(path);
      let slot = byFile.get(path);
      if (!slot) {
        slot = { size: entry.size, mtime: entry.modifiedAt.getTime(), symbols: [], imports: [] };
        byFile.set(path, slot);
      }
      slot.imports = imports.slice(0, MAX_PERSIST_IMPORTS_PER_FILE);
    }

    const roots = this.multiRoots
      ? this.multiRoots.map((r) => ({ name: r.name, abs: r.abs }))
      : [{ name: '', abs: this.workingDir }];
    const payload = {
      version: 2 as const,
      workingDir: this.persistKey,
      savedAt: new Date().toISOString(),
      // V5.16 多根/别名元数据：根清单 + 别名清单指纹 + 结构指纹（imports 种子门控）
      roots,
      manifests: this.manifestFingerprints(),
      structureHash: this.structureFingerprint(),
      files: [...byFile.entries()].slice(0, MAX_PERSIST_FILES).map(([path, s]) => ({
        path,
        size: s.size,
        mtime: s.mtime,
        symbols: s.symbols.map((sym) => ({ name: sym.name, kind: sym.kind, line: sym.line })),
        imports: s.imports,
      })),
    };
    return JSON.stringify(payload);
  }

  private cacheFilePath(): string | null {
    if (!this.persistKey) return null;
    const h = fnv1a(normalize(this.persistKey)).toString(36);
    return join(getConfigDir(), 'cache', 'context', `${h}.json`);
  }

  /**
   * 加载持久化符号/import 缓存。
   * - 符号种子（v1/v2 通用）：逐文件校验 size+mtime 指纹，不匹配即弃。
   * - import 种子（仅 v2）：额外要求工作区结构指纹一致（路径集 + 别名清单
   *   未变）——imports 依赖解析时刻的文件集与别名表，结构变化即整体弃用
   *   （宁重读勿陈旧：新增文件可能让原本未解析的 import 变为可解析）。
   * - v1 缓存仍可加载（无 imports 字段，行为与旧版一致）；损坏/不可读整体弃用。
   */
  private loadPersistedIndex(): void {
    const cacheFile = this.cacheFilePath();
    if (!cacheFile) return;

    try {
      if (!existsSync(cacheFile)) return;
      const raw = readFileSync(cacheFile, 'utf-8');
      const data = JSON.parse(raw) as {
        version: number;
        workingDir: string;
        savedAt?: unknown;
        structureHash?: string;
        files: Array<{
          path: string;
          size: number;
          mtime: number;
          symbols: Array<{ name: string; kind: SymbolKind; line: number }>;
          imports?: unknown;
        }>;
      };
      if ((data.version !== 1 && data.version !== 2) || data.workingDir !== this.persistKey) return;

      // V5.16 imports 种子门控：结构指纹一致才启用（v1 无此字段 → 恒不启用）
      const structureOk =
        data.version === 2 && typeof data.structureHash === 'string'
          ? data.structureHash === this.structureFingerprint()
          : false;

      // V5.18 记录缓存诊断（context stats 展示；savedAt 可选字段容错）
      this.persistedInfo = {
        version: data.version,
        structureOk,
        savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
      };

      const current = new Map(this.fileIndex.map((e) => [e.path, e]));
      for (const f of data.files ?? []) {
        const entry = current.get(f.path);
        // 双指纹校验：size 与 mtime 都必须一致
        if (!entry || entry.size !== f.size || entry.modifiedAt.getTime() !== f.mtime) continue;
        if (Array.isArray(f.symbols) && f.symbols.length > 0) {
          this.persistedSymbols.set(
            f.path,
            f.symbols.map((s) => ({ name: s.name, kind: s.kind, file: f.path, line: s.line })),
          );
        }
        if (structureOk && Array.isArray(f.imports)) {
          this.persistedImports.set(f.path, f.imports.filter((p) => typeof p === 'string'));
        }
      }
    } catch {
      // 损坏/不可读 → 整体弃用，静默重建
    }
  }

  /** 异步串行落盘（防重入；执行时序列化最新状态） */
  private queueSavePersistedIndex(): void {
    const cacheFile = this.cacheFilePath();
    if (!cacheFile) return;
    if (this.savePending) return;
    this.savePending = true;

    this.saveChain = this.saveChain.then(async () => {
      this.savePending = false;
      try {
        mkdirSync(join(getConfigDir(), 'cache', 'context'), { recursive: true });
        await writeFile(cacheFile, this.serializeIndex(), 'utf-8');
      } catch {
        // 写盘失败静默（磁盘满/无权限）——缓存是优化不是依赖
      }
    });
  }

  /** 等待排队中的落盘完成（测试用） */
  async flushIndexCache(): Promise<void> {
    await this.saveChain;
  }

  // ---- 工具方法 ----

  /**
   * 提取关键词
   */
  private extractKeywords(text: string): string[] {
    // 简单分词 + 去停用词
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'it', 'this', 'that', '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
    const words = text.toLowerCase()
      .replace(/[^a-zA-Z\u4e00-\u9fa5_$]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

    return [...new Set(words)].slice(0, 10);
  }

  /**
   * 找到文件中最相关的代码段（30 行滑动窗口）
   */
  private findBestChunk(content: string, keywords: string[], path: string): ContextChunk | null {
    const lines = content.split('\n');
    const lineScores: number[] = new Array(lines.length).fill(0);

    for (const kw of keywords) {
      const lowerKw = kw.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerKw)) {
          lineScores[i] += 1;
        }
      }
    }

    // 找到得分最高的窗口（V3.2 修复：短文件 < 窗口大小时也能命中）
    const WINDOW = 30;
    let bestStart = 0;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      let windowScore = 0;
      for (let j = i; j < i + WINDOW && j < lines.length; j++) {
        windowScore += lineScores[j];
      }
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
      }
      // 尾部窗口已覆盖全文件时提前结束
      if (i + WINDOW >= lines.length) break;
    }

    if (bestScore === 0) return null;

    const endLine = Math.min(bestStart + WINDOW, lines.length);
    const chunk = lines.slice(bestStart, endLine).join('\n');

    return {
      path: normalizeRelPath(path),
      content: chunk,
      relevance: bestScore,
      startLine: bestStart + 1,
      endLine: endLine,
    };
  }

  /**
   * 模糊搜索文件
   */
  fuzzySearchFile(query: string): string[] {
    return this.fileTrie.fuzzySearch(query);
  }

  /**
   * V5.20 四路召回分解（`codex context query` 数据源）。
   * 与 assembleContext 相同的召回链路，但不合并——逐路展示命中明细，
   * 用于调试"为什么召回/没召回某个文件"。
   */
  debugRecall(query: string, opts: AssembleOptions = {}): RecallBreakdown {
    const keywords = this.extractKeywords(query);
    const symbols = this.resolveQuerySymbols(query);
    const semantic = this.semanticRecall(query);
    const keywordChunks = this.keywordRecall(keywords);

    const seeds = [
      ...symbols.map((s) => s.file),
      ...keywordChunks.map((c) => c.path),
      ...semantic.map((c) => c.path),
      ...(opts.seedFiles ?? []).map(normalizeRelPath),
    ].filter((p) => this.filePathSet.has(p));
    const related = this.getRelatedFiles([...new Set(seeds)], 1, IMPORT_EXPAND_MAX_FILES);

    // V5.19 使用点：符号定义文件的 importers（re-export 链穿透 barrel）
    const usageSites = [...new Set(symbols.flatMap((s) => this.getImportedByExpanded(s.file)))];

    return {
      keywords,
      symbols,
      semantic,
      keywordsHits: keywordChunks,
      related,
      usageSites,
      assembled: this.assembleContext(query, opts),
    };
  }

  /**
   * V5.25 记录会话活动文件（绝对路径；Agent 工具 read/write/edit 的挂点）。
   * 越界 / 未索引路径静默忽略；重复操作移到队尾（保"最近"语义）；
   * FIFO 上限 50，超出淘汰最旧活动。返回是否成功入队。
   */
  recordSessionActivity(absPath: string): boolean {
    const key = this.absToKey(absPath);
    if (!key) return false;
    const i = this.sessionActivityKeys.indexOf(key);
    if (i !== -1) this.sessionActivityKeys.splice(i, 1);
    this.sessionActivityKeys.push(key);
    if (this.sessionActivityKeys.length > SESSION_ACTIVITY_MAX_FILES) {
      this.sessionActivityKeys.splice(0, this.sessionActivityKeys.length - SESSION_ACTIVITY_MAX_FILES);
    }
    return true;
  }

  /** V5.25 当前会话活动文件（键空间路径，最近操作在后；快照拷贝） */
  getSessionActivity(): string[] {
    return [...this.sessionActivityKeys];
  }

  /** V5.25 清空会话活动（新会话 / 测试隔离用） */
  clearSessionActivity(): void {
    this.sessionActivityKeys = [];
  }

  /**
   * V5.23 单文件召回诊断（`codex context why` 数据源）：
   * 对指定文件逐路检查四路召回的贡献——命中哪几路、每路的得分细节、
   * 最终是否进入组装结果、未召回的具体原因（阈值差多少 / 图上多远）。
   */
  explainRecall(query: string, file: string, opts: AssembleOptions = {}): FileRecallExplanation {
    const key = normalizeRelPath(file);
    const indexed = this.filePathSet.has(key);
    const reasons: string[] = [];

    if (!indexed) {
      return {
        file: key,
        indexed: false,
        symbolDefs: [],
        semanticCoverage: null,
        semanticThreshold: SEMANTIC_THRESHOLD,
        keywordScore: null,
        importsSeeds: [],
        importedBySeeds: [],
        usageOf: [],
        assembledChunk: null,
        reasons: ['文件不在索引内（路径拼错 / 被 IGNORE 忽略 / 非 tracked 文件）'],
      };
    }

    // ---- 逐路检查（与 assembleContext 相同链路） ----
    const symbols = this.resolveQuerySymbols(query);
    const symbolDefs = symbols.filter((s) => s.file === key);

    const semanticScore = this.semanticScores(query).get(key) ?? null;

    const keywords = this.extractKeywords(query);
    const keywordChunk = this.keywordRecall(keywords).find((c) => c.path === key) ?? null;

    // import 图路：种子集合（符号 + 关键词 + 语义 + 显式种子）
    const keywordChunks = this.keywordRecall(keywords);
    const semantic = this.semanticRecall(query);
    const seedSet = new Set(
      [
        ...symbols.map((s) => s.file),
        ...keywordChunks.map((c) => c.path),
        ...semantic.map((c) => c.path),
        ...(opts.seedFiles ?? []).map(normalizeRelPath),
      ].filter((p) => this.filePathSet.has(p)),
    );
    const importsSeeds = this.parseImports(key).filter((dep) => seedSet.has(dep));
    const importedBySeeds = this.getImportedBy(key).filter((imp) => seedSet.has(imp));

    // 使用点路：此文件是哪些命中符号定义文件的 hop-N importer
    const usageOf: Array<{ defFile: string; hop: number }> = [];
    for (const sym of symbols) {
      const layered = this.getImportedByLayered(sym.file).find((x) => x.file === key);
      if (layered) usageOf.push({ defFile: sym.file, hop: layered.hop });
    }

    // 最终组装结果
    const assembled = this.assembleContext(query, opts);
    const assembledChunk = assembled.find((c) => c.path === key) ?? null;

    // ---- 人读诊断 ----
    const hitWays: string[] = [];
    if (symbolDefs.length > 0) {
      hitWays.push(`符号路（${symbolDefs.map((s) => s.name).join(', ')}，relevance 100）`);
    }
    if (semanticScore !== null && semanticScore > SEMANTIC_THRESHOLD) {
      hitWays.push(`语义路（覆盖率 ${(semanticScore * 100).toFixed(0)}% > 阈值）`);
    }
    if (keywordChunk) {
      hitWays.push(`关键词路（窗口得分 ${keywordChunk.relevance}）`);
    }
    if (importsSeeds.length > 0 || importedBySeeds.length > 0) {
      hitWays.push(`import 图路（${importsSeeds.length + importedBySeeds.length} 条种子邻接边）`);
    }
    if (usageOf.length > 0) {
      hitWays.push(`使用点路（${usageOf.map((u) => `${u.defFile} 的 hop-${u.hop} importer`).join('; ')}）`);
    }

    if (assembledChunk) {
      reasons.push(
        hitWays.length > 0
          ? `已召回（relevance ${assembledChunk.relevance}）：${hitWays.join('；')}`
          : `已召回（relevance ${assembledChunk.relevance}）`,
      );
    } else {
      // 未进入最终结果：逐路给出未命中原因
      const miss: string[] = [];
      if (symbolDefs.length === 0) {
        miss.push('符号路未命中（查询 token 未匹配此文件符号）');
      }
      if (semanticScore === null) {
        miss.push('语义路未入候选池（大仓未进名称相关性 top-30）');
      } else if (semanticScore <= SEMANTIC_THRESHOLD) {
        miss.push(
          `语义路未过阈值（覆盖率 ${(semanticScore * 100).toFixed(1)}% ≤ ${(SEMANTIC_THRESHOLD * 100).toFixed(0)}%）`,
        );
      }
      if (!keywordChunk) {
        miss.push(
          keywords.length === 0
            ? '关键词路无关键词可查'
            : `关键词路未命中（名称不含关键词且内容无窗口命中）`,
        );
      }
      if (importsSeeds.length === 0 && importedBySeeds.length === 0) {
        miss.push('import 图路：与召回种子无直接邻接边（多跳可达不被 1 跳扩展覆盖）');
      }
      if (usageOf.length === 0) {
        miss.push('使用点路：不是任何命中符号定义文件的 importer');
      }
      // 四路有命中但没进组装 → 排序/预算挤出
      if (miss.length < 5) {
        miss.push('四路有命中但被排序/预算裁剪挤出最终组装（降低 token 预算占用或提高相关性）');
      }
      reasons.push(...miss);
    }

    return {
      file: key,
      indexed: true,
      symbolDefs,
      semanticCoverage: semanticScore,
      semanticThreshold: SEMANTIC_THRESHOLD,
      keywordScore: keywordChunk ? keywordChunk.relevance : 0,
      importsSeeds,
      importedBySeeds,
      usageOf,
      assembledChunk,
      reasons,
    };
  }

  /**
   * 获取文件索引统计
   */
  getStats(): { fileCount: number; memoryCount: number; ruleCount: number; symbolCount: number; lazy: boolean } {
    return {
      fileCount: this.fileIndex.length,
      memoryCount: this.memoryStore.length,
      ruleCount: this.rules.length,
      symbolCount: this.symbolIndex
        ? [...this.symbolIndex.values()].reduce((n, list) => n + list.length, 0)
        : 0,
      lazy: this.fileIndex.length > FULL_CONTENT_SCAN_MAX_FILES,
    };
  }

  /**
   * V5.18 索引体检报告（`codex context stats` 数据源）。
   * 会触发符号索引构建与全量 import 解析（用户显式调用的诊断命令，可接受全量成本）；
   * 边界与构建一致：符号上限 SYMBOL_INDEX_MAX_FILES、单文件 512KB。
   */
  getContextReport(): ContextReport {
    // 符号索引（惰性触发，含持久化种子回填）
    const index = this.buildSymbolIndex();
    let symbolCount = 0;
    const symbolsByFile = new Map<string, number>();
    for (const list of index.values()) {
      symbolCount += list.length;
      for (const sym of list) {
        symbolsByFile.set(sym.file, (symbolsByFile.get(sym.file) ?? 0) + 1);
      }
    }

    // import 边（与符号索引同一文件集：源码扩展名 + 大小上限内）
    let importEdgeCount = 0;
    let sourceFileCount = 0;
    let scanned = 0;
    for (const entry of this.fileIndex) {
      if (scanned >= SYMBOL_INDEX_MAX_FILES) break;
      if (!SOURCE_EXTS.has(extOf(entry.path))) continue;
      if (entry.size > SYMBOL_FILE_MAX_BYTES) continue;
      scanned++;
      sourceFileCount++;
      importEdgeCount += this.parseImports(entry.path).length;
    }

    const roots = this.multiRoots
      ? this.multiRoots.map((r) => ({
          name: r.name,
          abs: r.abs,
          fileCount: this.fileIndex.filter((e) => e.path.startsWith(`${r.name}/`)).length,
        }))
      : [{ name: basename(this.workingDir) || '.', abs: this.workingDir, fileCount: this.fileIndex.length }];

    const topFiles = [...symbolsByFile.entries()]
      .map(([path, symbols]) => ({ path, symbols, size: this.fileIndex.find((e) => e.path === path)?.size ?? 0 }))
      .sort((a, b) => b.symbols - a.symbols)
      .slice(0, 5);

    // V5.27 加权信号：git 最近变更（主根采集，与 agent-loop 接线一致）→ 键空间（仅索引内）
    const primaryRoot = this.multiRoots ? this.multiRoots[0].abs : this.workingDir;
    const gitRecentFiles = collectGitChangedFiles(primaryRoot)
      .map((abs) => this.absToKey(abs))
      .filter((k): k is string => !!k);

    return {
      mode: this.multiRoots ? 'multi' : 'single',
      roots,
      fileCount: this.fileIndex.length,
      sourceFileCount,
      symbolCount,
      importEdgeCount,
      packageAliasCount: this.packageAliases.size,
      pathAliasCount: this.pathAliases.size,
      ruleCount: this.rules.length,
      memoryCount: this.memoryStore.length,
      lazy: this.fileIndex.length > FULL_CONTENT_SCAN_MAX_FILES,
      persisted: this.persistedInfo
        ? {
            ...this.persistedInfo,
            symbolSeeds: this.persistedSymbols.size,
            importSeeds: this.persistedImports.size,
            cacheFile: this.cacheFilePath(),
          }
        : null,
      topFiles,
      signals: {
        weights: { cwdSubtree: 15, cwdSameRoot: 8, gitRecent: 10, sessionActivity: 12 },
        gitRecentFiles,
        sessionActivityFiles: this.getSessionActivity(),
      },
    };
  }
}

// ---- 模块级工具函数 ----

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function extOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx) : '';
}

/** 提取查询中的标识符 token（用于符号匹配） */
function extractIdentifierTokens(query: string): string[] {
  const tokens = query.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return [...new Set(tokens)].filter((t) => t.length >= 2);
}

// ---- V5.24 git 最近变更采集 ----

/**
 * V5.24 采集 git 工作区最近变更文件（绝对路径，去重）。
 * 数据源：`git status --porcelain`（暂存/未暂存/未跟踪）∪ `git diff --name-only HEAD`（与最近提交的差）。
 * 非 git 仓 / git 不可用 → 空数组（调用方静默降级，绝不阻断召回）。
 * 超时护栏：3 秒——巨型仓的 status 不应拖慢上下文组装。
 */
export function collectGitChangedFiles(rootDir: string): string[] {
  const run = (args: string[]): string => {
    try {
      return execSync(`git ${args.join(' ')}`, {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  };

  const paths = new Set<string>();

  // porcelain：XY 路径（含 rename 的 ORIG → NEW 形态，取箭头右侧）
  for (const line of run(['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    const renamed = pathPart.match(/^"?.*? -> (.*?)"?$/);
    const p = (renamed ? renamed[1] : pathPart).replace(/^"|"$/g, '');
    if (p) paths.add(p);
  }

  // 与最近提交的差（最近一轮工作的信号）
  for (const p of run(['diff', '--name-only', 'HEAD']).split('\n')) {
    if (p.trim()) paths.add(p.trim());
  }

  return [...paths].map((p) => resolve(rootDir, p));
}

// ---- V3.4 模块级共享单例 ----

let sharedEngine: ContextEngine | null = null;
let sharedEngineDir = '';

/**
 * 获取进程级共享引擎实例（按 workingDir 缓存）。
 * agent-loop 与 IDE 聊天 @codebase 共享同一索引——内核唯一原则，
 * 杜绝双份内存与双份扫描。失败返回 null（调用方静默降级）。
 * V5.0：支持多根（string[]，键空间统一为 rootName/rel）。
 */
export function getSharedContextEngine(workingDir: string | string[]): ContextEngine | null {
  try {
    const cacheKey = Array.isArray(workingDir)
      ? workingDir.map((d) => resolve(d)).join('|')
      : resolve(workingDir);
    if (!sharedEngine || sharedEngineDir !== cacheKey) {
      sharedEngine = new ContextEngine();
      // 扫描是轻量的（stat-only 零内容读取）
      void sharedEngine.index(workingDir);
      sharedEngineDir = cacheKey;
    }
    return sharedEngine;
  } catch {
    return null;
  }
}

/** 重置共享单例（测试用） */
export function resetSharedContextEngine(): void {
  sharedEngine = null;
  sharedEngineDir = '';
}
