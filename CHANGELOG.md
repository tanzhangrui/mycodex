# Codex 迭代日志（CHANGELOG）

> 记录从最初版本到当前的每一次迭代。格式：版本 / 日期 / 主题 / 详细变更 / 验收结果。
> 产品宪法：`AI-IDE-MASTER-PROMPT.md`；迭代纲领：`V3.1-ITERATION-PROMPT.md`。

\*\*\*---

## V5.14 — 2026-08-30 — 环境体检（codex doctor）

> "为什么不工作"是最贵的支持成本——把常见故障模式变成一条命令可判定的清单。

### A. `codex doctor`

* 五段体检：Provider 配置（key 缺失检测，mock/local 豁免）/ 环境变量覆盖（6 个关键变量）/ Node 运行时（18+ fetch 门槛）/ 配置目录可写（探测前懒创建）/ 插件健康（路径存在性 + 真实加载结果 + 工具数）

* 每项失败给修复提示（`→ 运行 codex config` / `→ codex plugin remove`）；有问题退出码 1（CI 可感知）

* 边界：不做真实网络调用——provider 连通性由实际对话验证，体检只查本地可判定项（避免体检本身变慢/误报）

* 顺带修复真实缺陷：配置目录此前由 initConfig/saveConfig 懒创建，doctor 探测 ENOENT——现在探测前 `mkdirSync(recursive)`

### 验收

* CLI 冒烟：全部通过（退出码 0）；修复后含 GLM key 覆盖 / Node 24 / 配置目录可写 / 无常驻插件 4 段绿灯

* typecheck 零错误 / **301 测试全绿**（294 + 7，含 V5.13 的 7 项）

***

## V5.13 — 2026-08-30 — 上下文引擎 cwd 感知（邻近加权）

> 多根召回有个体验盲区：两个根里各有一个 `user-service.ts`，语义相关性相同——
> 但用户正在 app-api 里工作，上下文却可能先给 app-web 的那个。

### A. `AssembleOptions.cwd`（context-engine.ts）

* 排序前邻近加权：cwd 子树内文件 relevance +15；多根模式下同根（首段匹配）+8

* 只改排序不改召回集合（召回逻辑与阈值零变动）；反斜杠 cwd 归一化

* 单根模式同样生效（`cwd: 'b'` → `b/helper.ts` 优先）；无 cwd 行为与旧版完全一致

### 验收

* 新增 7 项测试：无 cwd 稳定排序 / 双向子树加权 / 根级同根加权 / 反斜杠归一化 / 召回集合不变量 / 单根模式 / 对称性

* typecheck 零错误 / **294 测试全绿**（287 + 7）

***

## V5.12 — 2026-08-30 — 批量更新（update --all）

> 插件装多了逐个 `update` 不可运维——需要一键全量升级。

### A. `updateAllPlugins`（marketplace.ts）

* 三态分派：**可更新**（走 V5.9 版本感知升级流）/ **已最新**（含比索引新，跳过）/ **无来源**（索引中无此插件，跳过）

* 失败不阻断：单插件升级失败不中断批量流，失败项旧版配置原样保留（可重试）

* 汇总 `BatchUpdateSummary`：updated（含 from/to/新路径/旧路径）/ upToDate / failed / noSource

* 调用方按 summary 做配置原子替换（移除全部旧路径 + 写入新路径）

### B. CLI `codex plugin update --all [--index <路径|URL>]`

* 从 `registry.loadedPluginIds` 读全部已装插件真实版本；逐项输出 `✔ 升级 / = 最新 / - 无来源 / × 失败`

* 有失败项退出码 1（CI 可感知）；无升级时提示"没有可升级的插件"

### 验收

* 新增 4 项测试：三态分派 / 比索引新跳过 / 失败不阻断（失败项配置未动、其余照常）/ 空列表

* typecheck 零错误 / **294 测试全绿**（283 + 11）

***

## V5.11 — 2026-08-30 — 远程市场索引（https 拉取）

> 索引此前只能本地文件——分发要靠 clone。GitHub raw / 内网服务器托管索引才是常态。

### A. `loadMarketplaceIndexFromUrl`（marketplace.ts）

* 供应链边界：索引是元数据非可执行代码（插件本体的执行门槛由 V5.5 sha256 pin 把关），故索引不要求 pin，但：

  * 仅 https（http 明文可被中间人替换 → 拒绝，与插件下载红线一致）

  * 大小上限 1MB（索引远小于插件）；空内容 / 非法 JSON → null

* **不缓存**：outdated/update 需要每次看到最新索引（缓存会让索引滞后静默化）

* 复用 `parseMarketplaceIndex` 全部容错（围栏块 / 噪声文本 / 条目校验）

* baseDir 语义：远程索引的 file 源相对路径以进程 cwd 为基准；远程索引条目应使用 url 源（绝对地址）

### B. CLI `--index <路径|https URL>`

* 全部 6 个 plugin 子命令（list/search/install/update/outdated/remove…）统一走双源加载：`https://` 前缀 → 远程拉取，其余 → 本地文件

* 用法帮助标注索引源双形态

### 验收

* 新增 7 项测试：成功拉取（baseDir=cwd）/ http 拒绝 / 非 URL 误传防护 / 网络错误 / 空内容与非法 JSON / 1MB 上限 / 围栏块容错

* typecheck 零错误 / **283 测试全绿**（277 + 6，含 V5.12 批量更新 4 项与 1 项修正）

***

## V5.10 — 2026-08-30 — 市场关键词搜索

> 索引大了之后 `plugin list` 全量翻屏不可用——需要 `search`。

### A. `searchEntries`（marketplace.ts）

* 匹配域：name + description，大小写不敏感子串匹配；多关键词（空白分隔）AND 语义（全命中才返回）

* 相关性排序：name 精确（4 分）> name 前缀（3 分）> name 包含（2 分）> 仅 description 命中（1 分）

* 空查询 / 纯空白 → 空结果（不等于全量列表）

### B. CLI `codex plugin search <关键词> [--index <路径>]`

* 输出命中数占比（`2/15`）+ name\@version + 描述 + 双源标注（与 list 一致的显示格式）

### 验收

