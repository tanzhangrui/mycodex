/**
 * V5.1 多根入口接线测试
 * 覆盖：primaryRootOf / InMemoryFileSystem 多根快照 / runAgentLoop 多根
 * （系统提示词跨根召回 + CODEX.md 主根规则 + 工具主根基准）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { primaryRootOf, runAgentLoop, loadCodexRules, type AgentCallbacks } from '../src/core/agent-loop.js';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';
import { resetSharedContextEngine } from '../src/context/context-engine.js';
import type { AIProvider, StreamEvent } from '../src/utils/ai-client.js';
import type { Message } from '../src/core/message-manager.js';

let configDir: string;
let frontendRoot: string;
let backendRoot: string;

beforeAll(() => {
  configDir = join(tmpdir(), `codex-test-config-v51-${Date.now()}`);
  process.env.CODEX_CONFIG_PATH = configDir;

  const parent = mkdtempSync(join(tmpdir(), 'codex-v51-'));
  frontendRoot = join(parent, 'frontend');
  backendRoot = join(parent, 'backend');
  mkdirSync(join(frontendRoot, 'src'), { recursive: true });
  mkdirSync(join(backendRoot, 'src'), { recursive: true });
  writeFileSync(join(frontendRoot, 'CODEX.md'), '前端仓规则：组件用 React hooks。');
  writeFileSync(join(frontendRoot, 'src', 'widget.ts'), 'export class Widget {}\n');
  writeFileSync(join(backendRoot, 'src', 'invoice.ts'), 'export class InvoiceService {}\n');
});

afterAll(() => {
  rmSync(join(frontendRoot, '..'), { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  resetSharedContextEngine();
});

/** 捕获系统提示词的桩 Provider（返回纯文本，不触发工具循环） */
class PromptCaptureProvider implements AIProvider {
  readonly name = 'prompt-capture';
  lastSystemPrompt = '';

  async *stream(messages: Message[], systemPrompt: string): AsyncGenerator<string, void, undefined> {
    this.lastSystemPrompt = systemPrompt;
    yield 'ok';
  }

  async *streamWithTools(
    messages: Message[],
    systemPrompt: string,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    this.lastSystemPrompt = systemPrompt;
    yield { type: 'text', text: 'ok' };
  }
}

function noopCallbacks(): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}

// ---- primaryRootOf ----

describe('primaryRootOf', () => {
  it('单根原样返回', () => {
    expect(primaryRootOf('C:\\proj')).toBe('C:\\proj');
  });

  it('多根取首根（resolve 后）', () => {
    expect(primaryRootOf(['C:\\a', 'C:\\b'])).toBe(resolve('C:\\a'));
    expect(primaryRootOf([frontendRoot, backendRoot])).toBe(frontendRoot);
  });
});

// ---- InMemoryFileSystem 多根快照 ----

describe('InMemoryFileSystem 多根快照', () => {
  it('两根文件均入快照（绝对路径键，跨根可读）', async () => {
    const fs = new InMemoryFileSystem();
    await fs.snapshot([frontendRoot, backendRoot]);
    expect(fs.read(join(frontendRoot, 'src', 'widget.ts'))).toContain('Widget');
    expect(fs.read(join(backendRoot, 'src', 'invoice.ts'))).toContain('InvoiceService');
  });

  it('相对路径以首根（主根）为基准解析', async () => {
    const fs = new InMemoryFileSystem();
    await fs.snapshot([frontendRoot, backendRoot]);
    // src/widget.ts 相对主根（frontend）可读
    expect(fs.read('src/widget.ts')).toContain('Widget');
    // backend 的相对路径不经绝对路径不可达（主根语义——绝对路径可达）
    expect(fs.read(join(backendRoot, 'src', 'invoice.ts'))).not.toBeNull();
  });

  it('单根 string 行为不变（向后兼容）', async () => {
    const fs = new InMemoryFileSystem();
    await fs.snapshot(frontendRoot);
    expect(fs.read(join(frontendRoot, 'src', 'widget.ts'))).toContain('Widget');
    expect(fs.read(join(backendRoot, 'src', 'invoice.ts'))).toBeNull();
  });
});

// ---- runAgentLoop 多根 ----

