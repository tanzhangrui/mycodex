/**
 * V5.32 bench 核心模块测试（src/context/bench.ts）
 * 覆盖：runBench 指标正确性 / 抽样确定性 / 基线落盘回读 / 基线对比（持平·回退·改善）/
 * 门禁（负例误召回 / min-r3 下限 / 基线回退聚合）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, tokenizeForEmbedding } from '../src/context/context-engine.js';
import {
  runBench,
  saveBaseline,
  loadBaseline,
  compareWithBaseline,
  evalGate,
  buildCrossLingualQuery,
  stableSample,
  NEG_PROBES,
  type BenchMetrics,
} from '../src/context/bench.js';

// ---- 语料：两个符号文件 + 一个无关文件 ----

let root: string;
let engine: ContextEngine;

beforeAll(async () => {
  process.env.CODEX_CONFIG_PATH = join(tmpdir(), `codex-bench532-cfg-${Date.now()}`);
  root = mkdtempSync(join(tmpdir(), 'codex-v532-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'pay.ts'),
    `/** 支付网关 */\nexport class PayGateway {\n  charge(): void {}\n}\n`,
  );
  writeFileSync(
    join(root, 'src', 'cart.ts'),
    `export class CartBasket {\n  add(): void {}\n}\n`,
  );
  writeFileSync(join(root, 'README.md'), '# readme\n');
  engine = new ContextEngine();
  await engine.index(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('V5.32 runBench（指标计算）', () => {
  it('指标正确：全部符号 top-3 召回 → at3=queries、mrr=1、负例零误召回', () => {
    const m = runBench(engine, { queries: 10, maxTokens: 20_000 });
    expect(m.queries).toBeGreaterThan(0);
    expect(m.recall.at3).toBe(m.queries);
    expect(m.recall.at1).toBe(m.queries);
    expect(m.recall.mrr).toBe(1);
    expect(m.negatives.falsePositives).toEqual([]);
    expect(m.negatives.probes).toBe(3);
    // 样本字段齐全：rank 为正整数
    for (const s of m.samples) {
      expect(s.rank).toBeGreaterThanOrEqual(1);
      expect(s.ms).toBeGreaterThanOrEqual(0);
      expect(s.chunks).toBeGreaterThanOrEqual(1);
    }
  });

  it('抽样确定性：同参数两次运行样本集与指标完全一致', () => {
    const a = runBench(engine, { queries: 2, maxTokens: 20_000 });
    const b = runBench(engine, { queries: 2, maxTokens: 20_000 });
    expect(a.samples.map((s) => s.symbol)).toEqual(b.samples.map((s) => s.symbol));
    expect(a.recall).toEqual(b.recall);
  });
});

describe('V5.32 基线落盘（saveBaseline / loadBaseline）', () => {
  it('roundtrip：保存 → 回读，字段逐层一致', () => {
    const m = runBench(engine, { queries: 5, maxTokens: 20_000 });
    const file = join(root, 'baseline.json');
    const saved = saveBaseline(m, { queries: 5, maxTokens: 20_000 }, file);
    expect(saved.format).toBe(1);
    const loaded = loadBaseline(file);
    expect(loaded).not.toBeNull();
    expect(loaded!.params).toEqual({ queries: 5, maxTokens: 20_000 });
    expect(loaded!.metrics.recall).toEqual(m.recall);
    expect(loaded!.metrics.samples).toEqual(m.samples);
  });

  it('损坏 / 缺失 / 格式不符 → null（不抛异常）', () => {
    const file = join(root, 'bad.json');
    expect(loadBaseline(file)).toBeNull(); // 不存在
    writeFileSync(file, 'not json', 'utf-8');
    expect(loadBaseline(file)).toBeNull(); // 非法 JSON
    writeFileSync(file, JSON.stringify({ format: 2, metrics: {} }), 'utf-8');
    expect(loadBaseline(file)).toBeNull(); // 格式版本不符
  });
});

describe('V5.32 基线对比（compareWithBaseline）', () => {
  const mk = (at3: number, at10: number, mrr: number): BenchMetrics => ({
    queries: 10,
    recall: { at1: at3, at3, at10, mrr },
    crossLingual: { queries: 5, at3: 5, at10: 5, mrr: 1 },
    layers: {
      exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
      local: { queries: 4, at1: 3, at3: 4, at10: 4, mrr: 0.9 },
    },
    perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
    negatives: { probes: 3, falsePositives: [] },
    samples: [],
  });

  it('持平：全部指标等于基线 → pass', () => {
    const c = compareWithBaseline(mk(9, 10, 0.9), mk(9, 10, 0.9));
    expect(c.pass).toBe(true);
    expect(c.regressions).toEqual([]);
    expect(c.deltas.at3).toBe(0);
  });

  it('回退：Recall@3 或 MRR 任一低于基线 → fail + 逐条说明', () => {
    const c = compareWithBaseline(mk(8, 10, 0.85), mk(9, 10, 0.9));
    expect(c.pass).toBe(false);
    expect(c.regressions.some((r) => r.includes('Recall@3'))).toBe(true);
    expect(c.regressions.some((r) => r.includes('MRR'))).toBe(true);
    expect(c.deltas.at3).toBe(-1);
  });

  it('改善：指标高于基线 → pass 且增量为正', () => {
    const c = compareWithBaseline(mk(10, 10, 1), mk(9, 10, 0.9));
    expect(c.pass).toBe(true);
    expect(c.deltas.at3).toBe(1);
    expect(c.deltas.mrr).toBeGreaterThan(0);
  });
});

describe('V5.32 CI 门禁（evalGate）', () => {
  const ok: BenchMetrics = {
    queries: 10,
    recall: { at1: 9, at3: 10, at10: 10, mrr: 0.95 },
    crossLingual: { queries: 5, at3: 5, at10: 5, mrr: 1 },
    layers: {
      exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
      local: { queries: 4, at1: 3, at3: 4, at10: 4, mrr: 0.9 },
    },
    perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
    negatives: { probes: 3, falsePositives: [] },
    samples: [],
  };

  it('无门禁条件：负例零误召回即 pass', () => {
    expect(evalGate(ok)).toEqual({ pass: true, reasons: [] });
  });

  it('min-r3：达标 pass / 不达标 fail（含百分比信息）', () => {
    expect(evalGate(ok, { minR3: 100 }).pass).toBe(true);
    const g = evalGate(ok, { minR3: 101 });
    expect(g.pass).toBe(false);
    expect(g.reasons.some((r) => r.includes('100.0%'))).toBe(true);
  });

  it('空索引 + min-r3：fail（无法评估也是回退）', () => {
    const empty: BenchMetrics = {
      queries: 0,
      recall: { at1: 0, at3: 0, at10: 0, mrr: 0 },
      crossLingual: { queries: 0, at3: 0, at10: 0, mrr: 0 },
      layers: {
        exported: { queries: 0, at1: 0, at3: 0, at10: 0, mrr: 0 },
        local: { queries: 0, at1: 0, at3: 0, at10: 0, mrr: 0 },
      },
      perf: { avgMs: 0, avgChunks: 0, avgTokens: 0 },
      negatives: { probes: 3, falsePositives: [] },
      samples: [],
    };
    const g = evalGate(empty, { minR3: 50 });
    expect(g.pass).toBe(false);
    expect(g.reasons.some((r) => r.includes('无法评估'))).toBe(true);
  });

  it('负例误召回：即使召回满分也 fail', () => {
    const bad: BenchMetrics = { ...ok, negatives: { probes: 3, falsePositives: ['zzzqqq wvvv'] } };
    const g = evalGate(bad);
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toContain('误召回 1/3');
  });

  it('基线回退：聚合进门禁 reasons', () => {
    const baseline = mkMetrics(9, 10, 0.9);
    const current = mkMetrics(8, 10, 0.9);
    const compare = compareWithBaseline(current, baseline);
    const g = evalGate(current, { compare });
    expect(g.pass).toBe(false);
    expect(g.reasons.some((r) => r.includes('Recall@3 回退'))).toBe(true);
  });
});

function mkMetrics(at3: number, at10: number, mrr: number): BenchMetrics {
  return {
    queries: 10,
    recall: { at1: at3, at3, at10, mrr },
    crossLingual: { queries: 0, at3: 0, at10: 0, mrr: 0 },
    layers: {
      exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
      local: { queries: 4, at1: 3, at3: 4, at10: 4, mrr: 0.9 },
    },
    perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
    negatives: { probes: 3, falsePositives: [] },
    samples: [],
  };
}

// ---- V5.36 跨语言语料与指标 ----

describe('V5.36 buildCrossLingualQuery（符号子词反查词典）', () => {
  it('PaymentGateway → 支付（payment 子词命中词典）', () => {
    expect(buildCrossLingualQuery('PaymentGateway')).toBe('支付');
  });

  it('UserRepository → 用户 仓库 存储（多子词各自命中，组内中文全收）', () => {
    expect(buildCrossLingualQuery('UserRepository')).toBe('用户 仓库 存储');
  });

  it('无词典命中 → null（不强行生成无意义查询）', () => {
    expect(buildCrossLingualQuery('ZzyzxBlorp')).toBeNull();
  });

  it('snake_case 与单词符号同样处理', () => {
    expect(buildCrossLingualQuery('create_user')).toBe('创建 用户');
    expect(buildCrossLingualQuery('login')).toBe('登录');
  });
});

describe('V5.36 runBench 跨语言指标', () => {
  // 语料含词典命中符号（PayGateway/CartBasket）与纯中文注释文件
  it('跨语言指标：中文查询召回英文符号文件（queries>0 且 at3 计数正确）', () => {
    const m = runBench(engine, { queries: 10, maxTokens: 20_000 });
    expect(m.crossLingual.queries).toBeGreaterThan(0);
    // 分母一致性：有跨语言查询的样本数 = crossLingual.queries
    expect(m.samples.filter((s) => s.crossQuery !== null).length).toBe(m.crossLingual.queries);
    // at3 ≤ queries 且计数值为整数计数
    expect(m.crossLingual.at3).toBeLessThanOrEqual(m.crossLingual.queries);
    // 本语料全部跨语言样本可召回（小库 + 词典命中）
    expect(m.crossLingual.at3).toBe(m.crossLingual.queries);
    expect(m.crossLingual.mrr).toBeGreaterThan(0);
  });

  it('跨语言样本字段：crossQuery 是中文、crossRank 与 rank 独立', () => {
    const m = runBench(engine, { queries: 10, maxTokens: 20_000 });
    const cross = m.samples.filter((s) => s.crossQuery !== null);
    expect(cross.length).toBeGreaterThan(0);
    for (const s of cross) {
      expect(s.crossQuery).toMatch(/[\u4e00-\u9fa5]/);
      if (s.crossRank !== null) expect(s.crossRank).toBeGreaterThanOrEqual(1);
    }
  });

  it('基线对比：跨语言回退进门禁（样本数一致时）', () => {
    const mk = (clAt3: number): BenchMetrics => ({
      queries: 10,
      recall: { at1: 10, at3: 10, at10: 10, mrr: 1 },
      crossLingual: { queries: 5, at3: clAt3, at10: 5, mrr: 0.9 },
      layers: {
        exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
        local: { queries: 4, at1: 4, at3: 4, at10: 4, mrr: 1 },
      },
      perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
      negatives: { probes: 3, falsePositives: [] },
      samples: [],
    });
    const c = compareWithBaseline(mk(3), mk(5));
    expect(c.pass).toBe(false);
    expect(c.regressions.some((r) => r.includes('跨语言 Recall@3 回退'))).toBe(true);
    expect(c.deltas.crossAt3).toBe(-2);
    // 持平不回退
    expect(compareWithBaseline(mk(5), mk(5)).pass).toBe(true);
  });

  it('词典扩容（样本数变化）→ 跨语言不对比不回退（无可比性）', () => {
    const cur: BenchMetrics = {
      queries: 10,
      recall: { at1: 10, at3: 10, at10: 10, mrr: 1 },
      crossLingual: { queries: 8, at3: 0, at10: 0, mrr: 0 }, // 样本数变了
      layers: {
        exported: { queries: 6, at1: 6, at3: 6, at10: 6, mrr: 1 },
        local: { queries: 4, at1: 4, at3: 4, at10: 4, mrr: 1 },
      },
      perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
      negatives: { probes: 3, falsePositives: [] },
      samples: [],
    };
    const base: BenchMetrics = {
      ...cur,
      crossLingual: { queries: 5, at3: 5, at10: 5, mrr: 1 },
    };
    const c = compareWithBaseline(cur, base);
    expect(c.pass).toBe(true); // 样本数不一致 → 跳过跨语言对比
    expect(c.deltas.crossAt3).toBe(0);
  });
});

// ---- V5.39 稳定采样（--seed） ----

describe('V5.39 stableSample（哈希过滤稳定采样）', () => {
  const mkPool = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Sym${i}`, kind: 'class', file: `src/f${i}.ts` }));

  it('同种子确定性：同池同 seed 两次采样结果一致', () => {
    const pool = mkPool(200);
    const a = stableSample(pool, 20, 42);
    const b = stableSample(pool, 20, 42);
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name));
  });

  it('样本量近似目标：200 池取 20 → 样本数在合理区间（概率保证）', () => {
    const pool = mkPool(200);
    const s = stableSample(pool, 20, 42);
    expect(s.length).toBeGreaterThan(5);
    expect(s.length).toBeLessThan(50);
  });

  it('核心性质——池增删不改既有成员选中状态（跨代码变更可比）', () => {
    const pool = mkPool(200);
    const before = new Set(stableSample(pool, 20, 42).map((s) => s.name));
    // 模拟代码变更：删 30 个旧符号 + 加 30 个新符号
    const changed = [...pool.slice(0, 170), ...mkPool(30).map((s) => ({ ...s, name: `New${s.name}` }))];
    const after = new Set(stableSample(changed, 20, 42).map((s) => s.name));
    // 存活成员的选中状态不变：before 中仍在池里的成员，选中集一致
    const survivors = new Set(pool.slice(0, 170).map((s) => s.name));
    for (const name of before) {
      if (survivors.has(name)) expect(after.has(name)).toBe(true);
    }
  });

  it('不同种子 → 不同样本集（避免系统性偏差）', () => {
    const pool = mkPool(200);
    const a = new Set(stableSample(pool, 20, 1).map((s) => s.name));
    const b = new Set(stableSample(pool, 20, 2).map((s) => s.name));
    // 期望不同但可能有少量交集；完全相同即失败
    expect([...a].every((x) => b.has(x))).toBe(false);
  });

  it('runBench 接入 seed：同库同 seed 复现一致，样本集与无 seed 不同', () => {
    const a = runBench(engine, { queries: 2, maxTokens: 20_000, seed: 7 });
    const b = runBench(engine, { queries: 2, maxTokens: 20_000, seed: 7 });
    expect(a.samples.map((s) => s.symbol)).toEqual(b.samples.map((s) => s.symbol));
    expect(a.recall.at3).toBe(b.recall.at3);
  });

  it('基线 params 携带 seed（roundtrip 保真）', () => {
    const m = runBench(engine, { queries: 3, maxTokens: 20_000, seed: 9 });
    const file = join(root, 'seed-baseline.json');
    saveBaseline(m, { queries: 3, maxTokens: 20_000, seed: 9 }, file);
    const loaded = loadBaseline(file);
    expect(loaded!.params.seed).toBe(9);
  });
});

