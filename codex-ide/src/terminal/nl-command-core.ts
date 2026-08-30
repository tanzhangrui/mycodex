/**
 * V3.3 — 终端命令自然语言化：纯逻辑核心（零 vscode 依赖，可直测）
 *
 * 职责：
 * - buildNlCommandPrompt：组装系统提示（注入平台/shell/工作目录上下文）
 * - parseNlCommandResponse：从模型输出提取命令（容错：代码块 / 裸文本 / 多行）
 */

export interface NlCommandContext {
  /** 平台，如 win32 / darwin / linux */
  platform: string;
  /** shell 名称，如 powershell / bash / zsh */
  shell: string;
  /** 工作目录（可选） */
  workingDir?: string;
}

/**
 * 组装 NL→命令 的系统提示。
 * 强约束：只输出一条命令、不加解释、不加 markdown（弱模型容错）。
 */
export function buildNlCommandPrompt(ctx: NlCommandContext): string {
  const parts = [
    '你是终端命令专家。用户用自然语言描述想做的事，你将其转换为一条可直接执行的终端命令。',
    `目标平台：${ctx.platform}，shell：${ctx.shell}。`,
    '规则：',
    '1. 只输出一条命令本身，不要任何解释、不要 markdown 代码块标记',
    '2. 优先使用目标平台原生命令',
    '3. 涉及删除/覆盖等危险操作时，使用最保守的形式（如回收站、-i 交互确认不可用时则直接给最标准形式）',
    '4. 不确定参数时给出最常见默认值',
  ];
  if (ctx.workingDir) parts.push(`当前工作目录：${ctx.workingDir}`);
  return parts.join('\n');
}

/**
 * 从模型输出提取命令。
 * 容错策略：
 * 1. 提取首个 ``` 代码块内容
 * 2. 否则取首个非空行
 * 3. 去掉行内注释尾部（# 或 //，仅当其前有空白且行非注释开头）
 */
export function parseNlCommandResponse(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  // 首个代码块
  const fence = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  if (fence && fence[1].trim()) {
    text = fence[1].trim();
  } else {
    // 首个非空行（跳过模型前言：以冒号结尾的短标签行，如"命令是："）
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let idx = 0;
    while (idx < lines.length - 1 && lines[idx].length <= 20 && /[:：]$/.test(lines[idx])) {
      idx++;
    }
    text = lines[idx] ?? '';
  }

  // 去行内注释（保守：仅 " # " 形式且非行首）
  const commentIdx = text.search(/\s+#\s/);
  if (commentIdx > 0) text = text.slice(0, commentIdx).trim();

  // 去掉模型礼貌性前缀
  text = text.replace(/^(命令|command)[:：]\s*/i, '');

  return text;
}

/** 简易危险命令检测（展示警告用，最终确认权在用户） */
export function isDangerousCommand(command: string): boolean {
  const dangerousPatterns: RegExp[] = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i, // rm -rf
    /\brmdir\s+\/s/i, // Windows 递归删除
    /\bformat\b/i, // 格式化
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    />\s*\/dev\/sd[a-z]/i, // 直写磁盘
    /drop\s+(table|database)/i, // 删库
    /\bshutdown\b|\breboot\b/i,
    /\bgit\s+push\s+.*--force/i, // 强推
    /\breg\s+delete\b.*\/f/i, // 注册表强删
    /\bremove-item\b.*-recurse.*-force/i, // PowerShell 递归强删
  ];
  return dangerousPatterns.some((re) => re.test(command));
}
