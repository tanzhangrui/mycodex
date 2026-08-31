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
import type { ContextEngine } from './context-engine.js';

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
  ms: number;
  chunks: number;
  tokens: number;
}

export interface BenchMetrics {
  queries: number;
  recall: { at1: number; at3: number; at10: number; mrr: number };
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
    results.push({
      symbol: s.name,
      kind: s.kind,
      file: s.file,
      rank: idx === -1 ? null : idx + 1,
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

  return {
    queries: total,
    recall: {
      at1: hitAt(1),
      at3: hitAt(3),
      at10: hitAt(10),
      mrr: Number(mrr.toFixed(4)),
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
  deltas: { at3: number; at10: number; mrr: number };
  /** 逐条回退说明（空 = 无回退） */
  regressions: string[];
}

/**
 * 与基线对比：Recall@3 / Recall@10 / MRR 任一低于基线即回退。
 * 耗时不入对比（机器噪声大，且性能回退有 perf 指标可观察非门禁）。
 */
export function compareWithBaseline(current: BenchMetrics, baseline: BenchMetrics): BenchCompare {
  const deltas = {
    at3: current.recall.at3 - baseline.recall.at3,
    at10: current.recall.at10 - baseline.recall.at10,
    mrr: Number((current.recall.mrr - baseline.recall.mrr).toFixed(4)),
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