describe('runAgentLoop 多根接线', () => {
  it('系统提示词包含跨根召回的次根代码上下文 + 主根 CODEX.md 规则', async () => {
    resetSharedContextEngine();
    const provider = new PromptCaptureProvider();
    const fs = new InMemoryFileSystem();
    await fs.snapshot([frontendRoot, backendRoot]);

    await runAgentLoop(
      provider,
      [{ role: 'user', content: 'InvoiceService 在哪里定义', timestamp: new Date().toISOString() }],
      fs,
      [frontendRoot, backendRoot],
      noopCallbacks(),
    );

    // 次根（backend）符号经跨根召回进入系统提示词
    expect(provider.lastSystemPrompt).toContain('InvoiceService');
    // 主根 CODEX.md 规则注入
    expect(provider.lastSystemPrompt).toContain('前端仓规则');
    resetSharedContextEngine();
  });

  it('单根 string 调用完全兼容（不回归）', async () => {
    resetSharedContextEngine();
    const provider = new PromptCaptureProvider();
    const fs = new InMemoryFileSystem();
    await fs.snapshot(frontendRoot);

    await runAgentLoop(
      provider,
      [{ role: 'user', content: 'Widget 在哪里', timestamp: new Date().toISOString() }],
      fs,
      frontendRoot,
      noopCallbacks(),
    );

    expect(provider.lastSystemPrompt).toContain('Widget');
    resetSharedContextEngine();
  });

  it('V5.17 多根 CODEX.md：次根规则也注入（标注根名）', async () => {
    writeFileSync(join(backendRoot, 'CODEX.md'), '后端仓规则：接口必须带错误码。');
    resetSharedContextEngine();
    const provider = new PromptCaptureProvider();
    const fs = new InMemoryFileSystem();
    await fs.snapshot([frontendRoot, backendRoot]);

    await runAgentLoop(
      provider,
      [{ role: 'user', content: 'InvoiceService 在哪里定义', timestamp: new Date().toISOString() }],
      fs,
      [frontendRoot, backendRoot],
      noopCallbacks(),
    );

    // 两根规则都注入，且带根名标签（Agent 可区分归属）
    expect(provider.lastSystemPrompt).toContain('前端仓规则');
    expect(provider.lastSystemPrompt).toContain('后端仓规则');
    expect(provider.lastSystemPrompt).toContain('CODEX.md（frontend）');
    expect(provider.lastSystemPrompt).toContain('CODEX.md（backend）');
    resetSharedContextEngine();
  });
});

// ---- V5.17 loadCodexRules ----

describe('loadCodexRules 多根规则合并', () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  let isolatedHome: string;

  beforeAll(() => {
    // 隔离用户级规则目录（避免真实 ~/.codex/CODEX.md 污染断言）
    isolatedHome = mkdtempSync(join(tmpdir(), 'codex-v517-home-'));
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it('多根：逐根加载 + 根名标签 + 根声明顺序', () => {
    const rules = loadCodexRules([frontendRoot, backendRoot]);
    const feIdx = rules.indexOf('前端仓规则');
    const beIdx = rules.indexOf('后端仓规则');
    expect(feIdx).toBeGreaterThanOrEqual(0);
    expect(beIdx).toBeGreaterThan(feIdx); // 首根规则在前
    expect(rules).toContain('[项目规则 — CODEX.md（frontend）]');
    expect(rules).toContain('[项目规则 — CODEX.md（backend）]');
  });

  it('单根：标签无根名（与旧版完全一致）', () => {
    const rules = loadCodexRules(frontendRoot);
    expect(rules).toContain('[项目规则 — CODEX.md]');
    expect(rules).not.toContain('CODEX.md（frontend）');
    expect(rules).toContain('前端仓规则');
  });

  it('用户级规则追加在项目规则之后', () => {
    mkdirSync(join(isolatedHome, '.codex'), { recursive: true });
    writeFileSync(join(isolatedHome, '.codex', 'CODEX.md'), '用户级全局规则。');
    const rules = loadCodexRules([frontendRoot, backendRoot]);
    expect(rules.indexOf('用户级全局规则')).toBeGreaterThan(rules.indexOf('后端仓规则'));
  });

  it('无规则文件的根静默跳过（用户级仍加载）', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'codex-v517-empty-'));
    try {
      const rules = loadCodexRules(emptyRoot);
      expect(rules).not.toContain('[项目规则'); // 空根无项目级规则
      expect(rules).toContain('用户级全局规则'); // 用户级不受影响（前一测试写入）
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