* 新增 6 项测试：子串双域命中 / 相关性排序 / 精确名最前 / 多关键词 AND / 空查询防护 / 无命中

* typecheck 零错误 / **283 测试全绿**（277 + 6）

***

## V5.9 — 2026-08-30 — 版本感知更新（semver 对比跳过无效升级）

> V5.8 的 update 无条件走卸旧装新——已是最新时白下载白卸载；CLI 也不知道"装的是什么版本"。

### A. `compareVersions`（零依赖轻量 semver）

* 按 '.' 分段数值比较（`2.0.0 < 10.0.0`，非字符串比较）；缺失段按 0（`1.0 == 1.0.0`）

* 预发布语义：`1.0.0-beta < 1.0.0`；预发布间按字符串比较（`beta.1 < beta.2`）

* `v`/`V` 前缀容错；非数字段降级字符串比较（大小写不敏感）

### B. `updatePlugin` 版本感知

* 新增 `currentVersion` 参数：已装 >= 索引版本 → `upToDate: true` 直接返回——零卸载零下载零配置变更

* 索引滞后（已装比索引新）同样跳过并明示；已装更旧才走 V5.8 卸旧装新流

* 无 `currentVersion` → 保持 V5.8 行为完全不变（向后兼容）

### C. CLI

* `codex plugin update`：加载旧版后从 `registry.loadedPluginIds` 读取真实版本号传入（版本号来自插件自身声明，非路径猜测）；upToDate 零变更返回

* 新增 `codex plugin outdated [--index <路径>]`：逐插件对比已装/索引版本，可更新项给出 update 命令提示

### 验收

* 新增 7 项测试：compareVersions 数值/预发布/前缀容错 + updatePlugin 已装等版跳过（零 registry 触碰）/ 索引滞后跳过 / 更旧正常升级 / 无版本参数回归

* typecheck 零错误 / **277 测试全绿**（270 + 7）/ V5.8 既有 update 测试零改动通过

***

## V5.8 — 2026-08-30 — 插件更新流（卸旧装新）

> 市场协议至此补齐生命周期最后一环：install（V4.4）→ 远程源（V5.5）→ **update** → remove。
> 更新不是"再装一次"：registry 去重键是 `name@version`、卸载按名前缀匹配，顺序错了会把刚装的新版卸掉。

### A. `updatePlugin`（marketplace.ts）

* 升级流：**先** **`unloadPlugin(name)`** **卸旧 → 再** **`installPlugin`** **装新**——顺序红线：
  若先装新后卸旧，按名前缀卸载会命中刚注册的新版（name 相同）

* 原子性：安装失败 → `removedPaths` 恒空、调用方不动 `config.plugins`——旧版配置原样保留，升级失败不留半成品

* `removedPaths` 语义：成功后应从配置移除的旧路径（与新路径相同 → 原地刷新，配置零变更）

* 运行时未加载旧版（`unloadPlugin` 返回 -1）→ 无副作用直装（CLI 冷更新场景）

### B. CLI `codex plugin update <名称> [--index <路径>]`

* 名称匹配规则与 remove 一致（插件名 / basename / 路径包含）；未安装 → 明确报错引导 install

* 先 `loadPlugins(currentPaths)` 让运行时与真实启动一致（卸旧才有对象），再走 updatePlugin

* 配置原子更新：移除 `removedPaths` + 写入新 `pluginPath`；用法/帮助文本同步

### 验收

* 新增 6 项测试：升级成功（含 unload→load 顺序断言）/ 安装失败原子性（旧版配置不动）/ 同路径原地刷新 / 多旧路径全量清理 / 未加载旧版冷更新 / url 源升级（新缓存路径替换旧缓存）

* typecheck 零错误 / **270 测试全绿**（264 + 6）

***

## V5.7 — 2026-08-30 — tsconfig paths 别名解析

> V5.3/V5.6 解决了裸包名跨根，但 monorepo 里更常见的引用形态是 `@/utils`、`@shared/ui` 这类
> tsconfig paths 别名——此前全部被当外部包丢弃，import 图在别名处断裂。

### A. 别名表构建（`buildPathAliases`）

* 各根读 `tsconfig.json` 的 `compilerOptions.paths` + `baseUrl`：`@shared/*` → 键空间前缀 `<root>/baseUrl/target`

* 一个别名多目标按序探测；同名别名跨根共存（合并候选）；单根键空间无前缀（`baseUrl/target` 直用）

* JSONC 容错重写为**字符串感知状态机**：行内注释（`"a": 1, // note`）安全剥离，字符串字面量内的 `//`（URL）不误删，尾逗号容错

### B. 解析接入（`resolvePathAliasImport`）

* 最长前缀匹配：`@app/*` 与 `@app/legacy/*` 并存时后者优先；精确别名与通配别名统一处理

* 候选前缀逐一替换 + `probeEntry` 探测（扩展名/index 文件），未命中回退包名别名、再未命中放弃（外部包无假路径）

* `parseImports` 收集条件扩展：任一根有 paths 别名即收集裸说明符（单根也生效，无 tsconfig 零回归）

### 验收

* 新增 7 项测试：同根别名 / 跨根别名 + baseUrl / 最长前缀匹配（`@legacy/v2` 不落短别名路径）/ 普通前缀别名 / 外部包与相对 import 混合 / BFS 跨根扩展 / 单根 + JSONC 容错

* typecheck 零错误 / **264 测试全绿**（257 + 7）

***

## V5.6 — 2026-08-30 — Python 跨根 import（pyproject 别名）

> V5.3 解决了 TS/JS 裸说明符跨根；Python monorepo（`from my_lib.core import helper`）依旧断在根边界。
> 顺带修复一个存量缺陷：`from . import sibling` 形态（纯 dots 说明符）从未被解析。

### A. pyproject.toml 包名别名

* `buildPackageAliases` 扩展：根无 package.json 时读 pyproject.toml 的 `name`（正则解析 `[project] name = "..."`）

* 连字符归一化：pyproject name `my-lib` → 别名键 `my_lib`（PEP 8 包名约束，import 侧用下划线形态）

* 目录名不自动成为别名（避免与 pip 外部包名冲突）——诚实边界记录在案

### B. dotted 说明符解析（`resolvePackageImport`）

