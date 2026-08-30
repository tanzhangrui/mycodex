# Codex 迭代日志（CHANGELOG）

> 记录从最初版本到当前的每一次迭代。格式：版本 / 日期 / 主题 / 详细变更 / 验收结果。
> 产品宪法：`AI-IDE-MASTER-PROMPT.md`；迭代纲领：`V3.1-ITERATION-PROMPT.md`。

---

## V4.2 — 2026-08-30 — 验证增强：可配置 Verifier + 步骤级回滚

> 纲领文档：`V4.2-ITERATION-PROMPT.md`。补强 V4.0 编排闭环的两个已知短板。

### A. Verifier 可配置
- `CodexConfig.planVerifyCommand`（默认 `npx tsc --noEmit` 不变）：测试驱动项目可配 `vitest run`，lint 严格项目可配 eslint
- `OrchestratorOptions.verifyCommand` 注入默认验证器；CLI `/plan` 从配置透传

### B. 步骤级回滚（接入 V3.1 检查点）
- 每步执行前 `fs.createCheckpoint()`；重试耗尽 → `fs.restoreCheckpoint()` 回滚到步骤开始前
- **失败回滚，成功保留**：失败产物未过验证 = 带病，绝不进入 `/apply` 写盘通道；成功产物已过验证 = 可信
- **重试不回滚**：保留上次尝试的编辑，让模型在现状上修复（这正是"修复"语义）
- `StepOutcome.rolledBack` 标记；CLI 汇报显示「本步骤修改已回滚」；回滚只动内存 FS，磁盘状态不变

### 验收
- 新增 4 项测试：失败回滚（半成品撤销 + FS 不脏）/ 成功保留（产物 dirty 等 /apply）/ 前序成功产物在后续失败后保留 / verifyCommand 透传
- 双侧 typecheck 零错误 / **173 测试全绿**（169 + 4）/ CLI 打包 88.6KB / 扩展打包 535.6KB

---

## V4.0 — 2026-08-30 — 多智能体编排（Planner / Editor / Verifier）

> 纲领文档：`V4.0-ITERATION-PROMPT.md`（对照 Claude Code 计划-执行模式 / Cursor 多步任务编排）。
> 核心命题：廉价模型单循环容易"一口气做完然后走偏"——用编排把大任务拆成小步，每步验证，错了当场反馈重试。
> 诚实边界：三个角色由**同一廉价模型**驱动（区别只在提示词与职责上下文，不引入额外 API 成本）；
> Verifier 是**确定性 typecheck 命令**而非模型自评（廉价模型评自己 = 假验证）。插件市场明确不在本轮（推到 V4.1）。

