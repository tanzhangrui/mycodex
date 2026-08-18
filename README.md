# Codex — 顶级 CLI AI 编程工具

> 对标并超越 Claude Code 的终端 AI 编程助手。所有交互在终端内完成，性能优先。

## 快速开始

### 环境要求

- **Node.js** >= 20.0.0
- **npm** >= 9.0.0

### 安装

```bash
# 1. 进入项目目录
cd codex

# 2. 安装依赖
npm install

# 3. 构建项目
npm run build

# 4. （可选）全局安装到系统
npm link
```

### 启动

```bash
# 交互式对话（TTY 模式，Ink 渲染 UI）
codex chat

# 管道输入模式（适合脚本/CI）
echo "列出文件" | codex chat

# 纯文本模式（自动回退）
codex chat < input.txt
```

## 配置 API Key

### 多 Provider 支持

Codex V2.0 支持多种 AI Provider：

| Provider | 模型 | 费用 | 说明 |
|----------|------|------|------|
| `openai-compatible` | GLM-4.7-flash | **免费** | 智谱 AI 提供，适合简单任务 |
| `anthropic` | Claude Sonnet 4 | 付费 | 强大推理能力，适合复杂任务 |
| `local` | Ollama 本地模型 | 免费 | 完全离线运行 |
| `mock` | 模拟回复 | 免费 | 无 API Key 时的降级模式 |

### 配置文件（`~/.codex/config.json`）

```json
{
  "provider": "openai-compatible",
  "providers": {
    "anthropic": {
      "apiKey": "",
      "model": "claude-sonnet-4-20250514",
      "maxTokens": 4096
    },
    "openai-compatible": {
      "apiKey": "",
      "baseURL": "https://open.bigmodel.cn/api/paas/v4",
      "model": "glm-4.7-flash",
      "maxTokens": 4096
    },
    "local": {
      "baseURL": "http://localhost:11434/v1",
      "model": "qwen2.5-coder:7b",
      "maxTokens": 4096
    }
  }
}
```

### 使用 .env 文件（推荐）

在项目目录创建 `.env` 文件：

```bash
# 免费模型：智谱 GLM-4.7-flash（推荐）
GLM_API_KEY=your_glm_api_key_here
# 可选：GLM_MODEL=glm-4.7-flash
# 可选：GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# 付费模型：Anthropic Claude（可选）
# ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxx
# ANTHROPIC_MODEL=claude-sonnet-4-20250514

# 本地模型：Ollama（可选）
# OLLAMA_BASE_URL=http://localhost:11434/v1
# OLLAMA_MODEL=qwen2.5-coder:7b
```

### GLM-4.7-flash 免费模型使用说明

