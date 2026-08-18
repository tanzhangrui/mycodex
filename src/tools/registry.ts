/**
 * V1.4 — 工具注册系统
 * ==========================================
 *
 * 新增：
 * - loadMcpTools: 从 MCP Server 加载外部工具
 * - loadPlugin: 从 npm 包/本地文件加载工具插件
 * - LRU 工具结果缓存（5s TTL，最多 20 条）
 */

import type { ToolDefinition, JSONSchema } from '../utils/ai-client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('registry');

// ---- 工具上下文 ----

export interface ToolContext {
  /** 当前工作目录 */
  workingDir: string;
  /** 读取文件（从内存文件系统） */
  readFile: (path: string) => string | null;
  /** 写入文件（到内存文件系统） */
  writeFile: (path: string, content: string) => void;
  /** 列出目录 */
  listFiles: (dir: string, depth?: number) => string[];
  /** 搜索内容 */
  searchContent: (pattern: string, path?: string, glob?: string) => string[];
  /** 用户确认回调 */
  confirm: (message: string) => Promise<boolean>;
  /** 执行 shell 命令 */
  executeCommand?: (command: string) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }>;
  /** 执行代码片段 */
  executeCode?: (code: string) => Promise<{ success: boolean; stdout: string; stderr: string }>;
}

// ---- 工具结果 ----

export interface ToolResult {
  success: boolean;
  output: string;
  data?: unknown;
  error?: string;
}

// ---- 工具执行器 ----

export type ToolExecutor = (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

// ---- 工具注册表 ----

export interface RegisteredTool extends ToolDefinition {
  execute: ToolExecutor;
}

// ---- LRU 缓存 ----

interface CacheEntry {
  result: ToolResult;
  timestamp: number;
}

const TOOL_CACHE_TTL = 5000; // 5 秒
const TOOL_CACHE_MAX = 20;

/** 有副作用的工具名称，不缓存 */
const SIDE_EFFECT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'run_script',
  'execute_command',
  'execute_code',
]);

/**
 * 全局工具注册表
 */
class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private cache: Map<string, CacheEntry> = new Map();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * 生成缓存 Key
   */
  private cacheKey(name: string, params: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(params)}`;
  }

  /**
   * 清理过期缓存
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > TOOL_CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 执行工具（含缓存检查）
   */
  async execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `未知工具: ${name}`,
      };
    }

    try {
      // 参数验证
      const validation = validateParams(params, tool.parameters);
      if (!validation.valid) {
        return {
          success: false,
          output: '',
          error: `参数验证失败: ${validation.error}`,
        };
      }

      // 缓存检查（仅无副作用工具）
      if (!SIDE_EFFECT_TOOLS.has(name)) {
        const key = this.cacheKey(name, params);
        const cached = this.cache.get(key);
        const now = Date.now();
        if (cached && now - cached.timestamp <= TOOL_CACHE_TTL) {
          logger.info(`Cache Hit: ${name}(${JSON.stringify(params).substring(0, 50)})`);
          return cached.result;
        }
      }

      const result = await tool.execute(params, context);

      // 缓存结果（仅无副作用工具）
      if (!SIDE_EFFECT_TOOLS.has(name)) {
        this.evictExpired();
        // LRU: 超过限制时删除最旧的条目
        if (this.cache.size >= TOOL_CACHE_MAX) {
          let oldestKey = '';
          let oldestTime = Infinity;
          for (const [k, v] of this.cache) {
            if (v.timestamp < oldestTime) {
              oldestTime = v.timestamp;
              oldestKey = k;
            }
          }
          if (oldestKey) this.cache.delete(oldestKey);
        }
        const key = this.cacheKey(name, params);
        this.cache.set(key, { result, timestamp: Date.now() });
      }

      return result;
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 从 MCP Server 加载工具
   * @returns 加载的工具数量
   */
  async loadMcpTools(command: string, args: string[] = []): Promise<number> {
    const { McpClient } = await import('./mcp-client.js');
    type McpClientInstance = InstanceType<typeof McpClient>;
    const client = new McpClient();
    const mcpClients: McpClientInstance[] = (this as unknown as { _mcpClients?: McpClientInstance[] })._mcpClients || [];
    mcpClients.push(client);
    (this as unknown as { _mcpClients: McpClientInstance[] })._mcpClients = mcpClients;

    await client.start(command, args);
    const tools = await client.discoverTools();

    let count = 0;
    for (const tool of tools) {
      // 避免重复注册
      if (this.tools.has(tool.name)) {
        logger.warn(`MCP 工具 "${tool.name}" 与已有工具冲突，跳过`);
        continue;
      }
      this.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (params) => {
          const result = await client.callTool(tool.name, params);
          const text = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('\n');
          return {
            success: !result.isError,
            output: text || JSON.stringify(result.content),
          };
        },
      });
      count++;
    }

    logger.info(`从 MCP Server 加载了 ${count} 个工具`);
    return count;
  }

  /**
   * 从 npm 包或本地文件加载工具插件
   * 插件必须导出: { name: string, version: string, register(registry: ToolRegistry): number }
   * @returns 加载的工具数量
   */
  async loadPlugin(pluginPath: string): Promise<number> {
    const plugin = await import(pluginPath);

    if (typeof plugin.register !== 'function') {
      throw new Error(`插件 "${pluginPath}" 未导出 register 函数`);
    }

    const count = await plugin.register(this);
    logger.info(`从插件 "${pluginPath}" 加载了 ${count} 个工具`);
    return count;
  }

  /**
   * 停止所有 MCP 客户端
   */
  stopMcpClients(): void {
    const clients = (this as unknown as { _mcpClients?: Array<{ stop: () => void }> })._mcpClients;
    if (clients) {
      for (const client of clients) {
        client.stop();
      }
      clients.length = 0;
    }
  }

  clear(): void {
    this.tools.clear();
    this.cache.clear();
  }
}

// ---- 参数验证 ----

interface ValidationResult {
  valid: boolean;
  error?: string;
}

function validateParams(params: Record<string, unknown>, schema: JSONSchema): ValidationResult {
  if (!schema.properties) return { valid: true };

  if (schema.required) {
    for (const key of schema.required) {
      if (params[key] === undefined || params[key] === null) {
        return { valid: false, error: `缺少必填参数: ${key}` };
      }
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const value = params[key];
    if (value === undefined) continue;

    const expectedType = propSchema.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (expectedType === 'string' && actualType !== 'string') {
      return { valid: false, error: `参数 ${key} 应为字符串，实际为 ${actualType}` };
    }
    if (expectedType === 'number' && actualType !== 'number') {
      return { valid: false, error: `参数 ${key} 应为数字，实际为 ${actualType}` };
    }
    if (expectedType === 'boolean' && actualType !== 'boolean') {
      return { valid: false, error: `参数 ${key} 应为布尔值，实际为 ${actualType}` };
    }
  }

  return { valid: true };
}

// ---- 单例导出 ----

export const toolRegistry = new ToolRegistry();