* Python 形态：`mylib` / `mylib.core` / `mylib.core.util`（无 `/` 含 `.` → 按 `.` 分段）

* `import mylib` → 根 `__init__.py` 入口（`probeEntry` 新增 `__init__.py` 探测，TS 侧无影响）

* src-layout 兜底：根下与包同名目录（`lib2/data_kit/loader.py`）——目录 = 归一化包名惯例

* stdlib / pip 外部包不命中别名 → 放弃，无假路径

### C. 存量缺陷修复：`from . import x` 从未解析

* 旧逻辑收集纯 dots 说明符（`.`）→ resolveImport 探测目录本身必然失败 → 丢弃

* 新增展开规则：`from . import a, b` / `from .. import (a, b)` → `./a` / `../b` 走相对解析（单根/多根均生效）

### 验收

* 新增 7 项测试：连字符归一化互引 / `import my_lib` → `__init__.py` / 同根相对不受影响 / stdlib 不入图 / BFS 跨根（Python 混合仓）/ src-layout 嵌套探测 / 单根 Python 不回归（含 `from . import` 修复验证）

* typecheck 零错误 / **256 测试全绿**（249 + 7）

***

## V5.5 — 2026-08-30 — 插件市场远程源（url）安全下载

> V4.4 的诚实边界兑现：`source.kind` 从仅 file 扩展到 url，远程插件可装了——
> 但供应链安全是红线，无 pin 的远程下载执行等于任意代码注入入口。

### A. 协议扩展（`MarketplaceSource`）

* `source: { kind: 'url', url, sha256 }`：https 强制（http 明文可被中间人替换 → 拒绝）；sha256 必填且必须 64 位 hex（缺失/畸短 → 条目剔除，不降级）

* file / url 条目可混存于同一索引；旧客户端自动忽略 url 条目（向后兼容）

### B. 下载与校验（`downloadRemotePlugin`）

* 落缓存目录 `config/plugins/<name>-<version>-<urlTag>.mjs`（url 短哈希防冲突），校验通过后才 `loadPlugin`

* 缓存命中先复核内容 sha256（防本地缓存被篡改后绕过校验）；不符 → 作废重下

* 大小上限 2MB / 空内容拒绝 / 下载器错误结构化失败（网络错误不炸）

* `installPlugin` 增加可注入 `fetcher`（默认 global fetch，Node 18+）——测试零真实网络

* CLI `plugin list` 兼容双源显示（url 条目标注 sha256 pin）

### 验收

* 新增 10 项测试：合法 url 条目解析 / http+缺 sha256+短 sha256 剔除 / 混合源共存 / 成功下载安装 / 缓存复用零重复下载 / 篡改内容拒绝且不落盘 / 空内容拒绝 / 污染缓存作废重下 / 下载错误结构化失败 / file 源不经下载器回归

* typecheck 零错误 / **249 测试全绿**（239 + 10）

***

## V5.4 — 2026-08-30 — 语义召回 IDF 加权

> V3.4 的 token 覆盖率匹配有个盲区：export/const/function 这类几乎每文件都有的常见 token
> 与 createUser/token-store 这类区分性 token 同权——常见词能把不相关文件的覆盖率虚抬过阈值。

### A. 两遍扫描 + IDF 加权（`semanticRecall`）

* 第一遍：收集候选 token 集 + 统计查询 token 的文档频率（df）

* 第二遍：`idf = ln(1 + N/df)` 加权命中率——常见 token（df≈N）权重被压到接近 ln2，区分性 token（df=1）主导覆盖率与排序

* 语义不变量保持：覆盖率仍是 \[0,1]、阈值/top-K/相关性上限（≤80）不变、df=0 的 token 仅稀释分母

* 单文件退化：IDF 均匀（N=1 → 全 ln2），行为与旧版等价，无除零

* 复杂度不变：候选池仍受小仓全量 / 大仓 top-30 闸门限制，token 集 LRU 缓存复用

### 验收

* 新增 4 项测试：仅常见词的文件被压到阈值之下（不再虚高召回）/ 常见词更重的混合查询目标文件仍排第一 / 单文件退化不除零 / 无信号查询不误召回（zzz 回归）

* typecheck 零错误 / **239 测试全绿**（235 + 4）/ V3.4 既有语义召回测试零改动通过

***

## V5.3 — 2026-08-30 — 跨根 import：包名别名互引

> V5.0 统一键空间解决了"检索看不见另一仓"；本轮解决"import 图看不见另一仓"——
> `import { X } from '@acme/shared-lib'` 这类 monorepo 裸说明符此前直接丢弃，BFS 扩展断在根边界。

### A. 包名别名（`buildPackageAliases`）

* 多根索引时读各根 `package.json` 的 `name` → `包名 → 根名` 映射（scoped/plain 均支持）

* 无 package.json / name 缺失 / JSON 损坏 → 该根无别名（静默跳过）；单根模式别名表恒空，行为与旧版完全一致

### B. 裸说明符跨根解析（`resolvePackageImport`）

* 多根 + 别名表非空时 `extractImportSpecifiers` 收集裸说明符（单根/无别名不收集，零回归）

* 解析形态：`@scope/pkg` / `@scope/pkg/sub` / `pkg` / `pkg/sub` → 目标根键空间内探测（扩展名 → index 文件）

* 源码/发布产物布局兜底：`dist/` `src/` `lib/` 前缀（共享库入口在 `src/index.ts` 的常见 monorepo 布局直接命中）

* 外部依赖（`lodash` 等）与 `node:` 内建直接放弃——不会误拼 `dirname/pkg` 假路径

* 效果：`getRelatedFiles` / `assembleContext` 的 import 图 BFS 天然跨根（统一键空间零改动）

### 验收

* 新增 7 项测试：包名入口互引 / 子路径互引 / 混合场景（同根相对不受影响）/ BFS 跨根扩展 / 外部依赖不入图 / 无别名多根不收集 / 单根不回归（含自身包名）

* 双侧 typecheck 零错误 / **235 测试全绿**（228 + 7）

***

## V5.2 — 2026-08-30 — IDE 多根感知 + 插件卸载

> V5.1 的两个收尾：IDE 侧接上多根（VS Code 多根文件夹零配置生效）；插件生命周期闭环（装 → 常驻 → 卸）。

