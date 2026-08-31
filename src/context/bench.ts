/**
 * V5.32 召回质量基准核心（`codex context bench` 数据源）
 * ==========================================
 *
 * 与 CLI 解耦的可测试模块：
 * - runBench：符号分层抽样生成查询（确定性），测 Recall@1/3/10、MRR、耗时/ chunk / token
 * - saveBaseline / loadBaseline：基线落盘（JSON v1）——跨版本召回水位追踪
 * - compareWithBaseline：与基线逐指标对比，任何召回回退即 fail
 * - evalGate：CI 硬门禁（负例误召回 + --min-r3 召回下限）
 *
 * 门禁语义（均为"只升不降"红线）：
 * - 负例：乱码查询任何非空组装 = 误召回 → fail
 * - 基线对比：Recall@3 或 MRR 低于基线 → fail（抽样确定性保证同库同参数可比）
 * - min-r3：Recall@3 百分比低于阈值 → fail
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextEngine } from './context-engine.js';
import { chineseSynonymsOf } from './query-expand.js';

/**
 * 负例探针：固定乱码查询（跨库稳定）——任何非空组装都是误召回。
 * repeat 构造而非字面量/拼接：语义路是字符 trigram 匹配，源码里出现
 * 任何与探针相同的 trigram 序列（注释里写探针字样也不行）都会让
 * bench 索引自家源码时命中 bench.ts 自身（自指污染，实测负例全误召回）。
 */
export const NEG_PROBES = [
  'z'.repeat(6) + ' ' + 'w'.repeat(4),
  'q'.repeat(6) + ' ' + 'y'.repeat(4),
  'a'.repeat(6) + ' ' + 'c'.repeat(6),
];

export interface BenchParams {
  /** 抽样查询数 */
  queries: number;
  /** 组装 token 预算 */
  maxTokens: number;
}

export interface BenchSample {
  symbol: string;
  kind: string;
  file: string;
  /** 定义文件在组装结果中的排名（1 起始；null = 未召回） */
  rank: number | null;
  /** V5.36 跨语言查询（符号子词反查词典的中文同义词；null = 无词典命中） */
  crossQuery: string | null;
  /** 跨语言查询下定义文件的排名（null = 未召回 / 无跨语言查询） */
  crossRank: number | null;
  ms: number;
  chunks: number;
  tokens: number;
}

export interface BenchMetrics {
  queries: number;
  recall: { at1: number; at3: number; at10: number; mrr: number };
  /** V5.36 跨语言召回（中文口语查询 → 英文命名代码；queries=有词典命中的样本数） */
  crossLingual: { queries: number; at3: number; at10: number; mrr: number };
  perf: { avgMs: number; avgChunks: number; avgTokens: number };
  negatives: { probes: number; falsePositives: string[] };
  samples: BenchSample[];
}

/** 基线文件格式 v1 */
export interface BenchBaseline {
  format: 1;
  savedAt: string;
  params: BenchParams;
  metrics: BenchMetrics;
}

/**
 * V5.36 跨语言查询构造：符号子词反查词典的中文同义词。
 * PaymentGateway → 子词 payment → "支付"；Repository → "仓库"。
 * 任一子词有中文同义词 → 空格连接返回；否则 null（该样本无跨语言查询）。
 */
export function buildCrossLingualQuery(symbolName: string): string | null {
  const subwords = symbolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2);
  const zh = [...new Set(subwords.flatMap((s) => chineseSynonymsOf(s)))];
  return zh.length > 0 ? zh.join(' ') : null;
}

/**
 * 跑基准：符号池（名称 ≥3 字符，name@file 去重）分层抽样 N 个——
 * 排序后均匀取点，确定性：同代码库同参数必得同样本集。
 */
