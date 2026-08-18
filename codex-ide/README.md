# Codex IDE — 零成本 AI 编程助手（VSCode 扩展）

> 用免费/极致低价模型跑出旗舰 IDE 体验。产品纲领见根目录 `AI-IDE-MASTER-PROMPT.md`。

## 核心卖点

| 特性 | 说明 |
|---|---|
| **自动成本路由** | 简单任务 → GLM-4.7-flash（¥0）；复杂任务 → DeepSeek（约旗舰 1/30 价）；免费档失败自动升档重试 |
| **隐私物理隔离** | `.env` / 私钥 / 证书对 Agent 不可读、不可搜、不可写；沙箱命令拦截 + 子进程环境净化 |
| **密钥安全** | API Key 存 VSCode SecretStorage（系统级加密），永不写入配置文件 |
| **成本透明** | 状态栏实时显示 token 与估算成本（¥），支持预算熔断 |
| **Trae 式融合** | 侧栏 AI 聊天 + Ctrl+I 内联编辑 + 右键解释/修复/重构 + 原生 diff 预览 |
| **会话持久化** | 重启 VSCode 对话不丢，自动回放历史 |
| **检查点回滚** | 每轮任务前自动存档，⟲ 逐轮时间旅行，已写盘也可回滚写回 |
| **@文件引用** | 消息中 `@路径` 精确圈定上下文（隐私守卫生效） |
| **诊断注入** | 修复选区自动附带 Problems 面板错误线索 |
| **任务排队** | 运行中发消息自动排队接续，不打断心流 |

## 安装与调试

```bash
cd codex-ide
npm install
npm run build        # 产出 dist/extension.js（约 500KB，含 Agent 引擎）
```

然后：

- **调试**：用 VSCode 打开本目录（`codex-ide/`），按 `F5` 启动扩展开发宿主
- **打包安装**：`npx @vscode/vsce package` 生成 `.vsix`，再 `code --install-extension codex-ide-0.1.0.vsix`

## 使用

1. 点击活动栏 **Codex IDE** 图标打开 AI 助手
2. 点击 🔑 设置 API Key（自动路由默认用 GLM 免费档，[免费申请](https://open.bigmodel.cn/)）
3. 对话中让 AI 修改代码 → 底部出现"待应用变更" → 逐文件 Diff 预览 → 全部应用/拒绝
4. 编辑器中选中代码：`Ctrl+I` 内联编辑；右键 → Codex 解释/修复/重构
5. 点击状态栏模型名随时切换模型 / 查看成本

## 模型矩阵

| 档位 | 模型 | 成本 | 适用 |
|---|---|---|---|
| 免费 | GLM-4.7-flash / 硅基流动 Qwen2.5-7B | ¥0 | 日常 80% 任务 |
| 低价 | DeepSeek-V3 / R1、Qwen-Plus、Kimi K2 | ¥0.8-16/M tok | 复杂重构、架构 |
| 本地 | Ollama qwen2.5-coder:7b | ¥0（离线） | 隐私最强场景 |
| 旗舰 | Claude Sonnet | 高 | 仅显式启用 |

## 与 CLI 的关系

`codex-ide` 与根目录 CLI（`codex chat`）**共享同一 Agent 引擎**（`../src/core`），
任何核心改进双端生效。核心代码保持 VSCode 无关，IDE 专属代码只在本目录。

## 设置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `codex-ide.activePreset` | `auto` | 模型预设，auto = 自动路由 |
| `codex-ide.autoRoute` | `true` | 复杂任务自动升级低价强模型 |
| `codex-ide.costBudgetCny` | `0` | 会话成本预算（元），0=不限，达到即熔断 |