### A. IDE 多根感知（`codex-ide`）

* `AgentService.workspaceDirs` getter：VS Code 多根文件夹（File > Add Folder to Workspace）→ 全部根透传内核（跨根检索）；单根返回 string（零开销兼容）

* `send` / `sendPlanned` / `newSession` 全部走 `workspaceDirs`；沙箱/命令确认以主根为基准（`primaryRootOf`）

* **零配置零 UI 改动**：用户在 VS Code 里加个文件夹，检索域自动扩展

### B. 插件卸载（registry + CLI）

* `ToolRegistry.unloadPlugin(name 或 name@version)`：按归属移除该插件注册的全部工具 + 清去重标记 + 失效工具缓存；未加载返回 -1

* 归属跟踪：`loadPlugin` 注册期间经 `withPluginScope` 标记 `toolOwner`（register 的工具记入所属插件）

* `codex plugin remove <名称>`（别名 uninstall）：配置移除（路径/basename/包含三重匹配）+ 运行时卸载

* `codex plugin list` 增强：对照 config.plugins 标注 `[已安装]`

### 验收

* 新增 5 项测试：按 name 卸载（工具移除 + 可重载）/ 按完整 id 卸载 / 卸载隔离（他插件不受影响）/ 未加载 -1 / 卸载后同名工具可重注册

* 双侧 typecheck 零错误 / **228 测试全绿**（223 + 5）/ 双侧打包成功 / install → remove 全生命周期 CLI 冒烟通过

***

## V5.1 — 2026-08-30 — 多根入口接线 + 插件市场命令

> V5.0 交付了多根核心层原语，本轮把它接到用户手里：CLI 一参数进多根，插件市场一条命令装常驻。
> 诚实边界：IDE 侧（VS Code 多根文件夹感知）未接——agent-service 传单根 string 完全兼容（类型已放宽）。

### A. CLI `--workspace` 多根接线

* `codex chat --workspace <目录1>,<目录2>`：逗号分隔多根（首根 = 主根）；根不存在/非目录 fail-fast

* 类型链路全线放宽 `WorkingDirInput = string | string[]`（agent-loop / orchestrator / text-repl / app.tsx）——单根调用零改动完全兼容

* 语义分层：上下文引擎**跨根召回**（系统提示词含全部根的相关代码）；工具/沙箱/CODEX.md 规则/验证命令以**主根为基准**（`primaryRootOf`）

* `InMemoryFileSystem.snapshot` 多根：绝对路径键天然无冲突，两根文件均可读可编辑可 /apply

### B. 插件市场命令（`codex plugin`）

* `codex plugin list [--index <路径>]`：列出索引插件（默认 `./marketplace.json`）

* `codex plugin install <名称> [--index <路径>]`：安装 + **写入 config.plugins 常驻**（下次启动自动加载，已在配置则跳过）

* 真实端到端验证：examples 索引安装 echo-tools → 2 工具加载 → 配置落盘

### C. 修复（冒烟测试发现的两处真实缺陷）

* **管道模式崩溃**：`registerBuiltinTools` 被入口与 text-repl 双重调用 → "工具 read\_file 已注册" 崩溃；改为幂等（`clearTools` 重置标记）

* **多根首查竞态**：`ContextEngine.index` 多根路径原用动态 `await import`，共享单例 void 调用下首次查询的系统提示词与扫描竞态（召回为空）；改静态导入保证 index 全程同步完成

### 验收

* 新增 7 项测试：primaryRootOf / 内存 FS 多根快照（跨根可读/主根基准/单根兼容）/ runAgentLoop 多根（跨根召回 + 主根规则注入）/ 单根不回归

* 双侧 typecheck 零错误 / **223 测试全绿**（216 + 7）/ CLI + 扩展打包成功 / `--workspace` 与 `plugin list/install` 真实 CLI 冒烟通过

***

## V5.0 — 2026-08-30 — 多仓库工作区（核心层）

> 纲领文档：`V4.4-V5.0-ITERATION-PROMPT.md`。核心命题：单 workingDir 假设贯穿引擎/agent-loop/IDE——monorepo 多仓场景（前端仓 + 服务仓 + 共享库仓）下检索只见一仓。
> 诚实边界：本轮交付**核心层原语 + 引擎消费**；agent-loop/CLI 的多根入口接线与跨根 import（tsconfig paths/别名）不在本轮。

### A. WorkspaceResolver（`src/core/workspace.ts`）

* 多根注册 + 根名去重（basename 冲突 → `repo-2`，双仓同 basename 是常态）；首根为主根（CODEX.md 规则、默认工作目录语义）

* 双向路径映射：绝对路径 ⇄ 工作区相对路径（`rootName/rel`）

* 边界安全：`contains`/`toWorkspaceRel` 越界显式返回 null/false（路径逃逸是安全问题不是 bug）；`toAbsolute` 段级 `..` 逃逸拒绝；前缀伪装目录（`backend-inside` ≠ `backend`）不误判

* `resolveInput`：任意输入（绝对或相对主根）→ 根内绝对路径，越界 null

### B. ContextEngine 多根（`src/context/context-engine.ts`）

* `index(workingDir: string | string[])`：多根时键空间统一为 `rootName/rel` 前缀——**四路召回（符号/关键词/语义/依赖图）与 import 图 BFS 零改动即跨根**（全部消费统一键）

* `scanDirectory` 参数化（baseDir + prefix）；`refresh` 增量刷新重扫全部根

* `keyToAbs`：统一键 → 绝对路径按根名路由；单根模式与旧行为完全一致（无前缀键）

* 相对 import 天然限定同根（不同根是不同目录树），统一键空间内解析无需特判

* 持久化隔离：`persistKey`（单根 = workingDir 兼容旧缓存；多根 = 全根路径拼接）——多根缓存绝不误读单根缓存

* `getSharedContextEngine` 支持多根（根列表 join 为缓存键，顺序不同视为不同工作区）；单根 string 与单元素数组键归一化等价

* 隐私红线不放松：敏感文件跨根依然拦截（有测试）

### 验收（V4.4 + V5.0 合并）