export function runBench(engine: ContextEngine, params: BenchParams): BenchMetrics {
  const pool: Array<{ name: string; kind: string; file: string }> = [];
  const seen = new Set<string>();
  for (const s of engine.listSymbols()) {
    if (s.name.length < 3) continue;
    const k = `${s.name}@${s.file}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push({ name: s.name, kind: s.kind, file: s.file });
  }

  const samples =
    pool.length <= params.queries
      ? pool
      : Array.from({ length: params.queries }, (_, i) => pool[Math.floor((i * pool.length) / params.queries)]);

  const results: BenchSample[] = [];
  for (const s of samples) {
    const t0 = Date.now();
    const chunks = engine.assembleContext(s.name, { maxTokens: params.maxTokens });
    const idx = chunks.findIndex((c) => c.path === s.file);
    // V5.36 跨语言查询：中文口语查英文命名（比字面查询难——无直接词面交集）
    const crossQuery = buildCrossLingualQuery(s.name);
    let crossRank: number | null = null;
    if (crossQuery) {
      const crossChunks = engine.assembleContext(crossQuery, { maxTokens: params.maxTokens });
      const ci = crossChunks.findIndex((c) => c.path === s.file);
      crossRank = ci === -1 ? null : ci + 1;
    }
    results.push({
      symbol: s.name,
      kind: s.kind,
      file: s.file,
      rank: idx === -1 ? null : idx + 1,
      crossQuery,
      crossRank,
      ms: Date.now() - t0,
      chunks: chunks.length,
      tokens: Math.round(chunks.reduce((n, c) => n + c.content.length, 0) / 4),
    });
  }

  const falsePositives = NEG_PROBES.filter((q) => engine.assembleContext(q, { maxTokens: params.maxTokens }).length > 0);

  const total = results.length;
  const hitAt = (k: number) => results.filter((r) => (r.rank ?? Infinity) <= k).length;
  const mrr =
    total === 0 ? 0 : results.reduce((n, r) => n + (r.rank !== null ? 1 / r.rank : 0), 0) / total;
  const avg = (f: (r: BenchSample) => number) =>
    total === 0 ? 0 : results.reduce((n, r) => n + f(r), 0) / total;

  // V5.36 跨语言指标：仅有词典命中的样本计入（分母 = crossQuery 非空样本数）
  const crossSamples = results.filter((r) => r.crossQuery !== null);
  const crossTotal = crossSamples.length;
  const crossHitAt = (k: number) => crossSamples.filter((r) => (r.crossRank ?? Infinity) <= k).length;
  const crossMrr =
    crossTotal === 0 ? 0 : crossSamples.reduce((n, r) => n + (r.crossRank !== null ? 1 / r.crossRank : 0), 0) / crossTotal;

  return {
    queries: total,
    recall: {
      at1: hitAt(1),
      at3: hitAt(3),
      at10: hitAt(10),
      mrr: Number(mrr.toFixed(4)),
    },
    crossLingual: {
      queries: crossTotal,
      at3: crossHitAt(3),
      at10: crossHitAt(10),
      mrr: Number(crossMrr.toFixed(4)),
    },
    perf: {
      avgMs: Number(avg((r) => r.ms).toFixed(1)),
      avgChunks: Number(avg((r) => r.chunks).toFixed(1)),
      avgTokens: Math.round(avg((r) => r.tokens)),
    },
    negatives: { probes: NEG_PROBES.length, falsePositives },
    samples: results,
  };
}

/** 基线落盘（JSON v1；覆盖既有文件） */
export function saveBaseline(metrics: BenchMetrics, params: BenchParams, file: string): BenchBaseline {
  const baseline: BenchBaseline = {
    format: 1,
    savedAt: new Date().toISOString(),
    params,
    metrics,
  };
  writeFileSync(file, JSON.stringify(baseline, null, 2), 'utf-8');
  return baseline;
}

/** 读基线；不存在 / 损坏 / 格式不符 → null（调用方决定报错语义） */
export function loadBaseline(file: string): BenchBaseline | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (raw?.format !== 1 || !raw?.metrics?.recall || !Array.isArray(raw?.metrics?.samples)) return null;
    return raw as BenchBaseline;
  } catch {
    return null;
  }
}

export interface BenchCompare {
  pass: boolean;
  /** 相对基线的增量（当前 - 基线；正 = 改善） */
  deltas: { at3: number; at10: number; mrr: number; crossAt3: number };
  /** 逐条回退说明（空 = 无回退） */
  regressions: string[];
}

/**
 * 与基线对比：Recall@3 / Recall@10 / MRR / 跨语言 Recall@3 任一低于基线即回退。
 * 耗时不入对比（机器噪声大，且性能回退有 perf 指标可观察非门禁）。
 * 跨语言指标仅在两边样本数一致且 >0 时对比（词典扩容会改变样本集，无可比性）。
 */
export function compareWithBaseline(current: BenchMetrics, baseline: BenchMetrics): BenchCompare {
  const crossComparable =
    current.crossLingual.queries === baseline.crossLingual.queries && current.crossLingual.queries > 0;
  const deltas = {
    at3: current.recall.at3 - baseline.recall.at3,
    at10: current.recall.at10 - baseline.recall.at10,
    mrr: Number((current.recall.mrr - baseline.recall.mrr).toFixed(4)),
    crossAt3: crossComparable ? current.crossLingual.at3 - baseline.crossLingual.at3 : 0,
  };
  const regressions: string[] = [];
  if (current.recall.at3 < baseline.recall.at3) {
    regressions.push(`Recall@3 回退: ${current.recall.at3} < 基线 ${baseline.recall.at3}`);
  }
  if (current.recall.at10 < baseline.recall.at10) {
    regressions.push(`Recall@10 回退: ${current.recall.at10} < 基线 ${baseline.recall.at10}`);
  }
  if (current.recall.mrr < baseline.recall.mrr) {
    regressions.push(`MRR 回退: ${current.recall.mrr} < 基线 ${baseline.recall.mrr}`);
  }
  if (crossComparable && current.crossLingual.at3 < baseline.crossLingual.at3) {
    regressions.push(`跨语言 Recall@3 回退: ${current.crossLingual.at3} < 基线 ${baseline.crossLingual.at3}`);
  }
  return { pass: regressions.length === 0, deltas, regressions };
}

export interface GateOptions {
  /** Recall@3 百分比下限（0-100；缺省不检查） */
  minR3?: number;
  /** 基线对比结果（有基线时传入） */
  compare?: BenchCompare;
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

/** CI 硬门禁：负例误召回 / min-r3 下限 / 基线回退，任一命中即 fail */
export function evalGate(m: BenchMetrics, opts: GateOptions = {}): GateResult {
  const reasons: string[] = [];
  if (m.negatives.falsePositives.length > 0) {
    reasons.push(`乱码查询误召回 ${m.negatives.falsePositives.length}/${m.negatives.probes}: ${m.negatives.falsePositives.join(' | ')}`);
  }
  if (opts.minR3 !== undefined) {
    if (m.queries === 0) {
      reasons.push(`无可测符号（索引为空），min-r3 ${opts.minR3}% 无法评估`);
    } else {
      const pct = (m.recall.at3 / m.queries) * 100;
      if (pct < opts.minR3) reasons.push(`Recall@3 ${pct.toFixed(1)}% 低于下限 ${opts.minR3}%`);
    }
  }
  if (opts.compare && !opts.compare.pass) reasons.push(...opts.compare.regressions);
  return { pass: reasons.length === 0, reasons };
}

// ---- V5.35 doctor 集成：bench 基线健康检测 ----

export interface BaselineHealth {
  status: 'missing' | 'ok' | 'stale' | 'corrupted';
  /** 基线文件绝对路径 */
  file: string;
  /** 保存时间（ISO；missing/corrupted 为 null） */
  savedAt: string | null;
  /** 距今天数（missing/corrupted 为 null） */
  ageDays: number | null;
  /** 基线 Recall@3 百分比（corrupted 为 null） */
  recallAt3Pct: number | null;
  /** 人读建议（doctor 展示；missing/corrupted/stale 各有修复命令） */
  hint: string;
}

/** 基线视为过期的天数上限（跨版本召回水位应常跑常新） */
export const BASELINE_STALE_DAYS = 7;

/**
 * V5.35 检查主根 bench 基线健康度（`codex doctor` 数据源）。
 * 纯读操作：missing / corrupted / stale（超 7 天）/ ok 四态。
 */
export function checkBaselineHealth(rootDir: string, baselineFile?: string): BaselineHealth {
  const file = baselineFile ?? join(rootDir, '.codex-bench.json');
  const b = loadBaseline(file);
  if (!b) {
    return {
      status: 'missing',
      file,
      savedAt: null,
      ageDays: null,
      recallAt3Pct: null,
      hint: `跑 codex context bench ${rootDir} --save 建立召回质量基线`,
    };
  }
  const ageDays = (Date.now() - new Date(b.savedAt).getTime()) / 86_400_000;
  const pct = b.metrics.queries === 0 ? 0 : (b.metrics.recall.at3 / b.metrics.queries) * 100;
  if (ageDays > BASELINE_STALE_DAYS) {
    return {
      status: 'stale',
      file,
      savedAt: b.savedAt,
      ageDays: Math.floor(ageDays),
      recallAt3Pct: Number(pct.toFixed(1)),
      hint: `基线已 ${Math.floor(ageDays)} 天未更新，跑 codex context bench ${rootDir} --save 刷新`,
    };
  }
  return {
    status: 'ok',
    file,
    savedAt: b.savedAt,
    ageDays: Math.floor(ageDays),
    recallAt3Pct: Number(pct.toFixed(1)),
    hint: `codex context bench ${rootDir} --compare 对比当前召回水位`,
  };
}
