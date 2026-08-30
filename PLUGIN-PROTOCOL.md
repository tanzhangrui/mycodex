# Codex 插件协议（v1）

> 适用：codex ≥ V4.1。协议实现：`src/tools/registry.ts`；示例插件：`examples/plugins/echo-tools.mjs`。

## 插件形状

插件是一个 ES 模块（`.mjs`/`.js`，或经打包器输出的 CJS），导出符合以下形状的对象：

```ts
interface CodexPlugin {
  name: string;     // 非空，与 version 组成去重键 name@version
  version: string;  // 语义化版本建议（不强校验）
  register: (registry: { register: (tool: RegisteredTool) => void }) => number | Promise<number>;
}
```

三种导出形态均被接受（宽容解析）：

```js
export const plugin = { name, version, register };  // 推荐：命名导出
export default { name, version, register };         // default 导出
export const name = '…', version = '…';             // 顶层导出（register 挂模块上）
```

## 工具形状

```ts
interface RegisteredTool {
  name: string;         // 全局唯一；与内置工具冲突会在加载时抛错
  description: string;  // 给模型看的用途说明（写得越具体，模型调用越准）
  parameters: JSONSchema; // OpenAI function-calling 格式
  execute: (params, context: ToolContext) => Promise<ToolResult>;
}
```

`ToolContext` 提供：`workingDir` / `readFile` / `writeFile`（内存 FS，落盘走信任闭环）/ `listFiles` / `searchContent` / `confirm`（用户确认回调）/ `executeCommand`（沙箱内）。

`ToolResult`：`{ success, output, data?, error? }`。

## 加载语义

| 规则 | 行为 |
|---|---|
| 形状校验失败 | 拒绝加载，抛错（`loadPlugins` 批量下不拖累其他插件） |
| `name@version` 重复 | 跳过，返回 0 |
| 同名新版本 | 允许再次加载（工具名冲突由插件作者负责规避） |
| 无副作用工具 | 结果享受 5s TTL / 20 条 LRU 缓存 |
| 路径 | 绝对路径自动经 `pathToFileURL`（Windows 兼容） |

## 使用

```bash
# 直接加载（代码）
await toolRegistry.loadPlugin('./examples/plugins/echo-tools.mjs');

# 配置加载（~/.codex/config.json）
{ "plugins": ["C:/abs/path/echo-tools.mjs"] }
```

## 安全边界

- 插件代码在**宿主进程**执行——只安装你信任来源的插件（与 npm 同级信任模型）
- 工具写文件只进内存 FS，落盘必须经用户 `/apply` 确认
- 命令执行经沙箱 + 危险命令拦截 + 用户确认
- 市场远程自动下载执行**刻意未实现**（供应链安全设计——签名/校验和——单独版本交付）

## 市场索引（v1）

见 `examples/marketplace-index.json`：静态 JSON 托管任意处（GitHub raw / 内网），`src/tools/marketplace.ts` 负责解析与安装。