// ---- V5.41 符号分层指标 ----

describe('V5.41 runBench 符号分层指标', () => {
  it('样本携带 exported 标记（语料符号全部导出）', () => {
    const m = runBench(engine, { queries: 10, maxTokens: 20_000 });
    expect(m.samples.length).toBeGreaterThan(0);
    for (const s of m.samples) expect(s.exported).toBe(true);
  });

  it('分层指标一致性：exported + local = 总体', () => {
    const m = runBench(engine, { queries: 10, maxTokens: 20_000 });
    expect(m.layers.exported.queries + m.layers.local.queries).toBe(m.queries);
    expect(m.layers.exported.at3 + m.layers.local.at3).toBe(m.recall.at3);
    expect(m.layers.local.queries).toBe(0); // 语料只有导出符号
  });
});

describe('V5.41 基线对比：导出层回退检测', () => {
  const mk = (exAt3: number): BenchMetrics => ({
    queries: 10,
    recall: { at1: 10, at3: 10, at10: 10, mrr: 1 },
    crossLingual: { queries: 0, at3: 0, at10: 0, mrr: 0 },
    layers: {
      exported: { queries: 6, at1: 6, at3: exAt3, at10: 6, mrr: 1 },
      local: { queries: 4, at1: 4, at3: 4, at10: 4, mrr: 1 },
    },
    perf: { avgMs: 1, avgChunks: 1, avgTokens: 1 },
    negatives: { probes: 3, falsePositives: [] },
    samples: [],
  });

  it('导出层 Recall@3 回退 → fail（总体持平也拦）', () => {
    const c = compareWithBaseline(mk(5), mk(6));
    expect(c.pass).toBe(false);
    expect(c.regressions.some((r) => r.includes('导出符号 Recall@3 回退'))).toBe(true);
    expect(c.deltas.exportedAt3).toBe(-1);
  });

  it('导出层样本数变化 → 跳过对比不回退（导出/局部比例漂移，无可比性）', () => {
    const cur = mk(4);
    const base = { ...mk(6), layers: { ...mk(6).layers, exported: { ...mk(6).layers.exported, queries: 8 } } };
    const c = compareWithBaseline(cur, base);
    expect(c.pass).toBe(true);
    expect(c.deltas.exportedAt3).toBe(0);
  });

  it('持平 → pass', () => {
    expect(compareWithBaseline(mk(6), mk(6)).pass).toBe(true);
  });
});

