/**
 * @deprecated 此模块预留用于 V2.0 的大规模项目上下文检索（>500 文件）。
 * 当前 V1.4 由 agent-loop 内置的 CODEX.md 加载覆盖。
 *
 * 模块包含：
 * - Trie 树文件索引
 * - BM25 上下文组装
 * - 基于规则的记忆系统
 * - CODEX.md 规则文件加载
 *
 * 当项目规模超过 500 个文件时，启用此模块以获得更好的上下文检索精度。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { getConfigDir } from '../config/config.js';

// ---- 类型 ----

export interface FileIndexEntry {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
  /** 文件摘要（前 500 字符） */
  preview: string;
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

// ---- 文件索引 ----

/**
 * Trie 节点
 */
class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isFile = false;
  path: string = '';
}

/**
 * 文件路径 Trie
 */
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
}

// ---- 上下文引擎 ----

export class ContextEngine {
  private workingDir: string = '';
  private fileIndex: FileIndexEntry[] = [];
  private fileTrie = new FileTrie();
  private fileCache = new LRUCache<string, string>(200);
  private memoryStore: MemoryEntry[] = [];
  private rules: CodexRule[] = [];
  private indexed = false;

  /**
   * 扫描项目目录，构建文件索引
   */
  async index(workingDir: string): Promise<void> {
    this.workingDir = resolve(workingDir);
    this.fileIndex = [];
    this.fileTrie = new FileTrie();
    this.fileCache = new LRUCache(200);

    this.scanDirectory(this.workingDir);
    this.indexed = true;

    // 加载规则文件
    this.loadRules();
  }

  private scanDirectory(dir: string, depth = 0): void {
    if (depth > 10) return;

    const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage']);

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') && entry !== '.env') continue;
        if (ignored.has(entry)) continue;

        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            this.scanDirectory(fullPath, depth + 1);
          } else if (stat.isFile() && stat.size < 1_048_576) {
            const relPath = relative(this.workingDir, fullPath);
            const isText = this.isTextFile(entry);

            if (isText) {
              try {
                const content = readFileSync(fullPath, 'utf-8');
                const preview = content.substring(0, 500);
                this.fileIndex.push({
                  path: relPath,
                  name: entry,
                  size: stat.size,
                  modifiedAt: stat.mtime,
                  preview,
                });
                this.fileTrie.insert(relPath);
              } catch {
                // 跳过
              }
            }
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
    const textExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.html', '.css', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.yaml', '.yml', '.toml', '.xml', '.sql', '.sh', '.env', '.gitignore']);
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
    return textExts.has(ext) || textExts.has(filename);
  }

  /**
   * 根据查询组装上下文
   */
  assembleContext(query: string, maxTokens: number = 20_000): ContextChunk[] {
    if (!this.indexed) return [];

    const keywords = this.extractKeywords(query);
    const chunks: ContextChunk[] = [];

    // 对每个文件计算相关性
    for (const entry of this.fileIndex) {
      const relevance = this.calculateRelevance(entry, keywords);
      if (relevance > 0) {
        const content = this.getFileContent(entry.path);
        if (content) {
          // 找到最相关的代码段
          const bestChunk = this.findBestChunk(content, keywords, entry.path);
          if (bestChunk) {
            bestChunk.relevance = relevance;
            chunks.push(bestChunk);
          }
        }
      }
    }

    // 按相关性排序
    chunks.sort((a, b) => b.relevance - a.relevance);

    // Token 限制裁剪
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

  /**
   * 获取文件内容（带缓存）
   */
  getFileContent(relPath: string): string | null {
    const cached = this.fileCache.get(relPath);
    if (cached !== undefined) return cached;

    const fullPath = join(this.workingDir, relPath);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      this.fileCache.set(relPath, content);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * 构建系统提示词（包含上下文和规则）
   */
  buildSystemPrompt(userQuery: string, basePrompt: string): string {
    const parts: string[] = [basePrompt];

    // 加载规则
    for (const rule of this.rules) {
      parts.push(`\n--- ${rule.source === 'project' ? '项目' : '用户'}规则 ---\n${rule.content}`);
    }

    // 组装上下文
    const chunks = this.assembleContext(userQuery);
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

  /**
   * 加载规则文件
   */
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
   * 计算文件与查询的相关性
   */
  private calculateRelevance(entry: FileIndexEntry, keywords: string[]): number {
    let score = 0;
    const name = entry.name.toLowerCase();
    const preview = entry.preview.toLowerCase();

    for (const kw of keywords) {
      const lowerKw = kw.toLowerCase();
      if (name.includes(lowerKw)) score += 5;
      if (preview.includes(lowerKw)) score += 1;
    }

    // 最近修改的文件加权
    const hoursSinceModified = (Date.now() - entry.modifiedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceModified < 24) score *= 1.5;

    return score;
  }

  /**
   * 找到文件中最相关的代码段
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

    // 找到得分最高的窗口
    const WINDOW = 30;
    let bestStart = 0;
    let bestScore = 0;

    for (let i = 0; i < lines.length - WINDOW; i++) {
      let windowScore = 0;
      for (let j = i; j < i + WINDOW && j < lines.length; j++) {
        windowScore += lineScores[j];
      }
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
      }
    }

    if (bestScore === 0) return null;

    const endLine = Math.min(bestStart + WINDOW, lines.length);
    const chunk = lines.slice(bestStart, endLine).join('\n');

    return {
      path,
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
  getStats(): { fileCount: number; memoryCount: number; ruleCount: number } {
    return {
      fileCount: this.fileIndex.length,
      memoryCount: this.memoryStore.length,
      ruleCount: this.rules.length,
    };
  }
}