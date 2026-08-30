/**
 * V3.3 — 本地 FIM Tab 补全：纯逻辑核心（零 vscode 依赖，可直测）
 *
 * qwen2.5-coder FIM 模板：
 *   <|fim_begin|>{prefix}<|fim_hole|>{suffix}<|fim_end|>
 *
 * 职责：
 * - shouldTrigger：触发判定（防按键风暴）
 * - buildFimPrompt：prefix/suffix 裁剪 + 模板组装
 * - cleanFimResponse：响应清洗（去模板残留/截断噪声）
 */

export interface FimContextLimit {
  /** 光标前保留的最大行数 */
  maxPrefixLines: number;
  /** 光标后保留的最大行数 */
  maxSuffixLines: number;
  /** 补全长上限（num_predict） */
  maxTokens: number;
}

export const DEFAULT_FIM_LIMITS: FimContextLimit = {
  maxPrefixLines: 64,
  maxSuffixLines: 32,
  maxTokens: 96,
};

export const FIM_BEGIN = '<|fim_begin|>';
export const FIM_HOLE = '<|fim_hole|>';
export const FIM_END = '<|fim_end|>';

/** 触发门槛：当前行光标前的非空白字符数 */
const MIN_PREFIX_CHARS = 3;

/**
 * 是否应触发补全请求。
 * 规则：光标前有足够内容（≥3 非空白字符），且当前行不是纯注释延续的极端场景。
 * 空行/刚敲一个字符不请求——防按键风暴压垮本地推理。
 */
export function shouldTrigger(linePrefixBeforeCursor: string): boolean {
  const trimmed = linePrefixBeforeCursor.trim();
  if (trimmed.length < MIN_PREFIX_CHARS) return false;
  // 纯标点（如 "})" / "();"）不触发——没有可补全语义
  if (!/[A-Za-z0-9_$\u4e00-\u9fa5]/.test(trimmed)) return false;
  return true;
}

/**
 * 构建 FIM prompt：裁剪 prefix/suffix 并套入模板。
 * @param prefix 光标前文本（整段）
 * @param suffix 光标后文本（整段）
 */
export function buildFimPrompt(prefix: string, suffix: string, limits: FimContextLimit = DEFAULT_FIM_LIMITS): string {
  const p = tailLines(prefix, limits.maxPrefixLines);
  const s = headLines(suffix, limits.maxSuffixLines);
  return `${FIM_BEGIN}${p}${FIM_HOLE}${s}${FIM_END}`;
}

/**
 * 清洗模型响应：去 FIM 模板残留、截断到首个换行失衡点、去首尾空白。
 * 返回空字符串表示无有效补全（调用方应返回空 items，避免幽灵建议）。
 */
export function cleanFimResponse(raw: string): string {
  let text = raw;

  // 去模板残留（模型偶发复读模板 token）
  for (const marker of [FIM_END, FIM_BEGIN, FIM_HOLE, '<|endoftext|>', '<|im_end|>']) {
    const idx = text.indexOf(marker);
    if (idx >= 0) text = text.slice(0, idx);
  }

  // 去掉模型补出的重复前缀末行（常见于弱模型：复读光标前一行）
  text = text.replace(/\s+$/, '');

  // 空补全
  if (!text.trim()) return '';

  // 多行补全裁剪：止于首个未闭合的空行（弱模型长尾易胡言）
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    kept.push(line);
    if (line.trim() === '' && kept.length > 1) break; // 补全中出现空行即止
  }
  text = kept.join('\n').replace(/\s+$/, '');

  return text.trim() ? text : '';
}

/** 取文本末尾 N 行（保留原始换行语义） */
function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.slice(-maxLines).join('\n');
}

/** 取文本开头 N 行 */
function headLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.slice(0, maxLines).join('\n');
}
