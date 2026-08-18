/**
 * V1.3 — 结构化日志系统
 * ==========================================
 *
 * 统一的日志系统，替代散落的 console.log/error。
 * 日志格式：[时间] [级别] [模块] 消息
 *
 * 支持 LOG_LEVEL 环境变量（debug/info/warn/error，默认 info）
 * UI 输出（process.stdout.write）不受影响
 */

// ---- 日志级别 ----

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getLogLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (env in LOG_LEVEL_ORDER) return env as LogLevel;
  return 'info';
}

const currentLevel = getLogLevel();

// ---- 格式化 ----

function formatMessage(level: LogLevel, module: string, message: string): string {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  return `[${time}] [${level.toUpperCase().padEnd(5)}] [${module}] ${message}`;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

// ---- Logger 类 ----

class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  debug(message: string, ...args: unknown[]): void {
    if (!shouldLog('debug')) return;
    const msg = formatMessage('debug', this.module, message);
    console.debug(msg, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (!shouldLog('info')) return;
    const msg = formatMessage('info', this.module, message);
    console.log(msg, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (!shouldLog('warn')) return;
    const msg = formatMessage('warn', this.module, message);
    console.warn(msg, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (!shouldLog('error')) return;
    const msg = formatMessage('error', this.module, message);
    console.error(msg, ...args);
  }
}

/**
 * 创建模块日志器
 */
export function createLogger(module: string): Logger {
  return new Logger(module);
}

/**
 * 默认日志器
 */
export const logger = new Logger('codex');