1. 访问 [https://open.bigmodel.cn/](https://open.bigmodel.cn/) 注册账号
2. 在控制台获取 API Key
3. 在 `.env` 文件中设置 `GLM_API_KEY=你的key`
4. 启动 Codex：`codex chat`
5. Codex 将自动使用 GLM-4.7-flash 进行简单任务，复杂任务自动切换（如有 Claude Key）

获取 Anthropic API Key: [https://console.anthropic.com/](https://console.anthropic.com/)

> **未配置任何 API Key 时自动使用 Mock 模式**，可体验工具调用功能。

## 功能特性

### V2.0 新特性 — 产品化版本

| 特性 | 说明 |
|------|------|
| **Ink UI 代码高亮** | TTY 模式下 AI 回复代码块 ANSI 语法高亮 |
| **diff 颜色高亮** | `/diff` 命令在 Ink UI 和纯文本模式均显示彩色输出 |
| **会话保存** | `/save` 命令保存完整会话到磁盘 |
| **自动更新** | 启动时检查更新，`codex update` 手动检查 |
| **独立二进制分发** | `build:binary` 构建独立可执行文件 + 启动脚本 |
| **性能基准** | 内置 benchmark 测试（冷启动/快照/缓存） |
| **会话崩溃恢复** | 终端异常退出后重启提示恢复，`--resume` 恢复 |
| **MCP 协议兼容** | JSON-RPC 2.0 over stdio，加载外部 MCP Server 工具 |
| **插件系统** | npm 包 / 本地文件动态加载工具插件 |
| **子 Agent 委派** | tool_use > 5 时自动子 Agent 并行处理 |
| **流式重试** | 网络错误自动重试（429/5xx/连接失败） |

### 核心架构

| 模块 | 说明 |
|------|------|
| **Agent 循环** | 自主任务规划 → 工具调用 → 结果处理 → 持续循环 |
| **内存文件系统** | 所有修改先写入内存，确认后通过 `/apply` 写入磁盘 |
| **安全沙箱** | 命令白名单 + 危险模式检测 + 超时控制 |
| **模型路由** | 根据任务复杂度自动选择最优模型 |

### 内置工具（7 个）

| 工具 | 功能 | 示例 |
|------|------|------|
| `read_file` | 读取文件内容（支持行范围） | `read_file("src/index.ts", 1, 50)` |
| `write_file` | 创建或覆盖文件 | `write_file("hello.js", "console.log('hi')")` |
| `edit_file` | 精确编辑文件（search/replace） | `edit_file("a.ts", "old", "new")` |
| `search_content` | 搜索代码内容（正则） | `search_content("function", ".", "*.ts")` |
| `list_files` | 列出目录结构 | `list_files(".", 3)` |
| `run_command` | 执行 shell 命令（沙箱） | `run_command("node -v")` |
| `run_script` | 执行 JS 代码片段（沙箱） | `run_script("console.log(1+1)")` |

### 交互命令

在对话中可用以下命令：

| 命令 | 功能 |
|------|------|
| `/apply` | 将所有内存修改写入磁盘 |
| `/diff` | 预览所有未保存的变更 |
| `/status` | 查看文件修改状态 |
| `/clear` | 清空对话历史 |
| `/exit` | 退出程序 |

## 使用示例

### 基础交互

```bash
$ codex chat
Codex v1.3.0 — 自动路由 (简单→GLM, 复杂→Claude)
> 列出当前目录的文件
Codex: [GLM-4.7-flash (自动选择)] 让我列出当前目录的文件...
  ⚙ list_files({"path":".","depth":2}...) ✓ 目录: . (34 个项目)

> 创建一个 hello.js 文件
Codex: 好的，让我创建 hello.js...
  ⚙ write_file({"path":"hello.js",...}) ✓ 已创建文件: hello.js

> 重构整个模块架构
Codex: [Claude (自动选择)] 这是一个复杂的架构任务...
```

### 指定 Provider

```bash
# 强制使用 Anthropic
codex chat --provider anthropic

# 强制使用 GLM
codex chat --provider openai-compatible
```

### 项目规则

在工作目录创建 `CODEX.md` 文件，Codex 会自动加载为项目规则：

```markdown
# CODEX.md
本项目使用 TypeScript 严格模式。
所有 API 调用需要错误处理。
不要使用 any 类型。
```

用户级规则放在 `~/.codex/CODEX.md`。

### 日志级别

```bash
# 调试模式（显示所有日志）
LOG_LEVEL=debug codex chat

# 仅显示错误
LOG_LEVEL=error codex chat
```

### 会话恢复

```bash
# 终端崩溃后重启，Codex 会检测到上次会话异常退出
# 提示：使用 --resume 恢复上次会话
codex chat --resume

# 锁文件位置: ~/.codex/.codex.lock
# 手动删除锁文件可跳过恢复提示
```

### 二进制分发

```bash
# 构建独立二进制（需要 Node.js v20+）
npm run build:binary

# 输出在 bin/ 目录：
#   bin/codex.exe (Windows)
#   bin/codex     (Linux/macOS)
# 如果 Node.js < 20，自动回退到启动脚本
```

### 性能基准

```bash
# 运行性能基准测试
npm test -- tests/benchmark.test.ts

# 基准数据（典型值）：
#   冷启动:       < 1ms
#   1000 文件快照:  ~32ms
#   1000 消息裁剪:  < 1ms
#   工具缓存命中:    < 0.1ms
#   工具注册查找:   < 0.1ms
```

### MCP Server（外部工具）

```bash
# 加载文件系统 MCP Server
codex chat --mcp "npx -y @anthropic/mcp-server-filesystem ."

# 在配置文件中预设 MCP Server
# ~/.codex/config.json:
{
  "mcpServers": [
    { "command": "npx", "args": ["-y", "@anthropic/mcp-server-filesystem", "."] }
  ]
}
```

### 插件系统

```javascript
// 插件示例: my-plugin.js
export const name = 'my-plugin';
export const version = '1.0.0';

export function register(registry) {
  registry.register({
    name: 'my_tool',
    description: '我的自定义工具',
    parameters: { type: 'object', properties: {} },
    execute: async (params) => {
      return { success: true, output: 'Hello from plugin!' };
    },
  });
  return 1; // 返回注册的工具数量
}

// 在配置文件中启用插件
// ~/.codex/config.json:
{
  "plugins": ["./my-plugin.js"]
}
```

## 项目结构

```
codex/
├── src/
│   ├── index.ts              # CLI 入口
│   ├── cli/
│   │   ├── app.tsx            # Ink UI 组件
│   │   └── text-repl.ts       # 纯文本模式 REPL
│   ├── config/
│   │   └── config.ts          # 配置管理
│   ├── core/
│   │   ├── agent-loop.ts      # Agent 循环调度器
│   │   ├── in-memory-fs.ts    # 内存文件系统
│   │   ├── message-manager.ts # 消息管理器
│   │   └── model-router.ts    # 多模型智能路由
│   ├── sandbox/
│   │   └── sandbox.ts         # 安全沙箱执行
│   ├── tools/
│   │   ├── registry.ts        # 工具注册系统（含缓存）
│   │   └── builtin.ts         # 7 个内置工具
│   └── utils/
│       ├── ai-client.ts       # AI Provider 接口
│       └── logger.ts          # 结构化日志系统
├── tests/                     # 测试文件
├── build.mjs                  # 构建脚本
├── tsconfig.json              # TypeScript 配置
├── package.json               # 项目配置
└── README.md                  # 本文件
```

## 开发

```bash
# 类型检查
npm run typecheck

# 构建（开发模式，含 sourcemap）
node build.mjs --dev

# 构建（生产模式，minified）
node build.mjs

# 监听模式
node build.mjs --watch

# 运行测试
npm test
```

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript 5.x | 类型安全 |
| Ink 5.x | CLI 交互式 UI |
| React 18.x | Ink 渲染引擎 |
| @anthropic-ai/sdk | AI 模型集成 |
| esbuild | 构建打包 |
| Vitest | 单元测试 |

## 版本历史

### V2.0.0 — 产品化版本
- Ink UI 代码高亮 + diff 彩色输出
- `/save` 会话保存命令
- 自动更新检查（`codex update`）
- 独立二进制分发（`npm run build:binary`）
- 性能基准测试

### V1.5.0
- 会话崩溃恢复（锁文件检测 + --resume 恢复）
- AI 回复代码块 ANSI 语法高亮
- 移除未使用的 tsup 依赖

### V1.4.0
- MCP 协议兼容（JSON-RPC 2.0 over stdio）
- 插件系统（npm 包 / 本地文件动态加载）
- 子 Agent 委派（tool_use > 5 自动委派）
- 流式重试机制（网络错误自动重试）
- diff 颜色高亮（ANSI 颜色输出）
- 死代码清理（context-engine 标记 deprecated）

### V1.3.0
- 多模型智能路由（简单任务→GLM 免费，复杂任务→Claude）
- CODEX.md 项目规则注入
- 安全沙箱执行（命令白名单 + 危险模式检测）
- 结构化日志系统（支持 LOG_LEVEL）
- 并行工具执行 + 工具结果缓存
- AbortSignal 支持（Ctrl+C 中断 API 请求）
- Token 用量统计

### V1.2.0
- 多 Provider 架构（Anthropic / OpenAI Compatible / Local / Mock）
- 并行工具执行 + LRU 工具缓存
- AbortSignal 支持
- Token 用量统计

### V1.0.0
- 完整的 Agent 自主循环 + 7 个内置工具
- 内存文件系统 + diff 预览 + 确认写入
- 安全沙箱执行（命令白名单 + 超时控制）
- 交互式 Ink UI + 纯文本模式回退

## License

MIT