/**
 * V5.34 查询语义扩展（中英技术同义词 + 驼峰子词）
 * ==========================================
 *
 * 动机：中文口语查询（"支付扣款怎么做的"）与英文命名代码
 * （PaymentGateway.charge）零词面交集——语义路只能靠 CJK bigram 落空。
 * 查询扩展在语义路注入同组词的低权重 token，让跨语言查询可召回。
 *
 * 设计红线：
 * - **只进语义路**：符号路（精确匹配）与关键词路（子串窗口）不扩展——
 *   误扩展的代价是假阳性窗口，语义路有 IDF + 阈值双重防线兜底。
 * - **低权重**：扩展 token 权重打 0.4 折——原词永远主导，扩展只补位。
 * - **df=0 跳过**（V5.33）：扩展词在库内无命中时零权重，不稀释不误召回。
 */

/**
 * 中英技术同义词组：组内任一词出现在查询中，其余成员作为扩展 token。
 * 领域：通用后端/前端/工具链词汇。组内中英混合，双向生效。
 */
const SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  // 认证与用户
  ['登录', 'login', 'signin'],
  ['注销', '登出', 'logout', 'signout'],
  ['注册', 'register', 'signup'],
  ['用户', 'user'],
  ['密码', 'password'],
  ['权限', 'permission', 'auth', 'authorization'],
  ['验证', 'verify', 'validate', 'auth'],
  ['会话', 'session'],
  ['令牌', '凭据', 'token'],
  ['角色', 'role'],
  // 交易
  ['支付', 'pay', 'payment', 'charge'],
  ['扣款', 'charge', 'debit'],
  ['退款', 'refund'],
  ['订单', 'order'],
  ['购物车', 'cart', 'basket'],
  ['结算', 'checkout', 'settle'],
  ['价格', '金额', 'price', 'amount'],
  ['库存', 'inventory', 'stock'],
  // 数据
  ['数据库', 'database', 'db'],
  ['查询', 'query', 'find', 'search'],
  ['创建', 'create', 'add', 'new'],
  ['删除', 'remove', 'delete', 'drop'],
  ['更新', 'update', 'modify', 'edit'],
  ['保存', 'save', 'persist', 'store'],
  ['缓存', 'cache'],
  ['索引', 'index'],
  ['迁移', 'migration'],
  ['事务', 'transaction'],
  // 基础设施
  ['配置', 'config', 'configuration'],
  ['日志', 'log', 'logger', 'logging'],
  ['重试', 'retry'],
  ['超时', 'timeout'],
  ['上传', 'upload'],
  ['下载', 'download'],
  ['导入', 'import'],
  ['导出', 'export'],
  ['队列', 'queue'],
  ['任务', 'task', 'job'],
  ['调度', 'schedule', 'cron'],
  ['锁', 'lock'],
  // Web / 前端
  ['路由', 'route', 'router'],
  ['接口', 'api', 'endpoint'],
  ['请求', 'request'],
  ['响应', '回复', 'response'],
  ['页面', 'page', 'view'],
  ['组件', 'component'],
  ['样式', 'style', 'css'],
  ['渲染', 'render'],
  ['状态', 'state', 'status'],
  ['表单', 'form'],
  // 通信
  ['邮件', 'email', 'mail'],
  ['消息', 'message'],
  ['通知', 'notify', 'notification'],
  ['推送', 'push'],
  // 工程化
  ['测试', 'test'],
  ['基准', 'benchmark', 'bench'],
  ['插件', 'plugin', 'extension'],
  ['工具', 'tool', 'utility'],
  ['命令行', 'cli', 'terminal'],
  ['文档', 'doc', 'documentation', 'readme'],
  ['依赖', 'dependency', 'import'],
  ['仓库', '存储', 'repo', 'repository', 'store'],
  ['版本', 'version'],
  ['回滚', 'rollback', 'revert'],
  // 领域概念（本产品语境）
  ['召回', 'recall'],
  ['上下文', 'context'],
  ['语义', 'semantic'],
  ['关键词', 'keyword'],
  ['符号', 'symbol'],
  ['文件', 'file'],
  ['目录', '文件夹', 'directory', 'folder'],
  ['权重', 'weight'],
  ['阈值', 'threshold'],
  ['预算', 'budget'],
  ['窗口', 'window'],
  ['沙箱', 'sandbox'],
  ['提供者', 'provider'],
  ['模型', 'model'],
  ['代理', 'agent'],
  ['智能体', 'agent'],
];

