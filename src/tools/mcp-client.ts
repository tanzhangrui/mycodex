/**
 * V1.4 — MCP (Model Context Protocol) 客户端
 * ==========================================
 *
 * 实现 MCP Client（stdio 模式），通过 JSON-RPC 2.0 与 MCP Server 通信。
 * 支持动态发现和调用外部工具。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ToolDefinition } from '../utils/ai-client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-client');

// ---- JSON-RPC 2.0 类型 ----

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---- MCP 工具定义 ----

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ---- MCP Client ----

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private responseHandlers = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private _ready = false;

  get isRunning(): boolean {
    return this._ready && this.process !== null && !this.process.killed;
  }

  /**
   * 启动 MCP Server 子进程
   */
  async start(command: string, args: string[] = []): Promise<void> {
    if (this.process) {
      throw new Error('MCP Server 已在运行');
    }

    return new Promise((resolve, reject) => {
      const [cmd, ...cmdArgs] = command.split(/\s+/);
      this.process = spawn(cmd, [...cmdArgs, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });

      const rl = createInterface({ input: this.process.stdout! });

      rl.on('line', (line: string) => {
        try {
          const response: JsonRpcResponse = JSON.parse(line);
          const handler = this.responseHandlers.get(response.id);
          if (handler) {
            this.responseHandlers.delete(response.id);
            if (response.error) {
              handler.reject(new Error(`MCP 错误: ${response.error.message} (code: ${response.error.code})`));
            } else {
              handler.resolve(response.result);
            }
          }
        } catch {
          // 跳过非 JSON 行
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        logger.warn(`MCP Server stderr: ${data.toString().trim()}`);
      });

      this.process.on('error', (err) => {
        logger.error(`MCP Server 进程错误: ${err.message}`);
        this._ready = false;
        reject(err);
      });

      this.process.on('exit', (code) => {
        logger.info(`MCP Server 退出，code: ${code}`);
        this._ready = false;
        this.process = null;
        // 清理所有待处理的 handler
        for (const [, handler] of this.responseHandlers) {
          handler.reject(new Error(`MCP Server 意外退出，code: ${code}`));
        }
        this.responseHandlers.clear();
      });

      // 初始化握手：发送 initialize 请求
      this.sendInitialize()
        .then(() => {
          this._ready = true;
          logger.info(`MCP Server 已启动: ${command} ${args.join(' ')}`);
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * 发送 initialize 方法（MCP 协议握手）
   */
  private async sendInitialize(): Promise<void> {
    // MCP 初始化不需要参数
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex', version: '1.4.0' },
    });

    // 发送 initialized 通知
    this.sendNotification('initialized', {});
  }

  /**
   * 发现 MCP Server 暴露的工具列表
   */
  async discoverTools(): Promise<ToolDefinition[]> {
    if (!this._ready) {
      throw new Error('MCP Server 未就绪');
    }

    const result = await this.sendRequest('tools/list', {}) as { tools: McpTool[] };

    return (result.tools || []).map((tool: McpTool) => ({
      name: tool.name,
      description: tool.description || `MCP 工具: ${tool.name}`,
      parameters: {
        type: tool.inputSchema.type || 'object',
        properties: tool.inputSchema.properties as Record<string, unknown> | undefined,
        required: tool.inputSchema.required,
      },
    }) as unknown as ToolDefinition);
  }

  /**
   * 调用 MCP Server 的工具
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this._ready) {
      throw new Error('MCP Server 未就绪');
    }

    return (await this.sendRequest('tools/call', {
      name,
      arguments: args,
    })) as McpToolResult;
  }

  /**
   * 发送 JSON-RPC 请求
   */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.responseHandlers.set(id, { resolve, reject });

      // 超时 30 秒
      setTimeout(() => {
        if (this.responseHandlers.has(id)) {
          this.responseHandlers.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30_000);

      this.send(request);
    });
  }

  /**
   * 发送 JSON-RPC 通知（不需要响应）
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    } as unknown as JsonRpcRequest);
  }

  /**
   * 发送原始消息到 stdin
   */
  private send(message: JsonRpcRequest): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('MCP Server 进程不可用');
    }
    const line = JSON.stringify(message) + '\n';
    this.process.stdin.write(line);
  }

  /**
   * 关闭 MCP Server 子进程
   */
  stop(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // 进程可能已经退出
      }
      this.process = null;
      this._ready = false;
      this.responseHandlers.clear();
      logger.info('MCP Server 已停止');
    }
  }
}