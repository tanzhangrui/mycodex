# Codex 迭代日志（CHANGELOG）

> 记录从最初版本到当前的每一次迭代。格式：版本 / 日期 / 主题 / 详细变更 / 验收结果。
> 产品宪法：`AI-IDE-MASTER-PROMPT.md`；迭代纲领：`V3.1-ITERATION-PROMPT.md`。

---

## V3.1 — 2026-08-18 — 信任 × 上下文 × 可靠性 三大闭环

> 首个 git 版本控制起点（`git init`，此前无版本历史）。
> 纲领文档：`V3.1-ITERATION-PROMPT.md`（PM/架构师/CTO/首席科学家四视角差距分析）。

### 迭代 A — 信任地基（commit `8bb2000`）
- **会话持久化**：消息历史（上限 40 条，单条 8K 截断）+ token/成本存 `globalState`，VSCode 重启自动回放
- **欢迎页**：空状态品牌引导 + 3 个快捷任务（解释当前文件 / 编写测试 / 代码审查）+ 快捷键提示
- **任务排队**：Agent 运行中发消息自动排队一条、完成后自动接续，不再报错打断心流
- **OutputChannel 日志**：「Codex IDE」输出通道，错误可诊断，全程无密钥
- 验收：双侧 typecheck 零错误 / 74 测试全绿 / 打包 507.3KB / 前端语法校验通过

### 迭代 B — 上下文工程（commit `753ead1` + 清理 `71d2f72`）
- **@文件引用**：消息中 `@相对路径` 精确圈定上下文（隐私守卫生效、单文件 4K 截断、上限 3 个）——廉价模型上下文弱，用精确引用补齐
- **诊断注入**：「修复选中代码」自动附带选区范围内 Problems 面板的 error/warning，提升一次修复率
- **修复 inline 编辑取消无效**：`streamOnce` 独立 AbortController；取消同时清空排队任务
- 事故记录：cmd 内联脚本引号问题产生垃圾文件 `p.test(f)))` 并误提交，已在 `71d2f72` 彻底清除；此后提交一律使用 `-F` 消息文件 + 提交前敏感扫描脚本
- 验收：双侧 typecheck 零错误 / 打包 508.9KB 通过

### 迭代 C — 可靠性闭环（commit `8c49f0a`）
- **检查点回滚（时间旅行）**：`InMemoryFileSystem.createCheckpoint/restoreCheckpoint/rebaseAgainstDisk`；每轮任务前自动存档（上限 20 轮）；面板 ⟲ 按钮逐轮回滚；已写盘变更经 rebase 重新标脏，可再次「全部应用」写回磁盘——"预览 ✓ 应用 ✓ 回滚 ✓"信任闭环完成
- **失败自适应升档**：auto 模式下免费档调用失败 → 自动升级 DeepSeek 重试一次（最小反馈回路，仅 free 档可升，防账单失控）
- **流式重试核验**：核心 `openai-compatible` 已具备 429/5xx/网络错误指数退避重试（×3 尝试）
- **新增 14 项测试**：检查点 4 项 + 预设/成本/复杂度/升档 10 项
- 验收：双侧 typecheck 零错误 / **88 测试全绿** / 打包 511.6KB / 前端语法通过

### 工程基础设施
- `git init` + 根提交 `410ac4e`（56 文件，14,352 行），提交前敏感文件扫描全零命中
- `chat.js` 字面 NUL 字节修复（`3ce339c`），恢复标准 UTF-8 文本可 diff
- `.gitignore` 增补 `codex-ide/.vscode/launch.json` 例外（保留 F5 调试配置）

---

## V3.2 — 2026-08-30 — 上下文引擎：让廉价模型"看得准"

> 纲领文档：`V3.2-ITERATION-PROMPT.md`（对照 Cursor @codebase / Claude Code 自动相关文件收集 / Aider repo-map）。
> 核心命题：廉价模型与旗舰模型的差距很大一部分在**喂给它的上下文质量**——本轮把上下文从"文件名关键词匹配"升级为"符号 + 依赖图 + 预算"三引擎。

### 三路召回融合（`src/context/context-engine.ts` 全面重写，终结 @deprecated 预留状态）
- **符号索引**：零依赖正则近似 AST（TS/JS/TSX/JSX/Python 的 class/function/method/interface/type/const + 行号）；查询提到函数/类名 → 直接定位定义处 ±20 行 chunk（相关性 100 分层，远高于关键词命中）；惰性构建 + LRU 缓存
- **import 图自动相关文件收集**：解析相对 import/require/from（扩展名 + index 文件探测）→ 文件级依赖图 BFS；修改某文件时其直接依赖的头部 60 行自动进入上下文（跨文件改动不再漏改调用点）
- **大仓库懒加载**：扫描阶段只 stat 零内容读取；文件内容/符号/imports 全部按需读取 + LRU(200)；>200 文件时关键词召回只读 top-20 候选；符号索引 3000 文件 / 单文件 512KB 上限
- **agent-loop 集成**：系统提示词自动注入 `<project_context>`（8K token 预算，以最后一条用户消息为查询）；引擎失败静默降级，绝不阻断 Agent 主循环
- **隐私红线修复**：原扫描代码 `entry !== '.env'` 特殊放行导致 `.env` 前 500 字符进入可检索索引——现复用 `privacy-guard.isSensitivePath`，敏感文件（.env*/私钥/凭据）绝不入索引；`.env` 移出文本扩展名白名单
- **修复 findBestChunk 短文件盲区**：原滑动窗口循环在文件行数 < 30 时完全不执行，短文件永不命中
- 新增 20 项测试：符号提取（TS/Python/控制流误报）/ 符号定位 / import 解析与 BFS / 三路召回 / 预算裁剪 / 去重 / 懒加载 / 隐私拦截（密钥不泄漏到任何上下文产出）/ 提示词注入
- 验收：双侧 typecheck 零错误 / **108 测试全绿**（88 + 20）/ CLI 打包 77.6KB / 扩展打包 524.0KB