* 新增 34 项测试：市场协议 15（解析三级容错/形状校验/去重/上限/加载/查找/安装四态）+ 多仓库 19（根名去重/双向映射/越界拒绝/统一键空间/跨根检索与读内容/import 图/refresh 增量/单根兼容/持久化隔离/共享单例）

* typecheck 零错误 / **216 测试全绿**（182 + 34）

***

## V4.4 — 2026-08-30 — 插件市场索引协议（v1）+ 示例插件

> 纲领文档：`V4.4-V5.0-ITERATION-PROMPT.md`。协议先行、服务后建：核心价值是格式的标准化与容错解析。
> 诚实边界：source.kind 仅 `file`；远程自动下载执行**刻意不做**——签名/校验和/沙箱隔离的供应链安全设计单独交付。

### A. 市场索引协议（`src/tools/marketplace.ts`）

* v1 静态 JSON 格式（version/plugins/name/version/description/source{kind,path}），可托管任意位置（GitHub raw / 内网 / 本地）

* 容错解析：整体 → Markdown 围栏块 → 首末大括号子串三级尝试（README 分发场景）

* 逐条形状校验（非法跳过）+ 同名去重（首个保留）+ 单索引 200 条上限（防恶意巨型索引）

* `loadMarketplaceIndex`（本地文件，baseDir 为索引所在目录）/ `findEntry`（按名精确查找）

* `installPlugin`：相对路径以索引目录为基准 → 复用 V4.1 `loadPlugin` 全部校验与去重；去重命中（count 0）= 幂等成功；返回 `pluginPath` 可直接写入 config.plugins 常驻

### B. 示例插件与文档

* `examples/plugins/echo-tools.mjs`：真实可加载运行的示例（word\_count + timestamp 两工具）

* `examples/marketplace-index.json`：v1 索引格式示例

* `PLUGIN-PROTOCOL.md`：插件形状 / 加载语义 / 安全边界文档

***

## V4.1 — 2026-08-30 — 插件开放协议（强化）+ IDE 侧 /plan 入口

> 纲领文档：`V4.1-ITERATION-PROMPT.md`。诚实边界：V1.4 已有 loadPlugin 与 CLI 配置接线——本轮把弱协议补成可依赖的开放协议。
> 与 V4.3 合并交付。

### A. 插件协议强化（`src/tools/registry.ts`）

* 导出 `CodexPlugin` 接口（name/version/register）供第三方插件作者使用

* **宽容导出解析**：命名导出 `plugin` / default 导出 / 顶层导出三种形态均支持（实测修复：原实现对命名导出形态直接在模块对象上找 name/register，永远校验失败）

* 形状校验：name 非空字符串 + version 字符串 + register 函数，不符即拒绝加载

* `name@version` 去重：重复加载返回 0（不因工具名冲突炸掉启动）；同插件升版本允许再加载

* Windows 兼容：绝对路径经 `pathToFileURL` 转换

* `loadPlugins(paths)` 批量加载，单插件失败不拖累其他；CLI 启动改用之

### B. IDE 侧 /plan 入口（`codex-ide`）

* `AgentService.sendPlanned`：复用 send 的初始化/成本预算/事件管线，内核走 runPlannedTask 编排；计划进度与结果以 delta 文本流式呈现——**零 webview 协议改动**

* 聊天面板 `/plan <任务>` 前缀路由（`chat-view-provider.ts`）

***

## V4.3 — 2026-08-30 — 编排打磨：计划人工确认

> 纲领文档：`V4.3-ITERATION-PROMPT.md`。核心命题：计划错了就白烧 token 且污染内存 FS——执行前给用户一次否决权。
> 与 V4.1 合并交付。诚实边界：并行无依赖步骤调度**明确不做**（多步骤共享内存 FS 与沙箱，并发写冲突协调成本高，且廉价模型的"无依赖"判断不可信）。

* `OrchestratorOptions.onPlanCreated` 确认钩子：计划生成后回调，返回 false → `mode: 'cancelled'`（零副作用：无步骤执行、无编辑、零 token）

* CLI `/plan`：交互 TTY 下 readline y/n 确认；非交互管道模式自动执行 + 显著警告（管道任务是用户主动投喂，意图明确；真正的交互确认在 IDE 侧）

* IDE `/plan`：模态框展示步骤列表 +「执行/取消」（V4.1 sendPlanned 内实现）

### 验收（V4.1 + V4.3 合并）

* 新增 9 项测试：插件协议（合法加载执行/三种畸形拒绝/去重/升版本/批量隔离）+ 确认钩子（true 正常执行 / false 取消零副作用）

* 双侧 typecheck 零错误 / **182 测试全绿**（173 + 9）/ CLI 打包 90.5KB / 扩展打包 544.9KB

***

## V4.2 — 2026-08-30 — 验证增强：可配置 Verifier + 步骤级回滚

> 纲领文档：`V4.2-ITERATION-PROMPT.md`。补强 V4.0 编排闭环的两个已知短板。

### A. Verifier 可配置

* `CodexConfig.planVerifyCommand`（默认 `npx tsc --noEmit` 不变）：测试驱动项目可配 `vitest run`，lint 严格项目可配 eslint

* `OrchestratorOptions.verifyCommand` 注入默认验证器；CLI `/plan` 从配置透传

### B. 步骤级回滚（接入 V3.1 检查点）

* 每步执行前 `fs.createCheckpoint()`；重试耗尽 → `fs.restoreCheckpoint()` 回滚到步骤开始前

* **失败回滚，成功保留**：失败产物未过验证 = 带病，绝不进入 `/apply` 写盘通道；成功产物已过验证 = 可信

* **重试不回滚**：保留上次尝试的编辑，让模型在现状上修复（这正是"修复"语义）

* `StepOutcome.rolledBack` 标记；CLI 汇报显示「本步骤修改已回滚」；回滚只动内存 FS，磁盘状态不变

### 验收

* 新增 4 项测试：失败回滚（半成品撤销 + FS 不脏）/ 成功保留（产物 dirty 等 /apply）/ 前序成功产物在后续失败后保留 / verifyCommand 透传

* 双侧 typecheck 零错误 / **173 测试全绿**（169 + 4）/ CLI 打包 88.6KB / 扩展打包 535.6KB

***