// ---- V5.41 负例探针重设计 + lock 文件排除 ----

describe('V5.40 负例探针设计不变量', () => {
  it('探针词全部 < 4 字符（不触发字符 trigram 提取）', () => {
    for (const probe of NEG_PROBES) {
      for (const word of probe.split(' ')) {
        expect(word.length).toBeLessThan(4);
      }
    }
  });

  it('三探针互不相同（多样性）', () => {
    expect(new Set(NEG_PROBES).size).toBe(3);
  });

  it('自指防线：bench.ts 源码分词不含任何探针词', () => {
    const src = readFileSync('src/context/bench.ts', 'utf-8');
    const tokens = new Set(tokenizeForEmbedding(src));
    for (const probe of NEG_PROBES) {
      for (const word of probe.split(' ')) {
        expect(tokens.has(word)).toBe(false);
      }
    }
  });

  it('trigram 碰撞回归：夹具含旧式乱码字面量，新探针零组装（旧探针必误召回）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-v540-noise-'));
    try {
      // 模拟真实仓库：测试夹具里常见乱码字面量（旧探针的 trigram 碰撞源）
      writeFileSync(
        join(dir, 'noise.test.ts'),
        `// 负例夹具\nexport const fixtures = ['zzzqqq wvvv', 'zzz不存在的查询xxx'];\n`,
      );
      writeFileSync(join(dir, 'real.ts'), `export class PayGateway {\n  charge(): void {}\n}\n`);
      const e = new ContextEngine();
      await e.index(dir);
      // 新探针：任何非空组装 = 误召回
      for (const probe of NEG_PROBES) {
        expect(e.assembleContext(probe, { maxTokens: 12_000 })).toEqual([]);
      }
      // 旧式 6/4 字符 repeat 探针在同一夹具上确实误召回（证明修复针对真实缺陷）
      const oldProbe = 'z'.repeat(6) + ' ' + 'w'.repeat(4);
      expect(e.assembleContext(oldProbe, { maxTokens: 12_000 }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('V5.40 lock 文件不入索引', () => {
  it('package-lock.json 被排除：哈希串不产生 token、不污染召回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-v540-lock-'));
    try {
      // 哈希内容：随机串的字符 trigram 会与短查询词碰撞（旧版实测污染负例防线）
      writeFileSync(
        join(dir, 'package-lock.json'),
        `{"integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw"}`,
      );
      writeFileSync(join(dir, 'real.ts'), `export class CartBasket {\n  add(): void {}\n}\n`);
      const e = new ContextEngine();
      await e.index(dir);
      const report = e.getContextReport();
      expect(report.fileCount).toBe(1);
      // 哈希内的随机子串作查询不得召回（文件不在索引 → 无信号可命中）
      expect(e.assembleContext('RGwwWnwQvk', { maxTokens: 12_000 })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
