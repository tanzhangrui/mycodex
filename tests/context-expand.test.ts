/**
 * V5.34 查询语义扩展测试（src/context/query-expand.ts）
 * + V5.35 bench 基线健康检测测试（checkBaselineHealth）
 * + 引擎级跨语言召回 / 驼峰子词匹配（tokenizeForEmbedding V5.34 增强）
 */

import { describe, it, expect } from 'vitest';
import {
  expandQuery,
  EXPANSION_DISCOUNT_EXACT,
  EXPANSION_DISCOUNT_AMBIGUOUS,
  expansionDiscountOf,
  pairDiscountOf,
} from '../src/context/query-expand.js';
import { tokenizeForEmbedding, ContextEngine } from '../src/context/context-engine.js';
import { checkBaselineHealth, saveBaseline, runBench, type BenchMetrics } from '../src/context/bench.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('V5.34 expandQuery（同义词扩展）', () => {
  it('中文词扩展出英文命名（登录 → login 精确映射 / signin 低置信）', () => {
    const { tokens, expansions, sources } = expandQuery('登录');
    expect(tokens).toContain('登录');
    // V5.41 逐对精确映射：登录→login 是主翻译（高置信），signin 仅近义（低置信）
    expect(expansions.get('login')).toBe(EXPANSION_DISCOUNT_EXACT);
    expect(expansions.get('signin')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS);
    expect(sources.some((s) => s.from === '登录' && s.to.includes('login'))).toBe(true);
  });

  it('英文词扩展出中文（payment → 支付）与同组英文（pay/charge）', () => {
    const { expansions } = expandQuery('payment');
    expect(expansions.get('支付')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS); // 多对多组 → 低置信
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

// ---- V5.38 置信度分级 ----

describe('V5.38 expansionDiscountOf（组规模分级）', () => {
  it('一一对应组（规模 2）→ 高置信折扣', () => {
    expect(expansionDiscountOf('用户')).toBe(EXPANSION_DISCOUNT_EXACT); // 用户↔user
    expect(expansionDiscountOf('user')).toBe(EXPANSION_DISCOUNT_EXACT);
    expect(expansionDiscountOf('缓存')).toBe(EXPANSION_DISCOUNT_EXACT); // 缓存↔cache
    expect(expansionDiscountOf('password')).toBe(EXPANSION_DISCOUNT_EXACT);
  });

  it('多对多组（规模 >2）→ 低置信折扣', () => {
    expect(expansionDiscountOf('支付')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS); // pay/payment/charge
    expect(expansionDiscountOf('payment')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS);
  });

  it('跨组连通词按合并集算（auth 连通 验证/权限 两组 → 低置信）', () => {
    // auth 出现在 [验证] 和 [权限] 两组 → 连通集 > 2 → 低置信
    expect(expansionDiscountOf('auth')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS);
  });

  it('不在词典 → 0 折扣', () => {
    expect(expansionDiscountOf('xqz')).toBe(0);
  });

  it('expandQuery 分级生效：用户 → user 拿高折扣（目标词一一对应）', () => {
    const { expansions } = expandQuery('用户');
    expect(expansions.get('user')).toBe(EXPANSION_DISCOUNT_EXACT);
  });

  it('sources 携带置信度（可观测；触发词级 = 逐对折扣均值）', () => {
    const { sources } = expandQuery('支付');
    const src = sources.find((s) => s.from === '支付');
    expect(src).toBeDefined();
    // 支付组配对：pay（精确映射 0.6）/ payment（0.3）/ charge（0.3）→ 均值 0.4
    expect(src!.discount).toBe(0.4);
  });
});

// ---- V5.41 逐对精确映射 ----

describe('V5.41 pairDiscountOf（逐对精确映射）', () => {
  it('精确配对满折扣：登录→login 拿 EXACT（组规模 3 也不例外）', () => {
    expect(pairDiscountOf('登录', 'login')).toBe(EXPANSION_DISCOUNT_EXACT);
    expect(pairDiscountOf('支付', 'pay')).toBe(EXPANSION_DISCOUNT_EXACT);
    expect(pairDiscountOf('保存', 'save')).toBe(EXPANSION_DISCOUNT_EXACT);
  });

  it('非精确配对回落组规模分级：登录→signin 仍是低置信', () => {
    expect(pairDiscountOf('登录', 'signin')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS);
    expect(pairDiscountOf('支付', 'payment')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS);
  });

  it('不在词典的词 → 0（不误抬）', () => {
    expect(pairDiscountOf('xqz', 'login')).toBe(0);
    expect(pairDiscountOf('登录', 'xqz')).toBe(0);
  });

  it('expandQuery 逐对生效：多词组内主翻译高置信、近义成员低置信', () => {
    const { expansions } = expandQuery('保存');
    expect(expansions.get('save')).toBe(EXPANSION_DISCOUNT_EXACT); // 精确映射
    expect(expansions.get('persist')).toBe(EXPANSION_DISCOUNT_AMBIGUOUS); // 近义
    expect(expansions.get('store')).toBe(EXPANSION_DISCOUNT_EXACT); // 精确映射
  });

  it('符号分层标记：导出符号与局部符号区分（bench 分层指标基础）', async () => {
    process.env.CODEX_CONFIG_PATH = join(tmpdir(), `codex-v541-cfg-${Date.now()}`);
    const dir = mkdtempSync(join(tmpdir(), 'codex-v541-exp-'));
    try {
      writeFileSync(
        join(dir, 'mod.ts'),
        [
          'export const exportedConst = 1;',
          'const localConst = 2;',
          'export function exportedFn() {',
          '  const inner = 3;',
          '  return inner;',
          '}',
          'function localFn() { return 4; }',
        ].join('\n'),
      );
      const eng = new ContextEngine();
      await eng.index(dir);
      const syms = eng.listSymbols();
      const byName = new Map(syms.map((s) => [s.name, s]));
      expect(byName.get('exportedConst')!.exported).toBe(true);
      expect(byName.get('exportedFn')!.exported).toBe(true);
      expect(byName.get('localConst')!.exported).toBe(false);
      expect(byName.get('localFn')!.exported).toBe(false);
      expect(byName.get('inner')!.exported).toBe(false); // 函数内局部变量
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    layers: {
      exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
      local: { queries: 4, at1: 3, at3: 4, at10: 4, mrr: 0.9 },
    },
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