### A. Planner 任务拆解（`src/core/planner.ts`）
- 单次廉价模型纯文本调用（provider.stream，不挂工具）→ 严格 JSON 步骤输出
- **容错解析是一等公民**：```json 围栏剥离 → 首末大括号子串 → 整体，三级尝试；形状校验（非空字符串数组）+ 非法项过滤 + 步数上限 8（步骤过多 = 规划幻觉信号）
- 空步数组 / 垃圾输出 / provider 抛错 → 统一返回 null（调用方降级，绝不向上传播）

### B. Orchestrator 编排闭环（`src/core/orchestrator.ts`）
- **逐步执行**：每步构建步骤作用域消息（计划概览 + 本步定位 + 前序结果摘要），复用 `runAgentLoop` 内核（Editor 角色）
- **每步验证**：默认 `npx tsc --noEmit`（沙箱执行）；无沙箱跳过、验证器自身故障不阻塞（验证是增强不是依赖）
- **失败反馈重试**：验证失败 → 错误输出注入 `<verify_failure>` 消息 → 重试 1 次；仍失败 → 步骤标记 failed 且**终止后续步骤**（带病执行 = 浪费 token 产出错误结果）
- **降级路径**：计划解析失败 → 静默回退单循环 runAgentLoop
- 编辑全部写入内存 FS——计划执行中途不落盘，`/diff` 预览、`/apply` 写盘的信任闭环不变
- `looksComplex` 启发式（多步信号词 + 长度阈值）导出备用；入口只做显式 `/plan`（不隐式触发：误判 = 多花钱 + 交互不可预期）

### C. CLI 入口（`src/cli/text-repl.ts`）
- `/plan <任务>`：生成计划 → 逐步执行 → 步骤状态汇报（✓/✗ + 重试次数 + 验证错误摘要）；流式回调提取为工厂（普通消息与 /plan 共用增量高亮）

### 验收
- 新增 18 项测试：解析容错（裸 JSON/围栏/散文/步数裁剪/垃圾→null）/ createTaskPlan（合法/垃圾/抛错）/ 启发式 / 编排闭环（成功、失败重试、耗尽终止、降级、步骤消息上下文）
- **测试卫生修复**：e2e/benchmark/orchestrator 测试隔离 `CODEX_CONFIG_PATH`——V3.4 持久化上线后，跑 agent-loop 的测试进程会把索引缓存写进真实 `~/.codex`（本轮全量跑测试时实际发生并被沙箱拦截暴露）
- 双侧 typecheck 零错误 / **169 测试全绿**（151 + 18）/ CLI 打包 88.3KB / 扩展打包 535.6KB

---

## V3.4 — 2026-08-30 — 语义检索 × 索引持久化 × 共享内核

> 纲领文档：`V3.4-ITERATION-PROMPT.md`（对照 Cursor @codebase 语义检索 / Claude Code 索引复用 / Aider repo-map 缓存）。
> 核心命题：三路召回解决"看得准"，本轮补上**口语化查询兜底**（符号/关键词都命不中）与**索引重复构建成本**。

### A. 语义召回（第四路）：n-gram token 覆盖率匹配（`src/context/context-engine.ts`）
- **分词器**：英文词 unigram/bigram + 词内字符 trigram（≥4 字符词，捕获词形变体：login/logging 共享 log/gin）+ CJK 字 bigram；纯本地零外发
- **覆盖率匹配**：查询 token 按位置加权（越靠前越重要），覆盖率 = 文件命中的查询 token 权重 / 总权重；阈值 0.15 过滤，top-5 进召回，相关性 ≤80（介于符号 100 与关键词 ≤50 之间）
- **实现路线修正**：纲领原定 512 维 FNV-1a 哈希稀疏向量 + 余弦相似度，实测短查询（"zzz"）因哈希碰撞误命中文件——**推倒重来实现为覆盖率匹配**：无碰撞、可预测、可调试，判别力来源相同（共享 n-gram 数量）
- 候选池与关键词召回同闸门：≤200 文件全量，大仓只取名称相关性 top-30；文件 token 集（路径+内容截断 20K 字符）LRU 缓存，refresh 按文件失效

### B. 索引持久化（config 目录缓存）
- 符号索引落盘 `~/.codex/cache/context/`（config 目录隔离）：size+mtime 双指纹逐文件校验，匹配的符号直接种子进缓存**免读盘**，失配即弃（文件修改后绝不采用过期符号）
- 上限保护：1500 文件 / 单文件 200 符号；写盘经串行 Promise 链防并发竞态

### C. 增量刷新 + 共享内核
- **`refresh()`**：stat-only 重扫（零内容读取），按双指纹只失效变更文件的五类缓存（内容/imports/符号/token 集/持久化种子）；符号索引置空惰性重建，未变文件命中逐文件缓存
- **共享单例**：`getSharedContextEngine(workingDir)` 进程级唯一实例（同目录同实例）；`agent-loop` 每轮任务前 `refresh()`——Agent 上一轮编辑过的文件本轮即生效
- **IDE `@codebase` 入口**：聊天面板输入 `@codebase` 触发全库语义检索注入（与 CLI 同源同 8K token 预算，`codex-ide/src/chat/chat-view-provider.ts`）

### 验收
- 新增 20 项测试：分词器（trigram/bigram/CJK/短词噪声）/ 语义召回（口语化查询兜底、阈值过滤、相关性分层、zzz 碰撞回归）/ 持久化（落盘、跨实例复用、指纹失配即弃）/ 增量刷新（增/改/删）/ 共享单例
- 双侧 typecheck 零错误 / **151 测试全绿**（131 + 20）/ CLI 打包 81.8KB / 扩展打包 535.6KB

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

## V3.3 — 2026-08-30 — 本地补全与终端自然语言化

> 纲领文档：`V3.3-ITERATION-PROMPT.md`。对照 Copilot/Continue（Tab 补全）与 GitHub Cop CLI/Warp AI（终端 NL 化），
> 但补全通道**完全本地零外发**（隐私+成本双宪法），NL 化走既有廉价模型通道。

### A. 本地 FIM Tab 补全（`codex-ide/src/completion/`）
- **fim-core.ts（纯逻辑，零 vscode 依赖，可直测）**：qwen2.5-coder FIM 模板（`<|fim_begin|>prefix<|fim_hole|>suffix<|fim_end|>`）；触发判定（≥3 非空白字符 + 非纯标点，防按键风暴）；响应清洗（去模板残留/截断首空行长尾/空补全不返回）
- **fim-provider.ts**：`InlineCompletionItemProvider` + Ollama `/api/generate`（qwen2.5-coder:1.5b，6G 显存流畅）；防抖 400ms（序号抢占语义，无 promise 泄漏）；单飞行请求（新请求 abort 旧请求）；Ollama 不可达熔断 5 分钟静默降级（不打扰编辑，OutputChannel 记录）
- 上下文裁剪：前缀 ≤64 行 / 后缀 ≤32 行 / 补全 ≤96 token；6 个 `codex-ide.fim.*` 配置项
- 明确不做云端补全通道——按键级请求 = 成本失控 + 代码外发，双红线

### B. 终端命令自然语言化（`codex-ide/src/terminal/`）
- **nl-command-core.ts（纯逻辑）**：prompt 注入平台/shell/工作目录上下文；响应容错解析（代码块提取 / 前言行跳过 / 行内注释去除 / "命令:"前缀去除）；危险命令检测（rm -rf、rmdir /s、Remove-Item -Recurse -Force、DROP TABLE、--force、format、注册表强删等 11 类模式）
- **nl-command.ts**：`Ctrl+Alt+T` 或命令面板 → 自然语言输入 → 廉价模型转换（复用 streamOnce 通道）→ **预填可编辑确认框**（危险命令显著警告）→ 填入终端**不自动执行**（用户审视后自己回车——确认环节永久保留，模型永远不直接执行命令）
- 测试中发现并修复真实解析缺陷：模型输出"命令是：\nls -la"时前言行以冒号结尾需跳过

### 验收
- 新增 23 项测试（FIM 触发/模板/裁剪/清洗 + NL prompt/解析/危险检测）
- 双侧 typecheck 零错误 / **131 测试全绿**（108 + 23）/ CLI 打包 77.6KB / 扩展打包 530.4KB

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
| V4.1 | 插件市场 | 工具注册开放协议（第三方工具包加载）、IDE 侧 /plan 入口复用编排内核 |
| V4.3 | 编排打磨 | 计划展示与人工确认（执行前可编辑步骤）、并行无依赖步骤调度 |
