/**
 * V0.2 — 内置工具实现
 * ==========================================
 *
 * 工具列表：
 * 1. read_file   — 读取文件内容
 * 2. write_file  — 创建/覆盖文件
 * 3. edit_file   — 基于 unified diff 的精确编辑
 * 4. search_content — 内容搜索 (grep)
 * 5. list_files  — 列出目录结构
 */

import { resolve } from 'node:path';
import { toolRegistry, type RegisteredTool, type ToolResult } from './registry.js';
import { isSensitivePath, sensitiveBlockReason } from '../core/privacy-guard.js';

// ---- read_file ----

const readFileTool: RegisteredTool = {
  name: 'read_file',
  description: '读取文件内容。可以指定行范围来只读取部分内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作目录）' },
      startLine: { type: 'number', description: '起始行号（从 1 开始，可选）' },
      endLine: { type: 'number', description: '结束行号（包含，可选）' },
    },
    required: ['path'],
  },
  async execute(params, context): Promise<ToolResult> {
    // 隐私守卫：敏感文件显式拒绝
    if (isSensitivePath(params.path as string)) {
      return { success: false, output: '', error: sensitiveBlockReason(params.path as string) };
    }

    const filePath = resolve(context.workingDir, params.path as string);
    const startLine = params.startLine as number | undefined;
    const endLine = params.endLine as number | undefined;

    const content = context.readFile(filePath);
    if (content === null) {
      return { success: false, output: '', error: `文件不存在: ${params.path}` };
    }

    const lines = content.split('\n');

    if (startLine !== undefined || endLine !== undefined) {
      const start = Math.max(1, startLine || 1) - 1;
      const end = Math.min(lines.length, endLine || lines.length);
      const selectedLines = lines.slice(start, end);
      const result = selectedLines
        .map((line, i) => `${String(start + i + 1).padStart(4, ' ')}| ${line}`)
        .join('\n');
      return {
        success: true,
        output: `文件: ${params.path} (行 ${start + 1}-${end} / 共 ${lines.length} 行)\n\n${result}`,
        data: { content: selectedLines.join('\n'), totalLines: lines.length },
      };
    }

    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4, ' ')}| ${line}`).join('\n');
    return {
      success: true,
      output: `文件: ${params.path} (${lines.length} 行)\n\n${numbered}`,
      data: { content, totalLines: lines.length },
    };
  },
};

// ---- write_file ----

const writeFileTool: RegisteredTool = {
  name: 'write_file',
  description: '创建或覆盖文件。内容会先写入内存文件系统，需要用户确认后才写入磁盘。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作目录）' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(params, context): Promise<ToolResult> {
    // 隐私守卫：敏感文件显式拒绝
    if (isSensitivePath(params.path as string)) {
      return { success: false, output: '', error: sensitiveBlockReason(params.path as string) };
    }

    const filePath = resolve(context.workingDir, params.path as string);
    const content = params.content as string;

    const exists = context.readFile(filePath) !== null;
    context.writeFile(filePath, content);

    const action = exists ? '已更新' : '已创建';
    return {
      success: true,
      output: `${action}文件: ${params.path} (${content.split('\n').length} 行, ${content.length} 字符)`,
      data: { path: params.path, size: content.length },
    };
  },
};

// ---- edit_file ----

const editFileTool: RegisteredTool = {
  name: 'edit_file',
  description: `使用 unified diff 格式编辑文件。diff 中必须包含足够的上下文行以唯一定位修改位置。

diff 格式示例：
\`\`\`diff
<<<<<<< ORIGINAL
旧代码行
=======
新代码行
>>>>>>> UPDATED
\`\`\`

或使用 search/replace 格式：
\`\`\`
<<<<<<< SEARCH
要查找的代码
=======
替换为的代码
>>>>>>> REPLACE
\`\`\``,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作目录）' },
      search: { type: 'string', description: '要查找的原始代码块' },
      replace: { type: 'string', description: '替换为的新代码块' },
    },
    required: ['path', 'search', 'replace'],
  },
  async execute(params, context): Promise<ToolResult> {
    // 隐私守卫：敏感文件显式拒绝
    if (isSensitivePath(params.path as string)) {
      return { success: false, output: '', error: sensitiveBlockReason(params.path as string) };
    }

    const filePath = resolve(context.workingDir, params.path as string);
    const search = params.search as string;
    const replace = params.replace as string;

    const content = context.readFile(filePath);
    if (content === null) {
      return { success: false, output: '', error: `文件不存在: ${params.path}` };
    }

    // 精确匹配替换
    if (!content.includes(search)) {
      return {
        success: false,
        output: '',
        error: `未找到匹配的代码块。请确保 search 参数与文件中的内容完全一致（包括空白字符）。`,
      };
    }

    // 只替换第一次出现
    const newContent = content.replace(search, replace);
    if (newContent === content) {
      return { success: false, output: '', error: '替换后内容未变化，可能 search 匹配到空内容。' };
    }

    context.writeFile(filePath, newContent);

    // 生成简单的 diff 预览
    const searchLines = search.split('\n').length;
    const replaceLines = replace.split('\n').length;
    const diff = searchLines !== replaceLines ? ` (${searchLines}行 → ${replaceLines}行)` : '';

    return {
      success: true,
      output: `已编辑文件: ${params.path}${diff}`,
      data: { path: params.path, oldContent: content, newContent },
    };
  },
};

