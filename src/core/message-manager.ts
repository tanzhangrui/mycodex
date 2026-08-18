/**
 * V0.1 架构决策 — 消息管理器
 * ==========================================
 *
 * 设计权衡：
 * 1. 持久化使用 JSON 文件而非 SQLite
 *    - 决策：V0.1 对话量小，JSON 文件读写 < 1ms，无需数据库开销
 *    - 代价：不支持增量写入，每次全量读写。对话量 > 1000 条时需迁移
 *    - 后续：V0.3 引入 LMDB/LevelDB 存储消息和记忆
 *
 * 2. Token 估算采用字符数/4 的粗糙算法
 *    - 决策：不引入 tiktoken（增加 2MB+ 体积），V0.1 只要近似裁剪即可
 *    - 精确度：英文约 1 token ≈ 4 chars，中文约 1 token ≈ 1.5 chars
 *    - 后续：V0.3 引入 tree-sitter 后使用精确 tokenizer
 *
 * 3. 上下文裁剪策略：保留最近 N 条消息 + 总 token 不超限
 *    - 决策：简单滑窗，从最新消息往前累加 token，超限后截断旧消息
 *    - 不保留"重要消息"标记（V0.3 记忆系统会处理）
 *
 * 4. 消息格式复用 Anthropic Messages API 格式
 *    - 决策：直接使用 { role, content } 格式，与 API 无缝对接
 *    - 好处：无需格式转换，减少序列化开销
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/config.js';

// ---- 类型定义 ----

export interface Message {
  /** 角色：user | assistant */
  role: 'user' | 'assistant';
  /** 消息内容 */
  content: string;
  /** 时间戳 (ISO 8601) */
  timestamp: string;
}

export interface MessageStore {
  /** 会话 ID（V0.1 仅支持单会话） */
  sessionId: string;
  /** 消息列表 */
  messages: Message[];
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

// ---- 常量 ----

/** 上下文窗口最大 token 数（claude-sonnet-4 是 200k，这里保守取 100k） */
const MAX_CONTEXT_TOKENS = 100_000;

/** 为 system prompt 和响应预留的 token 数 */
const RESERVED_TOKENS = 20_000;

/** 可用于消息的 token 上限 */
const MAX_MESSAGE_TOKENS = MAX_CONTEXT_TOKENS - RESERVED_TOKENS;

// ---- 路径工具 ----

function getMessageStorePath(): string {
  return join(getConfigDir(), 'messages.json');
}

// ---- Token 估算 ----

/**
 * 粗糙 token 估算：字符数 / 4
 * 英文约 4 chars/token，中文约 1.5 chars/token
 * 取 4 作为保守估计，确保不会超出限制
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 估算消息列表的总 token 数
 */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
}

// ---- 消息存储 ----

/**
 * 从磁盘加载消息存储
 */
export function loadMessages(): MessageStore {
  const storePath = getMessageStorePath();

  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as MessageStore;
  } catch {
    return createEmptyStore();
  }
}

/**
 * 保存消息存储到磁盘
 */
export function saveMessages(store: MessageStore): void {
  store.updatedAt = new Date().toISOString();
  const storePath = getMessageStorePath();
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * 创建空的消息存储
 */
export function createEmptyStore(): MessageStore {
  return {
    sessionId: `session_${Date.now()}`,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---- 消息操作 ----

/**
 * 添加一条消息并自动裁剪上下文
 */
export function addMessage(store: MessageStore, role: 'user' | 'assistant', content: string): MessageStore {
  const message: Message = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };

  store.messages.push(message);
  return trimContext(store);
}

/**
 * 上下文窗口裁剪：
 * 从最新消息往前累加 token，超出 MAX_MESSAGE_TOKENS 后截断旧消息
 */
export function trimContext(store: MessageStore): MessageStore {
  const messages = store.messages;
  let totalTokens = 0;
  let keepFrom = messages.length;

  // 从后往前累加，找到保留的起始位置
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    if (totalTokens + msgTokens > MAX_MESSAGE_TOKENS) {
      break;
    }
    totalTokens += msgTokens;
    keepFrom = i;
  }

  // 如果从第一条就要截断，至少保留最后一条消息
  if (keepFrom === messages.length) {
    keepFrom = Math.max(0, messages.length - 1);
  }

  store.messages = messages.slice(keepFrom);
  return store;
}

/**
 * 清空所有消息
 */
export function clearMessages(store: MessageStore): MessageStore {
  store.messages = [];
  store.updatedAt = new Date().toISOString();
  return store;
}

/**
 * 获取对话历史用于 API 调用
 * 转换为 Anthropic Messages API 兼容格式
 */
export function getConversationHistory(store: MessageStore): Array<{ role: 'user' | 'assistant'; content: string }> {
  return store.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * V2.0: 保存会话到独立文件
 * @returns 保存的文件路径
 */
export function saveSessionToFile(store: MessageStore): string {
  const sessionsDir = join(getConfigDir(), 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const filePath = join(sessionsDir, `${store.sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
}