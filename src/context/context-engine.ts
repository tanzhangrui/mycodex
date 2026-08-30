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
import { join, relative, resolve, dirname, normalize } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { isSensitivePath } from '../core/privacy-guard.js';

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
 * 从源码提取相对 import 说明符（未解析）
 */
function extractImportSpecifiers(content: string, lang: 'ts' | 'py'): string[] {
  const specs: string[] = [];
  const res = lang === 'py' ? PY_IMPORT_RES : TS_IMPORT_RES;
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (lang === 'ts') {
        // TS/JS：仅相对说明符（./ 或 ../）
        if (spec.startsWith('./') || spec.startsWith('../')) specs.push(spec);
      } else {
        // Python：`from .mod import x` / `from ..pkg import y`
        if (spec.startsWith('.')) specs.push(spec);
      }
    }
  }
  return [...new Set(specs)];
}

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
}

// ---- 上下文引擎 ----

export class ContextEngine {
  private workingDir: string = '';
  /** V5.0 多根工作区（null = 单根模式，键空间无前缀，完全向后兼容） */
  private multiRoots: import('../core/workspace.js').WorkspaceRoot[] | null = null;
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
  /** 全局符号索引（name 小写 → 符号列表），惰性构建 */
  private symbolIndex: Map<string, SymbolEntry[]> | null = null;
  private memoryStore: MemoryEntry[] = [];
  private rules: CodexRule[] = [];
  private indexed = false;

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
      const { WorkspaceResolver } = await import('../core/workspace.js');
      const resolver = new WorkspaceResolver(workingDir);
      this.multiRoots = [...resolver.rootList];
      this.workingDir = resolver.primaryRoot;
      this.persistKey = this.multiRoots.map((r) => r.abs).join('|');
    } else {
      this.multiRoots = null;
      this.workingDir = resolve(Array.isArray(workingDir) ? workingDir[0] : workingDir);
      this.persistKey = this.workingDir;
    }

    this.fileCache = new LRUCache<string, string>(LRU_SIZE);
    this.importCache = new LRUCache<string, string[]>(LRU_SIZE);
    this.symbolCache = new LRUCache<string, SymbolEntry[]>(LRU_SIZE);
    this.tokenCache = new LRUCache<string, Set<string>>(LRU_SIZE);
    this.persistedSymbols = new Map();
    this.symbolIndex = null;

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
  }

  /** 失效单文件的全部派生缓存 */
  private invalidateFile(relPath: string): void {
    this.fileCache.delete(relPath);
    this.importCache.delete(relPath);
    this.symbolCache.delete(relPath);
    this.tokenCache.delete(relPath);
    this.persistedSymbols.delete(relPath);
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

    const lang = this.langOf(key);
    if (!lang) return [];

    const content = this.getFileContent(key);
    if (!content) return [];

    const resolved: string[] = [];
    for (const spec of extractImportSpecifiers(content, lang)) {
      const target = this.resolveImport(key, spec, lang);
      if (target && target !== key) resolved.push(target);
    }
    const unique = [...new Set(resolved)];
    this.importCache.set(key, unique);
    return unique;
  }

  /**
   * 将相对 import 说明符解析为索引内的 relPath（扩展名/索引文件探测）
   */
  private resolveImport(fromFile: string, spec: string, lang: 'ts' | 'py'): string | null {
    const base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, '/');

    for (const ext of RESOLVE_EXTS) {
      const candidate = base + ext;
      if (this.filePathSet.has(candidate)) return candidate;
    }
    if (lang !== 'py') {
      for (const idx of RESOLVE_INDEX_FILES) {
        const candidate = `${base}/${idx}`;
        if (this.filePathSet.has(candidate)) return candidate;
      }
    }
    return null;
  }

  /**
   * import 图 BFS：从种子文件出发收集相关文件（直接依赖优先）
   */
  getRelatedFiles(seedFiles: string[], maxHops = 1, maxFiles = IMPORT_EXPAND_MAX_FILES): string[] {
    if (!this.indexed) return [];

    const results: string[] = [];
    const visited = new Set(seedFiles.map(normalizeRelPath));
    let frontier = [...visited];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const dep of this.parseImports(file)) {
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

  // ---- 四路召回融合 ----

  /**
   * V3.4 语义召回：查询 token 覆盖率匹配（无哈希碰撞、可预测、可调试）。
   * 覆盖率 = 文件命中的查询 token 权重 / 查询 token 总权重，
   * 排序取 top-K。轻量语义（模糊词法），兜底符号/关键词都未命中的口语化查询。
   */
  semanticRecall(query: string, topK = SEMANTIC_TOP_K): ContextChunk[] {
    if (!this.indexed) return [];

    const queryTokens = tokenizeForEmbedding(query);
    if (queryTokens.length === 0) return [];

    // 查询 token 权重（类 TF：越靠前的 token 越重要）
    const queryWeights = new Map<string, number>();
    queryTokens.forEach((tok, idx) => {
      const weight = 1 / Math.log2(idx + 2);
      queryWeights.set(tok, (queryWeights.get(tok) || 0) + weight);
    });
    const totalQueryWeight = [...queryWeights.values()].reduce((a, b) => a + b, 0);
    if (totalQueryWeight === 0) return [];

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

    const scored: Array<{ entry: FileIndexEntry; coverage: number }> = [];
    for (const entry of candidates) {
      const fileTokens = this.getFileTokens(entry.path);
      if (!fileTokens) continue;

      let hitWeight = 0;
      for (const [tok, weight] of queryWeights) {
        if (fileTokens.has(tok)) hitWeight += weight;
      }
      const coverage = hitWeight / totalQueryWeight;
      if (coverage > SEMANTIC_THRESHOLD) scored.push({ entry, coverage });
    }
    scored.sort((a, b) => b.coverage - a.coverage);

    const chunks: ContextChunk[] = [];
    for (const { entry, coverage } of scored.slice(0, topK)) {
      const content = this.getFileContent(entry.path);
      if (!content) continue;
      // 窗口优先关键词命中处，否则文件头
      const chunk = this.findBestChunk(content, keywords, entry.path) ?? this.chunkAroundLine(entry.path, 1, 60);
      if (chunk) {
        // 语义相关性上限 80：低于符号精确命中（100），高于关键词（≤50）
        chunk.relevance = Math.min(80, Math.max(1, Math.round(coverage * 100)));
        chunks.push(chunk);
      }
    }
    return chunks;
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

  // ---- V3.4 索引持久化 ----

  /** 持久化文件条目（符号省略 file 字段，回载时回填） */
  private serializeIndex(): string {
    const byFile = new Map<string, { size: number; mtime: number; symbols: SymbolEntry[] }>();
    const entryByPath = new Map(this.fileIndex.map((e) => [e.path, e]));

    if (this.symbolIndex) {
      for (const list of this.symbolIndex.values()) {
        for (const sym of list) {
          const entry = entryByPath.get(sym.file);
          if (!entry) continue;
          let slot = byFile.get(sym.file);
          if (!slot) {
            slot = { size: entry.size, mtime: entry.modifiedAt.getTime(), symbols: [] };
            byFile.set(sym.file, slot);
          }
          if (slot.symbols.length < MAX_PERSIST_SYMBOLS_PER_FILE) {
            slot.symbols.push({ name: sym.name, kind: sym.kind, file: sym.file, line: sym.line });
          }
        }
      }
    }

    const payload = {
      version: 1 as const,
      workingDir: this.persistKey,
      savedAt: new Date().toISOString(),
      files: [...byFile.entries()].slice(0, MAX_PERSIST_FILES).map(([path, s]) => ({
        path,
        size: s.size,
        mtime: s.mtime,
        symbols: s.symbols.map((sym) => ({ name: sym.name, kind: sym.kind, line: sym.line })),
      })),
    };
    return JSON.stringify(payload);
  }

  private cacheFilePath(): string | null {
    if (!this.persistKey) return null;
    const h = fnv1a(normalize(this.persistKey)).toString(36);
    return join(getConfigDir(), 'cache', 'context', `${h}.json`);
  }

  /** 加载持久化符号缓存：逐文件校验 size+mtime 指纹，不匹配即弃 */
  private loadPersistedIndex(): void {
    const cacheFile = this.cacheFilePath();
    if (!cacheFile) return;

    try {
      if (!existsSync(cacheFile)) return;
      const raw = readFileSync(cacheFile, 'utf-8');
      const data = JSON.parse(raw) as {
        version: number;
        workingDir: string;
        files: Array<{ path: string; size: number; mtime: number; symbols: Array<{ name: string; kind: SymbolKind; line: number }> }>;
      };
      if (data.version !== 1 || data.workingDir !== this.persistKey) return;

      const current = new Map(this.fileIndex.map((e) => [e.path, e]));
      for (const f of data.files ?? []) {
        const entry = current.get(f.path);
        // 双指纹校验：size 与 mtime 都必须一致
        if (!entry || entry.size !== f.size || entry.modifiedAt.getTime() !== f.mtime) continue;
        if (!Array.isArray(f.symbols) || f.symbols.length === 0) continue;

        this.persistedSymbols.set(
          f.path,
          f.symbols.map((s) => ({ name: s.name, kind: s.kind, file: f.path, line: s.line })),
        );
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
