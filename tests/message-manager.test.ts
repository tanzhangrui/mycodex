/**
 * V0.1 测试 — 消息管理器
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  createEmptyStore,
  addMessage,
  trimContext,
  clearMessages,
  getConversationHistory,
  type MessageStore,
  type Message,
} from '../src/core/message-manager.js';

describe('estimateTokens', () => {
  it('应该正确估算英文文本的 token 数', () => {
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('a')).toBe(1);
  });

  it('应该正确估算中文文本的 token 数', () => {
    expect(estimateTokens('你好')).toBe(1);
    expect(estimateTokens('你好世界')).toBe(1);
  });

  it('空字符串应该返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('长文本估算应该合理', () => {
    const text = 'a'.repeat(10000);
    expect(estimateTokens(text)).toBe(2500);
  });
});

describe('estimateMessagesTokens', () => {
  it('空消息列表应该返回 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('应该累加所有消息的 token 数', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello world', timestamp: '2024-01-01' },
      { role: 'assistant', content: 'hi there', timestamp: '2024-01-01' },
    ];
    expect(estimateMessagesTokens(messages)).toBe(5);
  });
});

describe('createEmptyStore', () => {
  it('应该创建空的 MessageStore', () => {
    const store = createEmptyStore();
    expect(store.messages).toEqual([]);
    expect(store.sessionId).toMatch(/^session_\d+$/);
    expect(store.createdAt).toBeTruthy();
    expect(store.updatedAt).toBeTruthy();
  });
});

describe('addMessage', () => {
  let store: MessageStore;

  beforeEach(() => {
    store = createEmptyStore();
  });

  it('应该添加用户消息', () => {
    const updated = addMessage(store, 'user', 'hello');
    expect(updated.messages.length).toBe(1);
    expect(updated.messages[0].role).toBe('user');
    expect(updated.messages[0].content).toBe('hello');
  });

  it('应该添加助手消息', () => {
    const updated = addMessage(store, 'assistant', 'hi there');
    expect(updated.messages.length).toBe(1);
    expect(updated.messages[0].role).toBe('assistant');
  });

  it('应该保留消息顺序', () => {
    let updated = addMessage(store, 'user', 'first');
    updated = addMessage(updated, 'assistant', 'second');
    updated = addMessage(updated, 'user', 'third');

    expect(updated.messages.length).toBe(3);
    expect(updated.messages[0].content).toBe('first');
    expect(updated.messages[1].content).toBe('second');
    expect(updated.messages[2].content).toBe('third');
  });
});

describe('trimContext', () => {
  it('少量消息不应被裁剪', () => {
    const store = createEmptyStore();
    let updated = addMessage(store, 'user', 'hello');
    updated = addMessage(updated, 'assistant', 'hi');

    const trimmed = trimContext(updated);
    expect(trimmed.messages.length).toBe(2);
  });

  it('超长消息应该被裁剪', () => {
    const store = createEmptyStore();
    let updated = store;
    for (let i = 0; i < 100; i++) {
      updated = addMessage(updated, 'user', 'x'.repeat(10000));
    }

    const trimmed = trimContext(updated);
    expect(trimmed.messages.length).toBeLessThan(100);
    expect(trimmed.messages.length).toBeGreaterThan(0);
  });

  it('裁剪后应该保留最新消息', () => {
    const store = createEmptyStore();
    let updated = store;
    for (let i = 0; i < 50; i++) {
      updated = addMessage(updated, 'user', `message_${i}`);
    }

    const trimmed = trimContext(updated);
    const lastMsg = trimmed.messages[trimmed.messages.length - 1];
    expect(lastMsg.content).toBe('message_49');
  });
});

describe('clearMessages', () => {
  it('应该清空所有消息', () => {
    const store = createEmptyStore();
    let updated = addMessage(store, 'user', 'hello');
    updated = addMessage(updated, 'assistant', 'hi');

    const cleared = clearMessages(updated);
    expect(cleared.messages.length).toBe(0);
  });
});

describe('getConversationHistory', () => {
  it('应该返回正确的对话历史格式', () => {
    const store = createEmptyStore();
    let updated = addMessage(store, 'user', 'hello');
    updated = addMessage(updated, 'assistant', 'hi');

    const history = getConversationHistory(updated);
    expect(history.length).toBe(2);
    expect(history[0]).toEqual({ role: 'user', content: 'hello' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'hi' });
  });
});