/** 词 → 同组其余成员（构建期展开，查询 O(1)） */
const SYNONYM_MAP: ReadonlyMap<string, ReadonlyArray<string>> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const others = group.filter((w) => w !== word);
      const existing = map.get(word);
      map.set(word, existing ? [...new Set([...existing, ...others])] : others);
    }
  }
  return map;
})();

/**
 * V5.38 置信度分级：词 → 合并组规模。
 * SYNONYM_MAP 跨组并了同词（auth 连通 "验证" 与 "权限" 两组）——
 * 置信度必须按合并后的连通词集算，否则跨组词拿到虚高折扣。
 * 连通集规模 2 = 一一对应（用户↔user）；>2 = 多对多，任一配对只是"可能"。
 */
const WORD_GROUP_SIZE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [word, syns] of SYNONYM_MAP) {
    map.set(word, syns.length + 1); // 连通集 = 自身 + 全部同义词
  }
  return map;
})();

/** 一一对应组（规模 2）的扩展折扣：翻译确定性高 */
export const EXPANSION_DISCOUNT_EXACT = 0.6;
/** 多对多组的扩展折扣：任一配对只是"可能" */
export const EXPANSION_DISCOUNT_AMBIGUOUS = 0.3;

/**
 * V5.41 逐对精确映射：显式声明"原词 → 扩展词"的确定配对。
 * 组规模分级（V5.38）对多词组内所有配对一视同仁——但 `登录→login`
 * 是主翻译（高置信），`登录→signin` 只是近义（低置信）。逐对声明
 * 打破组粒度限制：多词组内的主翻译拿满折扣，近义成员保持保守。
 */
const EXACT_PAIRS: ReadonlySet<string> = new Set([
  '登录→login', '注销→logout', '注册→register', '用户→user', '密码→password',
  '会话→session', '令牌→token', '凭据→token',
  '支付→pay', '退款→refund', '订单→order', '购物车→cart', '结算→checkout',
  '数据库→database', '查询→query', '创建→create', '删除→delete', '更新→update',
  '保存→save', '保存→store', '缓存→cache', '索引→index', '事务→transaction',
  '配置→config', '日志→log', '重试→retry', '超时→timeout',
  '上传→upload', '下载→download', '导入→import', '导出→export', '队列→queue',
  '路由→route', '请求→request', '响应→response', '页面→page', '组件→component',
  '渲染→render', '表单→form', '邮件→email', '消息→message', '通知→notify',
  '测试→test', '插件→plugin', '工具→tool', '文档→doc', '版本→version',
  '仓库→repo', '存储→store', '回滚→rollback',
  '召回→recall', '上下文→context', '语义→semantic', '关键词→keyword',
  '符号→symbol', '文件→file', '目录→directory', '文件夹→directory',
  '权重→weight', '阈值→threshold', '预算→budget', '窗口→window',
  '沙箱→sandbox', '提供者→provider', '模型→model',
]);

/**
 * V5.41 逐对折扣：显式精确配对 → EXACT；
 * 否则回落组规模分级（触发词/目标词折扣取大——V5.38 语义）。
 * 任一词不在词典 → 0（无配对可言，max 会误抬词典内单侧词的折扣）。
 */
export function pairDiscountOf(from: string, to: string): number {
  if (EXACT_PAIRS.has(`${from}→${to}`)) return EXPANSION_DISCOUNT_EXACT;
  const fromD = expansionDiscountOf(from);
  const toD = expansionDiscountOf(to);
  if (fromD === 0 || toD === 0) return 0;
  return Math.max(fromD, toD);
}

