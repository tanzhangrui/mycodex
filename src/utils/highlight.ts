/**
 * V1.5 — 代码块 ANSI 语法高亮
 * ==========================================
 *
 * 对 Markdown 代码块内的代码进行简单的 ANSI 颜色高亮：
 * - 关键字 (if/else/return/const/let/function/class/import/export) → 蓝色
 * - 字符串 ('...', "...", `...`) → 绿色
 * - 注释 (双斜线、块注释) → 灰色
 * - 数字 → 黄色
 * - 函数名 → 青色
 */

// ANSI 颜色代码
const R = '\x1b[0m';       // 重置
const BLUE = '\x1b[34m';   // 关键字
const GREEN = '\x1b[32m';  // 字符串
const GRAY = '\x1b[90m';   // 注释
const YELLOW = '\x1b[33m'; // 数字
const CYAN = '\x1b[36m';   // 函数名

// 关键字列表
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'async', 'await', 'yield',
  'const', 'let', 'var', 'function', 'class', 'extends', 'implements',
  'import', 'export', 'from', 'default', 'as', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'void', 'this', 'super', 'static', 'get', 'set',
  'interface', 'type', 'enum', 'namespace', 'module', 'declare', 'abstract',
  'public', 'private', 'protected', 'readonly', 'true', 'false', 'null',
  'undefined', 'fn', 'pub', 'mut', 'use', 'mod', 'struct', 'impl', 'trait',
  'match', 'where', 'dyn', 'ref', 'self', 'Self', 'unsafe', 'extern', 'crate',
  'def', 'elif', 'pass', 'raise', 'except', 'lambda', 'with', 'nonlocal',
  'global', 'assert', 'not', 'and', 'or', 'is', 'None', 'True', 'False',
  'func', 'go', 'chan', 'defer', 'select', 'range', 'map', 'package',
]);

/**
 * 对单行代码进行语法高亮
 */
function highlightLine(line: string, insideComment: boolean): { result: string; insideComment: boolean } {
  // 处理多行注释
  if (insideComment) {
    const endIdx = line.indexOf('*/');
    if (endIdx !== -1) {
      return {
        result: GRAY + line.substring(0, endIdx + 2) + R + highlightLine(line.substring(endIdx + 2), false).result,
        insideComment: false,
      };
    }
    return { result: GRAY + line + R, insideComment: true };
  }

  let result = '';
  let i = 0;

  while (i < line.length) {
    // 单行注释
    if (line[i] === '/' && line[i + 1] === '/' && !isInsideString(line, i)) {
      result += GRAY + line.substring(i) + R;
      return { result, insideComment: false };
    }

    // 多行注释开始
    if (line[i] === '/' && line[i + 1] === '*' && !isInsideString(line, i)) {
      const endIdx = line.indexOf('*/', i + 2);
      if (endIdx !== -1) {
        result += GRAY + line.substring(i, endIdx + 2) + R;
        i = endIdx + 2;
        continue;
      }
      result += GRAY + line.substring(i) + R;
      return { result, insideComment: true };
    }

    // 字符串 (单引号)
    if (line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      result += GREEN + line.substring(i, j) + R;
      i = j;
      continue;
    }

    // 字符串 (双引号)
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      result += GREEN + line.substring(i, j) + R;
      i = j;
      continue;
    }

    // 数字
    if (/\d/.test(line[i]) && (i === 0 || !/\w/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[\d.]/.test(line[j])) j++;
      const num = line.substring(i, j);
      if (/^\d+(\.\d+)?$/.test(num)) {
        result += YELLOW + num + R;
        i = j;
        continue;
      }
    }

    // 关键字 / 标识符
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j])) j++;
      const word = line.substring(i, j);
      if (KEYWORDS.has(word)) {
        result += BLUE + word + R;
      } else if (i > 0 && line[i - 1] === '.' && i + 1 < line.length && line[i - 2] !== '.') {
        result += CYAN + word + R;
      } else if (j < line.length && line[j] === '(') {
        result += CYAN + word + R;
      } else {
        result += word;
      }
      i = j;
      continue;
    }

    result += line[i];
    i++;
  }

  return { result, insideComment: false };
}

/**
 * 检查位置是否在字符串内
 */
function isInsideString(line: string, pos: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < pos; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    if (line[i] === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    if (line[i] === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

/**
 * 对包含 Markdown 代码块的文本进行语法高亮
 * 代码块外的内容原样输出，代码块内的代码进行逐行高亮
 */
export function highlightCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let insideComment = false;
  let lang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        insideComment = false;
        lang = line.substring(3).trim();
        result.push(`${GRAY}\`\`\`${lang}${R}`);
      } else {
        inCodeBlock = false;
        result.push(`${GRAY}\`\`\`${R}`);
      }
      continue;
    }

    if (inCodeBlock) {
      const { result: hl, insideComment: ic } = highlightLine(line, insideComment);
      insideComment = ic;
      result.push(hl);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}