## V4.0 — 2026-08-30 — 多智能体编排（Planner / Editor / Verifier）

> 纲领文档：`V4.0-ITERATION-PROMPT.md`（对照 Claude Code 计划-执行模式 / Cursor 多步任务编排）。
> 核心命题：廉价模型单循环容易"一口气做完然后走偏"——用编排把大任务拆成小步，每步验证，错了当场反馈重试。
> 诚实边界：三个角色由**同一廉价模型**驱动（区别只在提示词与职责上下文，不引入额外 API 成本）；
> Verifier 是**确定性 typecheck 命令**而非模型自评（廉价模型评自己 = 假验证）。插件市场明确不在本轮（推到 V4.1）。

### A. Planner 任务拆解（`src/core/planner.ts`）

* 单次廉价模型纯文本调用（provider.stream，不挂工具）→ 严格 JSON 步骤输出

* **容错解析是一等公民**：\`\`\`json 围栏剥离 → 首末大括号子串 → 整体，三级尝试；形状校验（非空字符串数组）+ 非法项过滤 + 步数上限 8（步骤过多 = 规划幻觉信号）

* 空步数组 / 垃圾输出 / provider 抛错 → 统一返回 null（调用方降级，绝不向上传播）

### B. Orchestrator 编排闭环（`src/core/orchestrator.ts`）

* **逐步执行**：每步构建步骤作用域消息（计划概览 + 本步定位 + 前序结果摘要），复用 `runAgentLoop` 内核（Editor 角色）

* **每步验证**：默认 `npx tsc --noEmit`（沙箱执行）；无沙箱跳过、验证器自身故障不阻塞（验证是增强不是依赖）

* **失败反馈重试**：验证失败 → 错误输出注入 `<verify_failure>` 消息 → 重试 1 次；仍失败 → 步骤标记 failed 且**终止后续步骤**（带病执行 = 浪费 token 产出错误结果）

* **降级路径**：计划解析失败 → 静默回退单循环 runAgentLoop

* 编辑全部写入内存 FS——计划执行中途不落盘，`/diff` 预览、`/apply` 写盘的信任闭环不变

* `looksComplex` 启发式（多步信号词 + 长度阈值）导出备用；入口只做显式 `/plan`（不隐式触发：误判 = 多花钱 + 交互不可预期）

### C. CLI 入口（`src/cli/text-repl.ts`）

* `/plan <任务>`：生成计划 → 逐步执行 → 步骤状态汇报（✓/✗ + 重试次数 + 验证错误摘要）；流式回调提取为工厂（普通消息与 /plan 共用增量高亮）

### 验收

* 新增 18 项测试：解析容错（裸 JSON/围栏/散文/步数裁剪/垃圾→null）/ createTaskPlan（合法/垃圾/抛错）/ 启发式 / 编排闭环（成功、失败重试、耗尽终止、降级、步骤消息上下文）

* **测试卫生修复**：e2e/benchmark/orchestrator 测试隔离 `CODEX_CONFIG_PATH`——V3.4 持久化上线后，跑 agent-loop 的测试进程会把索引缓存写进真实 `~/.codex`（本轮全量跑测试时实际发生并被沙箱拦截暴露）

* 双侧 typecheck 零错误 / **169 测试全绿**（151 + 18）/ CLI 打包 88.3KB / 扩展打包 535.6KB

***

## V3.4 — 2026-08-30 — 语义检索 × 索引持久化 × 共享内核

> 纲领文档：`V3.4-ITERATION-PROMPT.md`（对照 Cursor @codebase 语义检索 / Claude Code 索引复用 / Aider repo-map 缓存）。
> 核心命题：三路召回解决"看得准"，本轮补上**口语化查询兜底**（符号/关键词都命不中）与**索引重复构建成本**。

### A. 语义召回（第四路）：n-gram token 覆盖率匹配（`src/context/context-engine.ts`）

* **分词器**：英文词 unigram/bigram + 词内字符 trigram（≥4 字符词，捕获词形变体：login/logging 共享 log/gin）+ CJK 字 bigram；纯本地零外发

* **覆盖率匹配**：查询 token 按位置加权（越靠前越重要），覆盖率 = 文件命中的查询 token 权重 / 总权重；阈值 0.15 过滤，top-5 进召回，相关性 ≤80（介于符号 100 与关键词 ≤50 之间）

* **实现路线修正**：纲领原定 512 维 FNV-1a 哈希稀疏向量 + 余弦相似度，实测短查询（"zzz"）因哈希碰撞误命中文件——**推倒重来实现为覆盖率匹配**：无碰撞、可预测、可调试，判别力来源相同（共享 n-gram 数量）

* 候选池与关键词召回同闸门：≤200 文件全量，大仓只取名称相关性 top-30；文件 token 集（路径+内容截断 20K 字符）LRU 缓存，refresh 按文件失效

### B. 索引持久化（config 目录缓存）

* 符号索引落盘 `~/.codex/cache/context/`（config 目录隔离）：size+mtime 双指纹逐文件校验，匹配的符号直接种子进缓存**免读盘**，失配即弃（文件修改后绝不采用过期符号）

* 上限保护：1500 文件 / 单文件 200 符号；写盘经串行 Promise 链防并发竞态

### C. 增量刷新 + 共享内核

* **`refresh()`**：stat-only 重扫（零内容读取），按双指纹只失效变更文件的五类缓存（内容/imports/符号/token 集/持久化种子）；符号索引置空惰性重建，未变文件命中逐文件缓存

* **共享单例**：`getSharedContextEngine(workingDir)` 进程级唯一实例（同目录同实例）；`agent-loop` 每轮任务前 `refresh()`——Agent 上一轮编辑过的文件本轮即生效

* **IDE** **`@codebase`** **入口**：聊天面板输入 `@codebase` 触发全库语义检索注入（与 CLI 同源同 8K token 预算，`codex-ide/src/chat/chat-view-provider.ts`）

### 验收

* 新增 20 项测试：分词器（trigram/bigram/CJK/短词噪声）/ 语义召回（口语化查询兜底、阈值过滤、相关性分层、zzz 碰撞回归）/ 持久化（落盘、跨实例复用、指纹失配即弃）/ 增量刷新（增/改/删）/ 共享单例

* 双侧 typecheck 零错误 / **151 测试全绿**（131 + 20）/ CLI 打包 81.8KB / 扩展打包 535.6KB

***

## V3.1 — 2026-08-18 — 信任 × 上下文 × 可靠性 三大闭环

> 首个 git 版本控制起点（`git init`，此前无版本历史）。
> 纲领文档：`V3.1-ITERATION-PROMPT.md`（PM/架构师/CTO/首席科学家四视角差距分析）。

### 迭代 A — 信任地基（commit `8bb2000`）

* **会话持久化**：消息历史（上限 40 条，单条 8K 截断）+ token/成本存 `globalState`，VSCode 重启自动回放

* **欢迎页**：空状态品牌引导 + 3 个快捷任务（解释当前文件 / 编写测试 / 代码审查）+ 快捷键提示

* **任务排队**：Agent 运行中发消息自动排队一条、完成后自动接续，不再报错打断心流

* **OutputChannel 日志**：「Codex IDE」输出通道，错误可诊断，全程无密钥

* 验收：双侧 typecheck 零错误 / 74 测试全绿 / 打包 507.3KB / 前端语法校验通过

### 迭代 B — 上下文工程（commit `753ead1` + 清理 `71d2f72`）

* **@文件引用**：消息中 `@相对路径` 精确圈定上下文（隐私守卫生效、单文件 4K 截断、上限 3 个）——廉价模型上下文弱，用精确引用补齐

* **诊断注入**：「修复选中代码」自动附带选区范围内 Problems 面板的 error/warning，提升一次修复率

* **修复 inline 编辑取消无效**：`streamOnce` 独立 AbortController；取消同时清空排队任务

* 事故记录：cmd 内联脚本引号问题产生垃圾文件 `p.test(f)))` 并误提交，已在 `71d2f72` 彻底清除；此后提交一律使用 `-F` 消息文件 + 提交前敏感扫描脚本

* 验收：双侧 typecheck 零错误 / 打包 508.9KB 通过

### 迭代 C — 可靠性闭环（commit `8c49f0a`）

* **检查点回滚（时间旅行）**：`InMemoryFileSystem.createCheckpoint/restoreCheckpoint/rebaseAgainstDisk`；每轮任务前自动存档（上限 20 轮）；面板 ⟲ 按钮逐轮回滚；已写盘变更经 rebase 重新标脏，可再次「全部应用」写回磁盘——"预览 ✓ 应用 ✓ 回滚 ✓"信任闭环完成

* **失败自适应升档**：auto 模式下免费档调用失败 → 自动升级 DeepSeek 重试一次（最小反馈回路，仅 free 档可升，防账单失控）

* **流式重试核验**：核心 `openai-compatible` 已具备 429/5xx/网络错误指数退避重试（×3 尝试）

* **新增 14 项测试**：检查点 4 项 + 预设/成本/复杂度/升档 10 项

* 验收：双侧 typecheck 零错误 / **88 测试全绿** / 打包 511.6KB / 前端语法通过

### 工程基础设施

* `git init` + 根提交 `410ac4e`（56 文件，14,352 行），提交前敏感文件扫描全零命中

* `chat.js` 字面 NUL 字节修复（`3ce339c`），恢复标准 UTF-8 文本可 diff

* `.gitignore` 增补 `codex-ide/.vscode/launch.json` 例外（保留 F5 调试配置）

***

## V3.3 — 2026-08-30 — 本地补全与终端自然语言化

> 纲领文档：`V3.3-ITERATION-PROMPT.md`。对照 Copilot/Continue（Tab 补全）与 GitHub Cop CLI/Warp AI（终端 NL 化），
> 但补全通道**完全本地零外发**（隐私+成本双宪法），NL 化走既有廉价模型通道。

### A. 本地 FIM Tab 补全（`codex-ide/src/completion/`）

* **fim-core.ts（纯逻辑，零 vscode 依赖，可直测）**：qwen2.5-coder FIM 模板（`<|fim_begin|>prefix<|fim_hole|>suffix<|fim_end|>`）；触发判定（≥3 非空白字符 + 非纯标点，防按键风暴）；响应清洗（去模板残留/截断首空行长尾/空补全不返回）

* **fim-provider.ts**：`InlineCompletionItemProvider` + Ollama `/api/generate`（qwen2.5-coder:1.5b，6G 显存流畅）；防抖 400ms（序号抢占语义，无 promise 泄漏）；单飞行请求（新请求 abort 旧请求）；Ollama 不可达熔断 5 分钟静默降级（不打扰编辑，OutputChannel 记录）

* 上下文裁剪：前缀 ≤64 行 / 后缀 ≤32 行 / 补全 ≤96 token；6 个 `codex-ide.fim.*` 配置项

* 明确不做云端补全通道——按键级请求 = 成本失控 + 代码外发，双红线

### B. 终端命令自然语言化（`codex-ide/src/terminal/`）

* **nl-command-core.ts（纯逻辑）**：prompt 注入平台/shell/工作目录上下文；响应容错解析（代码块提取 / 前言行跳过 / 行内注释去除 / "命令:"前缀去除）；危险命令检测（rm -rf、rmdir /s、Remove-Item -Recurse -Force、DROP TABLE、--force、format、注册表强删等 11 类模式）

* **nl-command.ts**：`Ctrl+Alt+T` 或命令面板 → 自然语言输入 → 廉价模型转换（复用 streamOnce 通道）→ **预填可编辑确认框**（危险命令显著警告）→ 填入终端**不自动执行**（用户审视后自己回车——确认环节永久保留，模型永远不直接执行命令）

* 测试中发现并修复真实解析缺陷：模型输出"命令是：\nls -la"时前言行以冒号结尾需跳过

### 验收

* 新增 23 项测试（FIM 触发/模板/裁剪/清洗 + NL prompt/解析/危险检测）

* 双侧 typecheck 零错误 / **131 测试全绿**（108 + 23）/ CLI 打包 77.6KB / 扩展打包 530.4KB

***

## V3.2 — 2026-08-30 — 上下文引擎：让廉价模型"看得准"

> 纲领文档：`V3.2-ITERATION-PROMPT.md`（对照 Cursor @codebase / Claude Code 自动相关文件收集 / Aider repo-map）。
> 核心命题：廉价模型与旗舰模型的差距很大一部分在**喂给它的上下文质量**——本轮把上下文从"文件名关键词匹配"升级为"符号 + 依赖图 + 预算"三引擎。

### 三路召回融合（`src/context/context-engine.ts` 全面重写，终结 @deprecated 预留状态）

* **符号索引**：零依赖正则近似 AST（TS/JS/TSX/JSX/Python 的 class/function/method/interface/type/const + 行号）；查询提到函数/类名 → 直接定位定义处 ±20 行 chunk（相关性 100 分层，远高于关键词命中）；惰性构建 + LRU 缓存

* **import 图自动相关文件收集**：解析相对 import/require/from（扩展名 + index 文件探测）→ 文件级依赖图 BFS；修改某文件时其直接依赖的头部 60 行自动进入上下文（跨文件改动不再漏改调用点）

* **大仓库懒加载**：扫描阶段只 stat 零内容读取；文件内容/符号/imports 全部按需读取 + LRU(200)；>200 文件时关键词召回只读 top-20 候选；符号索引 3000 文件 / 单文件 512KB 上限

* **agent-loop 集成**：系统提示词自动注入 `<project_context>`（8K token 预算，以最后一条用户消息为查询）；引擎失败静默降级，绝不阻断 Agent 主循环

* **隐私红线修复**：原扫描代码 `entry !== '.env'` 特殊放行导致 `.env` 前 500 字符进入可检索索引——现复用 `privacy-guard.isSensitivePath`，敏感文件（.env\*/私钥/凭据）绝不入索引；`.env` 移出文本扩展名白名单

* **修复 findBestChunk 短文件盲区**：原滑动窗口循环在文件行数 < 30 时完全不执行，短文件永不命中

* 新增 20 项测试：符号提取（TS/Python/控制流误报）/ 符号定位 / import 解析与 BFS / 三路召回 / 预算裁剪 / 去重 / 懒加载 / 隐私拦截（密钥不泄漏到任何上下文产出）/ 提示词注入

* 验收：双侧 typecheck 零错误 / **108 测试全绿**（88 + 20）/ CLI 打包 77.6KB / 扩展打包 524.0KB

***

## V3.0 — 2026-08-04 — 双形态诞生：CLI 内核 + VSCode 扩展

> 战略转折点：从纯 CLI 进化为深度嵌入 VSCode 的 AI IDE。
> 产品宪法 `AI-IDE-MASTER-PROMPT.md` 确立："模型是商品，编排是壁垒"。

### 核心层（CLI 与 IDE 共享）

* **隐私守卫**（`src/core/privacy-guard.ts`）：四层物理隔离——
  ① memfs 快照剔除 `.env*`/私钥/证书/凭据（修复了 `.env` 原本在可读白名单内的真实泄漏面）
  ② 文件工具 read/write/edit 对敏感路径显式拒绝
  ③ 沙箱拦截引用敏感文件/密钥变量的命令（`cat .env`、`echo $GLM_API_KEY` 等）
  ④ 子进程环境净化（剥离 `*_API_KEY`/`*_TOKEN`/`*_SECRET`，防 curl 外泄）

* **既有类型错误清零**：8 处历史遗留 TS 错误修复（ai-client 字面量类型、McpClient 动态导入类型、context-engine 导入缺失等）

* 新增 17 项隐私守卫测试

### Codex IDE 扩展（`codex-ide/`，全新）

* **侧栏 AI 聊天**：零框架 Webview，流式渲染、轻量 Markdown、代码复制、工具调用可视化

* **模型矩阵与自动成本路由**：9 预设（GLM-4.7-flash 免费 / DeepSeek-V3·R1 / GLM-4.6 / Qwen-Plus / Kimi K2 / 硅基流动免费档 / Ollama 本地 / Claude Sonnet）；简单任务走免费档，复杂任务自动升级低价档

* **编辑器深度集成**：`Ctrl+I` 内联编辑（diff 预览→应用/拒绝）、右键解释/修复/重构、原生 `vscode.diff` 逐文件预览、全部应用/拒绝

* **成本透明**：状态栏实时 token + ¥ 估算；`costBudgetCny` 预算熔断

* **密钥安全**：SecretStorage 系统级加密 > 环境变量 > `.env` 只读解析；Key 永不落盘明文、永不出现在日志/UI

* 验收：74/74 测试 / typecheck 零错误 / 打包 505.7KB/65ms

***

## V2.0 — 产品化版本（CLI）

* Ink UI 代码高亮 + diff 彩色输出

* `/save` 会话保存、`codex update` 自动更新检查

* 独立二进制分发（`build:binary`）

* 性能基准测试（冷启动 <1ms / 千文件快照 \~32ms / 工具缓存 <0.1ms）

## V1.5 — 会话韧性

* 会话崩溃恢复（锁文件检测 + `--resume`）

* AI 回复代码块 ANSI 语法高亮

## V1.4 — 生态与扩展性

* MCP 协议兼容（JSON-RPC 2.0 over stdio）

* 插件系统（npm 包/本地文件动态加载）

* 子 Agent 委派（tool\_use > 5 自动并行）

* 流式重试机制（429/5xx/连接失败）

## V1.3 — 智能化与安全性

* 多模型智能路由（简单→GLM 免费，复杂→Claude）

* CODEX.md 项目规则注入

* 安全沙箱（命令白名单 + 危险模式检测）

* 结构化日志、并行工具执行 + LRU 缓存、AbortSignal、Token 统计

## V1.2 — 多 Provider 架构

* Anthropic / OpenAI Compatible / Local / Mock 四通道

* 并行工具执行 + 工具结果缓存

## V1.0 — 基石

* Agent 自主循环 + 7 个内置工具

* 内存文件系统 + diff 预览 + 确认写入

* 交互式 Ink UI + 纯文本回退

***

## 路线图（下一步）

| 版本   | 主题  | 关键项                               |
| ---- | --- | --------------------------------- |
| V4.4 | 生态  | 插件开发脚手架（示例插件模板 + 协议文档站点）、插件市场索引协议 |
| V5.0 | 规模化 | 多仓库工作区、团队协作会话共享、企业级权限             |

