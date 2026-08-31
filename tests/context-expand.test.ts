/**
 * V5.34 查询语义扩展测试（src/context/query-expand.ts）
 * + V5.35 bench 基线健康检测测试（checkBaselineHealth）
 * + 引擎级跨语言召回 / 驼峰子词匹配（tokenizeForEmbedding V5.34 增强）
 */

import { describe, it, expect } from 'vitest';
import { expandQuery, EXPANSION_DISCOUNT } from '../src/context/query-expand.js';
import { tokenizeForEmbedding, ContextEngine } from '../src/context/context-engine.js';
import { checkBaselineHealth, saveBaseline, runBench, type BenchMetrics } from '../src/context/bench.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('V5.34 expandQuery（同义词扩展）', () => {
  it('中文词扩展出英文命名（登录 → login/signin）', () => {
    const { tokens, expansions, sources } = expandQuery('登录');
    expect(tokens).toContain('登录');
    expect(expansions.get('login')).toBe(EXPANSION_DISCOUNT);
    expect(expansions.get('signin')).toBe(EXPANSION_DISCOUNT);
    expect(sources.some((s) => s.from === '登录' && s.to.includes('login'))).toBe(true);
  });

  it('英文词扩展出中文（payment → 支付）与同组英文（pay/charge）', () => {
    const { expansions } = expandQuery('payment');
    expect(expansions.get('支付')).toBe(EXPANSION_DISCOUNT);
    expect(expansions.has('pay')).toBe(true);
    expect(expansions.has('charge')).toBe(true);
  });

  it('双向生效：中文查询 ↔ 英文代码互相可达（购物车 ↔ cart/basket）', () => {
    expect(expandQuery('购物车').expansions.has('cart')).toBe(true);
    expect(expandQuery('cart').expansions.has('购物车')).toBe(true);
  });

  it('查询已含的词不重复扩展（login 在查询里 → 不从 登录 再扩 login）', () => {
    const { expansions } = expandQuery('login 登录');
    expect(expansions.has('login')).toBe(false); // 原词优先
  });

  it('驼峰查询拆子词（UserRepository → user/repository 也参与同义词匹配）', () => {
    const { tokens } = expandQuery('UserRepository');
    expect(tokens).toContain('user');
    expect(tokens).toContain('repository');
    // 子词也触发扩展：repository → 仓库
    const { expansions } = expandQuery('UserRepository');
    expect(expansions.has('仓库')).toBe(true);
  });

  it('无信号查询零扩展（负例防线不受词典影响）', () => {
    const { tokens, expansions } = expandQuery('xqz wvv');
    expect(tokens).toEqual(['xqz', 'wvv']);
    expect(expansions.size).toBe(0);
  });
});

describe('V5.34 tokenizeForEmbedding 子词拆分', () => {
  it('camelCase：UserRepository → user / repository / 整词都保留', () => {
    const tokens = tokenizeForEmbedding('class UserRepository {}');
    expect(tokens).toContain('userrepository');
    expect(tokens).toContain('user');
    expect(tokens).toContain('repository');
  });

  it('snake_case：create_user → create / user / 整词都保留', () => {
    const tokens = tokenizeForEmbedding('function create_user() {}');
    expect(tokens).toContain('create_user');
    expect(tokens).toContain('create');
    expect(tokens).toContain('user');
  });

  it('对称性：口语查询与 camelCase 命名共享子词 token', () => {
    const query = tokenizeForEmbedding('user repository');
    const code = tokenizeForEmbedding('UserRepository');
    const shared = query.filter((t) => code.includes(t));
    expect(shared).toContain('user');
    expect(shared).toContain('repository');
  });

  it('既有断言回归：普通小写词行为不变', () => {
    expect(tokenizeForEmbedding('abc')).toEqual(['abc']);
    expect(tokenizeForEmbedding('user login')).toContain('user_login');
  });
});

