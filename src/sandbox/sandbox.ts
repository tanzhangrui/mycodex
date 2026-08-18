/**
 * V0.4 — 安全沙箱执行
 * ==========================================
 *
 * 设计决策：
 * 1. 使用 child_process (而非 isolated-vm，因为原生模块会被系统策略阻止)
 * 2. 命令白名单 + 超时 kill + 输出截断
 * 3. 自动修复循环：出错后 Agent 分析 → 修复 → 重新执行，最多 3 次
 * 4. 执行前默认需要用户确认（可配置跳过）
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandTouchesSensitiveTarget, sanitizeEnvForChild } from '../core/privacy-guard.js';

// ---- 类型 ----

export interface SandboxOptions {
  /** 工作目录 */
  workingDir: string;
  /** 超时时间 (ms) */
  timeout: number;
  /** 最大输出长度 */
  maxOutput: number;
  /** 是否跳过用户确认 */
  skipConfirm: boolean;
  /** 确认回调 */
  confirm: (command: string) => Promise<boolean>;
}

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

// ---- 命令白名单 ----

const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'yarn', 'pnpm',
  'ls', 'dir', 'cat', 'type', 'echo',
  'git', 'python', 'python3', 'pip',
  'tsc', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha',
  'curl', 'wget',
  'mkdir', 'rm', 'cp', 'mv',
  'grep', 'find', 'wc',
  'go', 'cargo', 'rustc', 'java', 'javac',
]);

/** 危险命令模式 */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo\s/,
  /chmod\s+777/,
  />\s*\/dev\//,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{/,
  /fork\s*bomb/,
];

// ---- 沙箱执行器 ----

export class Sandbox {
  private options: SandboxOptions;

  constructor(options: Partial<SandboxOptions> = {}) {
    this.options = {
      workingDir: options.workingDir || process.cwd(),
      timeout: options.timeout || 30_000,
      maxOutput: options.maxOutput || 100_000,
      skipConfirm: options.skipConfirm || false,
      confirm: options.confirm || (async () => true),
    };
  }

  /**
   * 执行 shell 命令
   */
  async execute(command: string): Promise<SandboxResult> {
    // 安全检查
    const safetyCheck = this.checkSafety(command);
    if (!safetyCheck.safe) {
      return {
        success: false,
        stdout: '',
        stderr: safetyCheck.reason || '命令被安全策略阻止',
        exitCode: null,
        timedOut: false,
        duration: 0,
      };
    }

    // 用户确认
    if (!this.options.skipConfirm) {
      const confirmed = await this.options.confirm(command);
      if (!confirmed) {
        return {
          success: false,
          stdout: '',
          stderr: '用户取消了命令执行',
          exitCode: null,
          timedOut: false,
          duration: 0,
        };
      }
    }

    return this.runCommand(command);
  }

  /**
   * 执行代码片段（Node.js）
   */
  async executeCode(code: string): Promise<SandboxResult> {
    // 创建临时文件
    const tmpDir = join(tmpdir(), 'codex-sandbox');
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const tmpFile = join(tmpDir, `codex_${Date.now()}.js`);
    writeFileSync(tmpFile, code, 'utf-8');

    try {
      return await this.runCommand(`node "${tmpFile}"`);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 带自动修复的执行循环
   */
  async executeWithAutoFix(
    command: string,
    onFixAttempt: (attempt: number, error: string) => Promise<string | null>,
  ): Promise<{ result: SandboxResult; attempts: number }> {
    let result = await this.execute(command);
    let attempts = 1;

    while (!result.success && attempts < 3) {
      const errorOutput = result.stderr || result.stdout || `退出码: ${result.exitCode}`;
      const fix = await onFixAttempt(attempts, errorOutput);

      if (!fix) break; // 无法修复，停止

      // 执行修复命令
      result = await this.execute(fix);
      attempts++;
    }

    return { result, attempts };
  }

  /**
   * 运行命令
   */
  private runCommand(command: string): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(command, {
        shell: true,
        cwd: this.options.workingDir,
        // 隐私守卫：剥离 *_API_KEY / *_TOKEN / *_SECRET 等敏感变量，防子进程外泄
        env: sanitizeEnvForChild(),
        timeout: this.options.timeout,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000);
      }, this.options.timeout);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > this.options.maxOutput) {
          stdout = stdout.substring(0, this.options.maxOutput) + '\n... (输出被截断)';
          child.kill();
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > this.options.maxOutput) {
          stderr = stderr.substring(0, this.options.maxOutput) + '\n... (输出被截断)';
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({
          success: exitCode === 0 && !timedOut,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
          timedOut,
          duration: Date.now() - startTime,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: null,
          timedOut: false,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 安全检查
   */
  private checkSafety(command: string): { safe: boolean; reason?: string } {
    const trimmed = command.trim();

    // 检查危险模式
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { safe: false, reason: `命令包含危险模式: ${pattern}` };
      }
    }

    // 隐私守卫：阻止任何引用敏感文件（.env/私钥/证书）或密钥环境变量的命令
    if (commandTouchesSensitiveTarget(trimmed)) {
      return { safe: false, reason: '命令涉及敏感文件或密钥变量，已被隐私保护策略阻止' };
    }

    // 提取命令名
    const cmdName = trimmed.split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
    if (!cmdName) return { safe: false, reason: '空命令' };

    // 检查白名单
    const baseName = cmdName.split('/').pop() || cmdName;
    if (ALLOWED_COMMANDS.has(baseName)) {
      return { safe: true };
    }

    // 允许路径命令（如 ./node_modules/.bin/xxx）
    if (cmdName.startsWith('./') || cmdName.startsWith('../') || cmdName.startsWith('/')) {
      return { safe: true };
    }

    return { safe: false, reason: `命令不在白名单中: ${baseName}` };
  }
}

/**
 * 创建默认沙箱
 */
export function createSandbox(workingDir: string, confirm?: (cmd: string) => Promise<boolean>): Sandbox {
  return new Sandbox({
    workingDir,
    timeout: 30_000,
    maxOutput: 100_000,
    skipConfirm: false,
    confirm: confirm || (async () => true),
  });
}

/**
 * V1.3: 符合 ToolContext 接口的命令执行器
 */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CodeResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export function createCommandExecutor(sandbox: Sandbox): (command: string) => Promise<CommandResult> {
  return async (command: string) => {
    const result = await sandbox.execute(command);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  };
}

export function createCodeExecutor(sandbox: Sandbox): (code: string) => Promise<CodeResult> {
  return async (code: string) => {
    const result = await sandbox.executeCode(code);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}