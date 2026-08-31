/**
 * V5.32 bench 核心模块测试（src/context/bench.ts）
 * 覆盖：runBench 指标正确性 / 抽样确定性 / 基线落盘回读 / 基线对比（持平·回退·改善）/
 * 门禁（负例误召回 / min-r3 下限 / 基线回退聚合）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../src/context/context-engine.js';
import {
  runBench,
  saveBaseline,
  loadBaseline,
  compareWithBaseline,
  evalGate,
  buildCrossLingualQuery,
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