// ---- search_content ----

const searchContentTool: RegisteredTool = {
  name: 'search_content',
  description: '在文件中搜索匹配的文本模式。支持正则表达式。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（支持正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录，默认为工作目录）' },
      glob: { type: 'string', description: '文件名过滤 glob 模式，如 *.ts' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写（默认 false）' },
    },
    required: ['pattern'],
  },
  async execute(params, context): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) || '.';
    const glob = params.glob as string | undefined;
    const caseSensitive = (params.caseSensitive as boolean) || false;

    const results = context.searchContent(pattern, searchPath, glob);

    if (results.length === 0) {
      return {
        success: true,
        output: `未找到匹配 "${pattern}" 的结果。`,
        data: { matches: [] },
      };
    }

    const flags = caseSensitive ? '' : '(不区分大小写)';
    const header = `搜索 "${pattern}" ${flags} — 找到 ${results.length} 个匹配:\n\n`;
    const MAX_RESULTS = 50;
    const display = results.slice(0, MAX_RESULTS);
    const output = header + display.join('\n') + (results.length > MAX_RESULTS ? `\n\n... 还有 ${results.length - MAX_RESULTS} 个结果未显示` : '');

    return {
      success: true,
      output,
      data: { matches: results, total: results.length },
    };
  },
};

// ---- list_files ----

const listFilesTool: RegisteredTool = {
  name: 'list_files',
  description: '列出目录中的文件和子目录。支持递归深度控制。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对于工作目录，默认为当前目录）' },
      depth: { type: 'number', description: '递归深度（默认 2，最大 5）' },
    },
    required: [],
  },
  async execute(params, context): Promise<ToolResult> {
    const dirPath = (params.path as string) || '.';
    const depth = Math.min((params.depth as number) || 2, 5);

    const files = context.listFiles(dirPath, depth);

    if (files.length === 0) {
      return {
        success: true,
        output: `目录为空: ${dirPath}`,
        data: { files: [] },
      };
    }

    const output = `目录: ${dirPath} (${files.length} 个项目, 深度 ${depth})\n\n${files.join('\n')}`;
    return {
      success: true,
      output,
      data: { files, count: files.length },
    };
  },
};

// ---- run_command ----

const runCommandTool: RegisteredTool = {
  name: 'run_command',
  description: '执行 shell 命令并返回结果。命令会在安全沙箱中执行，有超时限制和输出截断。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'number', description: '超时时间（毫秒，默认 30000）' },
    },
    required: ['command'],
  },
  async execute(params, context): Promise<ToolResult> {
    if (!context.executeCommand) {
      return { success: false, output: '', error: '沙箱执行环境未初始化' };
    }

    const result = await context.executeCommand(params.command as string);

    if (result.success) {
      return {
        success: true,
        output: result.stdout || '(无输出)',
        data: { exitCode: result.exitCode },
      };
    }

    return {
      success: false,
      output: result.stdout,
      error: result.stderr || `命令退出码: ${result.exitCode}`,
    };
  },
};

// ---- run_script ----

const runScriptTool: RegisteredTool = {
  name: 'run_script',
  description: '在沙箱中执行 JavaScript/Node.js 代码片段。代码会被写入临时文件并执行。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的 JavaScript 代码' },
    },
    required: ['code'],
  },
  async execute(params, context): Promise<ToolResult> {
    if (!context.executeCode) {
      return { success: false, output: '', error: '沙箱执行环境未初始化' };
    }

    const result = await context.executeCode(params.code as string);

    if (result.success) {
      return {
        success: true,
        output: result.stdout || '(无输出)',
      };
    }

    return {
      success: false,
      output: result.stdout,
      error: result.stderr || '代码执行出错',
    };
  },
};

// ---- 注册所有内置工具 ----

export function registerBuiltinTools(): void {
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(searchContentTool);
  toolRegistry.register(listFilesTool);
  toolRegistry.register(runCommandTool);
  toolRegistry.register(runScriptTool);
}

/**
 * 清除所有已注册工具（用于测试重置）
 */
export function clearTools(): void {
  toolRegistry.clear();
}