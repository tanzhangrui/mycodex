/**
 * V1.4 — 工具注册系统
 * ==========================================
 *
 * 新增：
 * - loadMcpTools: 从 MCP Server 加载外部工具
 * - loadPlugin: 从 npm 包/本地文件加载工具插件
 * - LRU 工具结果缓存（5s TTL，最多 20 条）
 */

import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
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
  /** V4.1 已加载插件（name@version），防重复加载 */
  private loadedPlugins = new Set<string>();
  /** V5.2 工具 → 所属插件（name@version）；卸载插件时按归属清理工具 */
  private toolOwner = new Map<string, string>();
  /** 当前正在注册的插件（loadPlugin 期间设置，register 归属记录用） */
  private currentPlugin: string | null = null;

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册`);
    }
    this.tools.set(tool.name, tool);
    if (this.currentPlugin) {
      this.toolOwner.set(tool.name, this.currentPlugin);
    }
  }

  /**
   * V5.2 卸载插件：移除其注册的全部工具 + 去重标记。
   * @param pluginId name@version（或仅 name——前缀匹配）
   * @returns 移除的工具数量（插件未加载返回 -1）
   */
  unloadPlugin(pluginId: string): number {
    // 精确 id 或 name 前缀匹配（name 不含 @ 时）
    const exact = this.loadedPlugins.has(pluginId);
    const match = exact
      ? pluginId
      : [...this.loadedPlugins].find((id) => id.split('@')[0] === pluginId);
    if (!match) return -1;

    let removed = 0;
    for (const [toolName, owner] of this.toolOwner) {
      if (owner === match) {
        this.tools.delete(toolName);
        this.toolOwner.delete(toolName);
        // 失效该工具的全部缓存条目
        for (const key of this.cache.keys()) {
          if (key.startsWith(`${toolName}:`)) this.cache.delete(key);
        }
        removed++;
      }
    }
    this.loadedPlugins.delete(match);
    logger.info(`已卸载插件 "${match}"（移除 ${removed} 个工具）`);
    return removed;
  }

  /** V5.2 已加载插件 id 列表（name@version） */
  get loadedPluginIds(): string[] {
    return [...this.loadedPlugins];
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
   * 从 npm 包或本地文件加载工具插件（V4.1 开放协议强化）
   * 插件必须导出符合 CodexPlugin 的形状：{ name, version, register(registry) }
   * - 形状校验：name 非空字符串 / version 字符串 / register 函数，不符即抛错（拒绝加载）
   * - 去重：name@version 已加载 → 跳过（返回 0），不因工具名冲突炸掉启动
   * - Windows 兼容：绝对路径经 pathToFileURL 转换
   * @returns 本次实际加载的工具数量
   */
  async loadPlugin(pluginPath: string): Promise<number> {
    const moduleUrl = isAbsolute(pluginPath) ? pathToFileURL(pluginPath).href : pluginPath;
    const mod = (await import(moduleUrl)) as Record<string, unknown> | undefined;
    // 宽容解析三种导出形态：命名导出 plugin / default 导出 / 顶层导出（register 等直接挂模块上）
    const plugin = (mod?.plugin ?? mod?.default ?? mod) as Partial<CodexPlugin> | undefined;

    if (
      !plugin ||
      typeof plugin.name !== 'string' ||
      plugin.name.trim().length === 0 ||
      typeof plugin.version !== 'string' ||
      typeof plugin.register !== 'function'
    ) {
      throw new Error(
        `插件 "${pluginPath}" 不符合 CodexPlugin 协议（需导出 name: string, version: string, register: (registry) => number）`,
      );
    }

    const pluginId = `${plugin.name}@${plugin.version}`;
    if (this.loadedPlugins.has(pluginId)) {
      logger.warn(`插件 "${pluginId}" 已加载，跳过重复加载`);
      return 0;
    }

    const count = await this.withPluginScope(pluginId, async () => await plugin.register!(this));
    this.loadedPlugins.add(pluginId);
    logger.info(`从插件 "${pluginId}" (${pluginPath}) 加载了 ${count} 个工具`);
    return count;
  }

  /** 在插件注册期间标记归属（register 的工具记入 toolOwner） */
  private async withPluginScope(pluginId: string, fn: () => Promise<number>): Promise<number> {
    this.currentPlugin = pluginId;
    try {
      return await fn();
    } finally {
      this.currentPlugin = null;
    }
  }

  /**
   * 批量加载插件（单插件失败不拖累其他）
   * @returns 各插件加载结果（成功数量 / 失败原因）
   */
  async loadPlugins(paths: string[]): Promise<Array<{ path: string; count: number; error?: string }>> {
    const results: Array<{ path: string; count: number; error?: string }> = [];
    for (const p of paths) {
      try {
        const count = await this.loadPlugin(p);
        results.push({ path: p, count });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(`插件 "${p}" 加载失败: ${error}`);
        results.push({ path: p, count: 0, error });
      }
    }
    return results;
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
    this.loadedPlugins.clear();
    this.toolOwner.clear();
  }
}

// ---- V4.1 插件开放协议 ----

/**
 * 第三方工具插件协议（开放给插件作者）。
 * 插件模块必须默认导出或命名导出符合本接口的对象：
 *
 * ```ts
 * export const plugin: CodexPlugin = {
 *   name: 'my-tools',
 *   version: '1.0.0',
 *   register(registry) {
 *     registry.register({ name: 'my_tool', description: '...', parameters: {...}, execute: async () => {...} });
 *     return 1;
 *   },
 * };
 * ```
 */
export interface CodexPlugin {
  /** 插件名（非空，与 version 组成去重键） */
  name: string;
  /** 语义化版本 */
  version: string;
  /** 注册工具；返回注册的工具数量 */
  register: (registry: { register: (tool: RegisteredTool) => void }) => number | Promise<number>;
}

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