---

## V3.0 — 2026-08-04 — 双形态诞生：CLI 内核 + VSCode 扩展

> 战略转折点：从纯 CLI 进化为深度嵌入 VSCode 的 AI IDE。
> 产品宪法 `AI-IDE-MASTER-PROMPT.md` 确立："模型是商品，编排是壁垒"。

### 核心层（CLI 与 IDE 共享）
- **隐私守卫**（`src/core/privacy-guard.ts`）：四层物理隔离——
  ① memfs 快照剔除 `.env*`/私钥/证书/凭据（修复了 `.env` 原本在可读白名单内的真实泄漏面）
  ② 文件工具 read/write/edit 对敏感路径显式拒绝
  ③ 沙箱拦截引用敏感文件/密钥变量的命令（`cat .env`、`echo $GLM_API_KEY` 等）
  ④ 子进程环境净化（剥离 `*_API_KEY`/`*_TOKEN`/`*_SECRET`，防 curl 外泄）
- **既有类型错误清零**：8 处历史遗留 TS 错误修复（ai-client 字面量类型、McpClient 动态导入类型、context-engine 导入缺失等）
- 新增 17 项隐私守卫测试

### Codex IDE 扩展（`codex-ide/`，全新）
- **侧栏 AI 聊天**：零框架 Webview，流式渲染、轻量 Markdown、代码复制、工具调用可视化
- **模型矩阵与自动成本路由**：9 预设（GLM-4.7-flash 免费 / DeepSeek-V3·R1 / GLM-4.6 / Qwen-Plus / Kimi K2 / 硅基流动免费档 / Ollama 本地 / Claude Sonnet）；简单任务走免费档，复杂任务自动升级低价档
- **编辑器深度集成**：`Ctrl+I` 内联编辑（diff 预览→应用/拒绝）、右键解释/修复/重构、原生 `vscode.diff` 逐文件预览、全部应用/拒绝
- **成本透明**：状态栏实时 token + ¥ 估算；`costBudgetCny` 预算熔断
- **密钥安全**：SecretStorage 系统级加密 > 环境变量 > `.env` 只读解析；Key 永不落盘明文、永不出现在日志/UI
- 验收：74/74 测试 / typecheck 零错误 / 打包 505.7KB/65ms

---

## V2.0 — 产品化版本（CLI）
- Ink UI 代码高亮 + diff 彩色输出
- `/save` 会话保存、`codex update` 自动更新检查
- 独立二进制分发（`build:binary`）
- 性能基准测试（冷启动 <1ms / 千文件快照 ~32ms / 工具缓存 <0.1ms）

## V1.5 — 会话韧性
- 会话崩溃恢复（锁文件检测 + `--resume`）
- AI 回复代码块 ANSI 语法高亮

## V1.4 — 生态与扩展性
- MCP 协议兼容（JSON-RPC 2.0 over stdio）
- 插件系统（npm 包/本地文件动态加载）
- 子 Agent 委派（tool_use > 5 自动并行）
- 流式重试机制（429/5xx/连接失败）

## V1.3 — 智能化与安全性
- 多模型智能路由（简单→GLM 免费，复杂→Claude）
- CODEX.md 项目规则注入
- 安全沙箱（命令白名单 + 危险模式检测）
- 结构化日志、并行工具执行 + LRU 缓存、AbortSignal、Token 统计

## V1.2 — 多 Provider 架构
- Anthropic / OpenAI Compatible / Local / Mock 四通道
- 并行工具执行 + 工具结果缓存

## V1.0 — 基石
- Agent 自主循环 + 7 个内置工具
- 内存文件系统 + diff 预览 + 确认写入
- 交互式 Ink UI + 纯文本回退

---

## 路线图（下一步）

| 版本 | 主题 | 关键项 |
|---|---|---|
| V3.3 | 补全与终端 | 本地 FIM Tab 补全（Ollama 1.5B，6G 显存可跑）、终端命令自然语言化 |
| V3.4 | 上下文进阶 | 向量/语义检索、索引持久化与增量更新、IDE 侧 @codebase 入口复用 CLI 引擎 |
| V4.0 | 多智能体 | Planner/Editor/Tester 分工（全部可用廉价模型驱动）、插件市场 |