/** 按组规模取折扣（词不在词典 → 0） */
export function expansionDiscountOf(word: string): number {
  const size = WORD_GROUP_SIZE.get(word) ?? 0;
  if (size === 0) return 0;
  return size <= 2 ? EXPANSION_DISCOUNT_EXACT : EXPANSION_DISCOUNT_AMBIGUOUS;
}

export interface QueryExpansion {
  /** 原查询 token（含驼峰子词拆分） */
  tokens: string[];
  /** 扩展 token → 权重折扣（V5.38 分级：一一对应 0.6 / 多对多 0.3） */
  expansions: Map<string, number>;
  /** 扩展来源（可观测：哪个词触发了哪些扩展 + 置信度） */
  sources: Array<{ from: string; to: string[]; discount: number }>;
}

/**
 * 查询扩展：提取 token（含子词拆分）+ 同义词扩展。
 * 纯函数、无状态——语义路每次查询调用，代价可忽略。
 */
export function expandQuery(query: string): QueryExpansion {
  // 子词拆分复用引擎分词器语义：词 + camelCase/snake_case 拆分（无 trigram/bigram）
  const rawWords = query.match(/[A-Za-z0-9_$]+/g) ?? [];
  const tokens: string[] = [];
  for (const raw of rawWords) {
    const w = raw.toLowerCase();
    tokens.push(w);
    const subwords = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2 && s !== w);
    tokens.push(...subwords);
  }
  // CJK：连续段作为词参与同义词匹配
  const cjkWords = query.match(/[\u4e00-\u9fa5]+/g) ?? [];
  tokens.push(...cjkWords);

  const uniqueTokens = [...new Set(tokens.filter((t) => t.length >= 2))];
  const tokenSet = new Set(uniqueTokens);

  // 匹配词：CJK 连续段额外做词典子串扫描——
  // "支付扣款怎么实现的" 整段不是词典词，但包含 "支付"/"扣款"。
  const cjkRuns = query.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const matchWords = [...uniqueTokens];
  const seenMatch = new Set(uniqueTokens);
  for (const run of cjkRuns) {
    for (const dictWord of SYNONYM_MAP.keys()) {
      // 词典里的中文词（≥2 字）作为子串出现在 CJK 段中 → 视为命中词
      if (/[\u4e00-\u9fa5]/.test(dictWord) && run.includes(dictWord) && !seenMatch.has(dictWord)) {
        matchWords.push(dictWord);
        seenMatch.add(dictWord);
      }
    }
  }

  const expansions = new Map<string, number>();
  const sources: Array<{ from: string; to: string[]; discount: number }> = [];
  for (const tok of matchWords) {
    const synonyms = SYNONYM_MAP.get(tok);
    if (!synonyms) continue;
    const added: string[] = [];
    let pairSum = 0;
    for (const syn of synonyms) {
      if (tokenSet.has(syn) || expansions.has(syn)) continue; // 已有词不重复扩展
      // V5.41 逐对折扣：显式精确配对满折扣，其余回落组规模分级（V5.38 max 语义）
      const d = pairDiscountOf(tok, syn);
      expansions.set(syn, d);
      added.push(syn);
      pairSum += d;
    }
    if (added.length > 0) {
      // 触发词级折扣 = 该词全部配对折扣的均值（可观测性：sources 保持单值）
      sources.push({ from: tok, to: added, discount: Number((pairSum / added.length).toFixed(2)) });
    }
  }

  return { tokens: uniqueTokens, expansions, sources };
}

/**
 * V5.36 反查：token 的中文同义词（bench 跨语言语料生成用）。
 * payment → ['支付']；无词典命中 / 无中文成员 → 空数组。
 */
export function chineseSynonymsOf(token: string): string[] {
  const syms = SYNONYM_MAP.get(token.toLowerCase()) ?? [];
  return syms.filter((s) => /[\u4e00-\u9fa5]/.test(s));
}