describe('V5.34 引擎级：跨语言口语查询召回', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    process.env.CODEX_CONFIG_PATH = join(tmpdir(), `codex-v534-cfg-${Date.now()}`);
    r = mkdtempSync(join(tmpdir(), 'codex-v534-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    // 纯英文命名代码：中文口语查询与其零词面交集（无中文注释）
    writeFileSync(
      join(r, 'src', 'payment-gateway.ts'),
      `export class PaymentGateway {\n  charge(orderId: string): boolean {\n    return true;\n  }\n}\n`,
    );
    // 驼峰命名：口语子词查询的命中目标
    writeFileSync(
      join(r, 'src', 'user-repository.ts'),
      `export class UserRepository {\n  findById(id: number): object | null {\n    return null;\n  }\n}\n`,
    );
    // 干扰文件
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(r, 'src', `filler-${i}.ts`), `export const value${i} = ${i};\n`);
    }
    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('中文口语查询召回英文命名文件（支付 → payment/charge）', () => {
    const chunks = e.assembleContext('支付扣款怎么实现的', { maxTokens: 20_000 });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain('src/payment-gateway.ts');
  });

  it('口语子词查询命中驼峰命名文件（user repository → UserRepository）', () => {
    const chunks = e.assembleContext('user repository 查询用户', { maxTokens: 20_000 });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain('src/user-repository.ts');
  });

  it('召回分解暴露扩展来源（可观测）', () => {
    const bd = e.debugRecall('支付扣款', { maxTokens: 20_000 });
    expect(bd.expansions.some((x) => x.from === '支付')).toBe(true);
    expect(bd.expansions.find((x) => x.from === '支付')!.to).toContain('payment');
  });

  it('负例回归：乱码查询零扩展零召回', () => {
    expect(e.assembleContext('xqzww vvqqz', { maxTokens: 20_000 })).toEqual([]);
  });

  it('V5.37 符号路扩展兜底：中文查询命中英文名符号定义（ProviderType ← 提供者）', () => {
    // 语料补充：config.ts 定义 ProviderType（"提供者" 与其零词面交集）
    writeFileSync(
      join(r, 'src', 'provider-type.ts'),
      `export type ProviderType = 'anthropic' | 'openai-compatible' | 'local' | 'mock';\n`,
    );
    e.refresh(); // 新文件入索引（invalidateFile 只处理已收录文件的内容变化）
    const syms = e.resolveQuerySymbols('提供者');
    expect(syms.some((s) => s.name === 'ProviderType')).toBe(true);
    // 组装链路同样召回定义文件
    const chunks = e.assembleContext('提供者', { maxTokens: 20_000 });
    expect(chunks.map((c) => c.path)).toContain('src/provider-type.ts');
  });

  it('V5.37 兜底门控：已有精确命中时扩展不污染（支付 仍命中 PayGateway 而非 provider 类符号）', () => {
    // "支付扣款" 走扩展词典命中 payment 类符号；确认结果不含无关扩展污染
    const syms = e.resolveQuerySymbols('支付扣款');
    expect(syms.length).toBeGreaterThan(0);
    // 全部命中要么词面相关（pay/charge）要么扩展相关（payment），不能是无关符号
    for (const s of syms) {
      expect(s.name.toLowerCase()).toMatch(/pay|charge|order|refund/);
    }
  });
});

describe('V5.35 checkBaselineHealth（doctor 数据源）', () => {
  const mkMetrics = (at3 = 9, queries = 10): BenchMetrics => ({
    queries,
    recall: { at1: at3, at3, at10: at3, mrr: 0.9 },
    crossLingual: { queries: 4, at3: 4, at10: 4, mrr: 1 },
    perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
    negatives: { probes: 3, falsePositives: [] },
    samples: [],
  });

  it('missing：无基线文件 → 提示建基线命令', () => {
    const h = checkBaselineHealth(join(tmpdir(), `no-such-${Date.now()}`));
    expect(h.status).toBe('missing');
    expect(h.savedAt).toBeNull();
    expect(h.hint).toContain('--save');
  });

  it('ok：新基线 → 状态健康 + Recall@3 百分比', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-v535-'));
    try {
      const b = saveBaseline(mkMetrics(), { queries: 10, maxTokens: 12_000 }, join(dir, '.codex-bench.json'));
      const h = checkBaselineHealth(dir);
      expect(h.status).toBe('ok');
      expect(h.recallAt3Pct).toBe(90);
      expect(h.savedAt).toBe(b.savedAt);
      expect(h.ageDays).toBe(0);
      expect(h.hint).toContain('--compare');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stale：基线超 7 天 → 过期提示刷新', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-v535s-'));
    try {
      saveBaseline(mkMetrics(), { queries: 10, maxTokens: 12_000 }, join(dir, '.codex-bench.json'));
      // 回写 savedAt 为 10 天前
      const file = join(dir, '.codex-bench.json');
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      raw.savedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
      writeFileSync(file, JSON.stringify(raw));
      const h = checkBaselineHealth(dir);
      expect(h.status).toBe('stale');
      expect(h.ageDays).toBe(10);
      expect(h.hint).toContain('--save');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupted 缺失态：非法 JSON 文件 → 按 missing 处理（提示重建）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-v535c-'));
    try {
      writeFileSync(join(dir, '.codex-bench.json'), 'not json', 'utf-8');
      const h = checkBaselineHealth(dir);
      expect(h.status).toBe('missing');
      expect(h.hint).toContain('--save');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runBench 与基线健康联动：跑完 bench 后 save → doctor 可见 ok', () => {
    // 轻量验证 saveBaseline 接受 runBench 真实输出（字段契约）
    const dir = mkdtempSync(join(tmpdir(), 'codex-v535r-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'export class Alpha {}\n');
      const e = new ContextEngine();
      void e.index(dir);
      const m = runBench(e, { queries: 3, maxTokens: 8_000 });
      saveBaseline(m, { queries: 3, maxTokens: 8_000 }, join(dir, '.codex-bench.json'));
      const h = checkBaselineHealth(dir);
      expect(h.status).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
