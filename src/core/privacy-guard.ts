/**
 * V2.1 — 隐私守卫（Privacy Guard）
 * ==========================================
 *
 * 设计目标（对应 AI-IDE-MASTER-PROMPT.md ADR-5）：
 * 敏感文件与密钥对 Agent **物理隔离**，四个层面防御：
 * 1. 内存文件系统快照：敏感文件永不入快照（不可读/不可搜）
 * 2. 文件工具：read/write/edit 对敏感路径显式拒绝
 * 3. 沙箱命令：引用敏感文件/密钥环境变量的命令直接阻止
 * 4. 子进程环境：剥离 *_API_KEY / *_SECRET / *_TOKEN 等变量，防经 curl 外泄
 *
 * 原则：宁可误拦（用户可手动操作），绝不泄露。
 */

// ---- 敏感文件识别 ----

/** 敏感文件名模式（对 basename 匹配） */
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production ...
  /\.(pem|key|p12|pfx|keystore|jks)$/i, // 证书与私钥
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, // SSH 私钥（公钥一并隔离，防指纹）
  /^\.(npmrc|netrc|pypirc|yarnrc)$/i, // 可能内嵌 token 的 rc 文件
  /^(credentials|credential)(\.(json|xml|yaml|yml|ini|cfg|properties))?$/i,
  /^secrets?\.(json|yaml|yml|env|ini|cfg|toml)$/i,
  /^\.?(aws_|azure_|gcp_)?credentials$/i,
  /^service[-_]?account.*\.json$/i, // GCP 服务账号
  /^\.kube[\/\\]config$/i,
];

/** 敏感目录名（路径任一分段命中即隔离） */
const SENSITIVE_DIR_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);

/**
 * 判断路径是否敏感（Windows / POSIX 分隔符均兼容）
 */
export function isSensitivePath(path: string): boolean {
  const segments = path.split(/[\/\\]+/).filter(Boolean);
  for (const segment of segments) {
    if (SENSITIVE_DIR_NAMES.has(segment.toLowerCase())) return true;
    for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(segment)) return true;
    }
  }
  return false;
}

/** 供 UI 展示的隔离原因 */
export function sensitiveBlockReason(path: string): string {
  return `「${path}」受隐私保护策略隔离：Codex 不会读取、搜索、修改或执行涉及该文件的操作。`;
}

// ---- 沙箱命令拦截 ----

/** 引用敏感文件或密钥变量的命令模式 */
export const SENSITIVE_COMMAND_PATTERNS: RegExp[] = [
  /(^|[\s|&;>"'=\/\\])\.env(\.[\w.-]*)?(?=[\s|&;<>"']|$)/i, // 任何 .env* 文件引用
  /\.(pem|p12|pfx|keystore|jks)(?=[\s|&;<>"']|$)/i,
  /id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(npmrc|netrc|pypirc)(?=[\s|&;<>"']|$)/i,
  /(GLM|ANTHROPIC|OPENAI|DEEPSEEK|MOONSHOT|QWEN|DASHSCOPE|SILICONFLOW|ZHIPU)[_-]?(API[_-]?KEY|TOKEN|SECRET)/i,
  /\$env:[\w]*(_)?(KEY|TOKEN|SECRET|PASSWORD)[\w]*/i, // PowerShell 变量
  /%[\w]*(_)?(KEY|TOKEN|SECRET|PASSWORD)[\w]*%/i, // cmd 变量
  /\$\{?[\w]*(_)?(API_?KEY|TOKEN|SECRET|PASSWORD)[\w]*\}?/i, // bash 变量
];

export function commandTouchesSensitiveTarget(command: string): boolean {
  return SENSITIVE_COMMAND_PATTERNS.some((p) => p.test(command));
}

// ---- 子进程环境净化 ----

/** 需要从子进程环境剥离的变量名模式 */
const SENSITIVE_ENV_PATTERN =
  /(_API_?KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS?|_PRIVATE_?KEY)$|^(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)$/i;

/** 明确放行给子进程的常见非敏感变量（即使名字命中上面的模式） */
const ENV_ALLOWLIST = new Set(['npm_config_user_agent']);

/**
 * 净化子进程环境变量：剥离所有疑似密钥的变量，
 * 防止 `run_command` 的子进程（如 curl）携带密钥外泄。
 */
export function sanitizeEnvForChild(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key)) {
      clean[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * 日志/输出脱敏：将字符串中出现的疑似密钥值替换为 ***。
 * 用于错误消息与工具输出的最后一道防线。
 */
export function redactSecrets(text: string): string {
  return text.replace(
    /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"']{8,})/gi,
    '$1$2***REDACTED***',
  );
}
