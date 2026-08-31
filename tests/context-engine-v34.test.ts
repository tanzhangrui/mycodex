/**
 * V3.4 上下文进阶测试 — 对应 V3.4-ITERATION-PROMPT.md 执行清单
 * 覆盖：n-gram 分词（token 覆盖率匹配）/ 语义召回 / 索引持久化（指纹校验）/ 增量刷新 / 共享单例
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import {
  ContextEngine,
  tokenizeForEmbedding,
  getSharedContextEngine,
  resetSharedContextEngine,
  collectGitChangedFiles,
} from '../src/context/context-engine.js';

// V3.4：隔离配置目录，持久化缓存绝不污染真实用户 home
let configDir: string;
let root: string;
let engine: ContextEngine;

const AUTH_TS = `export class AuthService {
  async login(user: string, pass: string): Promise<string> {
    // 验证用户名密码并签发 token
    return 'token';
  }

  async logout(): Promise<void> {
    // 注销当前会话
  }
}
`;

const CART_TS = `export class CartService {
  addItem(sku: string, qty: number): void {
    // 购物车添加商品
  }

  checkout(): Promise<number> {
    // 结算订单总价
    return Promise.resolve(0);
  }
}
`;

beforeAll(async () => {
  configDir = join(tmpdir(), `codex-test-config-v34-${Date.now()}`);
  process.env.CODEX_CONFIG_PATH = configDir;

  root = mkdtempSync(join(tmpdir(), 'codex-ctx-v34-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'auth-service.ts'), AUTH_TS);
  writeFileSync(join(root, 'src', 'cart-service.ts'), CART_TS);

  engine = new ContextEngine();
  await engine.index(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  resetSharedContextEngine();
});

// ---- n-gram 分词（token 覆盖率匹配的基元） ----

describe('tokenizeForEmbedding', () => {
  it('空文本/纯空白无 token（语义召回直接短路）', () => {
    expect(tokenizeForEmbedding('')).toEqual([]);
    expect(tokenizeForEmbedding('   ')).toEqual([]);
  });

  it('英文词 unigram + 词间 bigram', () => {
    const tokens = tokenizeForEmbedding('user login');
    expect(tokens).toContain('user');
    expect(tokens).toContain('login');
    expect(tokens).toContain('user_login');
  });

  it('词内字符 trigram：词形变体共享模糊信号（login vs logging）', () => {
    const login = tokenizeForEmbedding('login');
    const logging = tokenizeForEmbedding('logging');
    expect(login).toContain('log');
    expect(login).toContain('gin');
    // login 与 logging 共享 log/gog/in 等字符 trigram → 覆盖率非零
    const shared = login.filter((t) => logging.includes(t));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('短词（<4 字符）不产生字符 trigram（避免噪声）', () => {
    // 'abc' 仅产生词 token 本身，无额外字符切片
    expect(tokenizeForEmbedding('abc')).toEqual(['abc']);
  });

  it('CJK 字 bigram 判别力', () => {
    const tokens = tokenizeForEmbedding('用户登录');
    expect(tokens).toContain('用户');
    expect(tokens).toContain('户登');
    expect(tokens).toContain('登录');
  });
});

// ---- 语义召回 ----

describe('semanticRecall', () => {
  it('口语化查询能召回相关文件（关键词/符号都命不中的兜底）', () => {
    // "验证" 不出现在任何符号名中，auth 文件内容含"验证"
    const chunks = engine.semanticRecall('用户登录怎么验证的');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].path).toBe('src/auth-service.ts');
  });

  it('不相关查询被阈值过滤或低排序', () => {
    const chunks = engine.semanticRecall('购物车结算总价');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].path).toBe('src/cart-service.ts');
  });

  it('语义相关性介于关键词与符号之间（≤80）', () => {
    const chunks = engine.semanticRecall('用户登录怎么验证的');
    for (const c of chunks) {
      expect(c.relevance).toBeLessThanOrEqual(80);
      expect(c.relevance).toBeGreaterThan(0);
    }
  });

  it('空查询返回空（无 token 无语义信号）', () => {
    expect(engine.semanticRecall('   ')).toEqual([]);
  });

  it('无信号短查询被覆盖率过滤（哈希碰撞回归：zzz 不再误命中）', () => {
    expect(engine.semanticRecall('zzz')).toEqual([]);
  });
});

// ---- 四路召回融合 ----

describe('assembleContext（V3.4 四路融合）', () => {
  it('语义命中文件进入最终上下文', () => {
    const chunks = engine.assembleContext('用户登录怎么验证的');
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain('src/auth-service.ts');
  });
});

// ---- V5.4 IDF 加权语义召回 ----

describe('semanticRecall IDF 加权（V5.4）', () => {
  let idfRoot: string;
  let idfEngine: ContextEngine;

  beforeAll(async () => {
    idfRoot = mkdtempSync(join(tmpdir(), 'codex-ctx-v54-'));
    mkdirSync(join(idfRoot, 'src'), { recursive: true });
    // 目标文件：唯一含 createUser / 创建用户 的文件（同时含常见 token export/const）
    writeFileSync(
      join(idfRoot, 'src', 'user-service.ts'),
      `export const createUser = (name: string) => {\n  // 创建用户 记录审计日志\n  return { id: 1, name };\n};\n`,
    );
    // 10 个填充文件：仅含常见 token（export/const），无任何区分性词
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(idfRoot, 'src', `filler-${i}.ts`),
        `export const value${i} = ${i};\nexport const helper${i} = () => value${i} * 2;\n`,
      );
    }
    idfEngine = new ContextEngine();
    await idfEngine.index(idfRoot);
  });

  afterAll(() => {
    rmSync(idfRoot, { recursive: true, force: true });
  });

  it('区分性 token 主导：仅常见词的文件被 IDF 压到阈值之下（不再虚高召回）', () => {
    // 混合查询：区分性词（createUser/创建用户）+ 常见词（export）
    // 旧版（无 IDF）：填充文件仅靠 export 覆盖率即可越过 0.15 阈值入榜；
    // IDF 后常见 token 权重被文档频率压低 → 填充文件覆盖率跌破阈值被过滤
    const chunks = idfEngine.semanticRecall('createUser 创建用户 export');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].path).toBe('src/user-service.ts');
    expect(chunks.every((c) => c.path === 'src/user-service.ts')).toBe(true);
  });

  it('常见词更重的混合查询：目标文件仍排第一，常见词文件严格靠后', () => {
    const chunks = idfEngine.semanticRecall('export const createUser');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].path).toBe('src/user-service.ts');
    const target = chunks[0];
    for (const c of chunks) {
      if (c.path !== target.path) {
        expect(c.path.startsWith('src/filler-')).toBe(true);
        expect(c.relevance).toBeLessThan(target.relevance);
      }
    }
  });

  it('单文件退化：IDF 均匀（N=1），召回行为正常不除零', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-ctx-v54-solo-'));
    mkdirSync(join(solo, 'src'), { recursive: true });
    writeFileSync(join(solo, 'src', 'only.ts'), `export const only = 1;\n`);
    const e = new ContextEngine();
    await e.index(solo);
    const chunks = e.semanticRecall('only export');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].path).toBe('src/only.ts');
    rmSync(solo, { recursive: true, force: true });
  });

  it('无信号查询依旧被过滤（IDF 不引入误召回）', () => {
    expect(idfEngine.semanticRecall('zzz')).toEqual([]);
    expect(idfEngine.semanticRecall('   ')).toEqual([]);
  });
});

// ---- 索引持久化 ----

describe('索引持久化', () => {
  it('符号索引构建后落盘到配置目录缓存', async () => {
    engine.resolveQuerySymbols('AuthService'); // 触发构建 + 排队落盘
    await engine.flushIndexCache();

    const cacheDir = join(configDir, 'cache', 'context');
    expect(existsSync(cacheDir)).toBe(true);
    const cacheFiles = readdirSync(cacheDir);
    expect(cacheFiles.length).toBeGreaterThan(0);
    const content = readFileSync(join(cacheDir, cacheFiles[0]), 'utf-8');
    expect(content).toContain('src/auth-service.ts');
    expect(content).toContain('AuthService');
  });

  it('跨实例复用：新引擎同目录索引后符号查询等价（种子免读盘）', async () => {
    const second = new ContextEngine();
    await second.index(root);
    // 触发种子路径（persistedSymbols → symbolCache，不读盘）
    const hits = second.resolveQuerySymbols('AuthService login');
    expect(hits.some((s) => s.name === 'AuthService')).toBe(true);
    expect(hits.some((s) => s.name === 'login')).toBe(true);
    await second.flushIndexCache();
  });

  it('指纹失配即弃：文件修改后持久化符号不被采用', async () => {
    // 修改 auth-service.ts（mtime 变化）
    const target = join(root, 'src', 'auth-service.ts');
    const original = readFileSync(target, 'utf-8');
    writeFileSync(target, original + '\nexport function freshSymbol(): void {}\n');
    utimesSync(target, new Date(), new Date());

    const third = new ContextEngine();
    await third.index(root);
    // 新符号应可见（若旧持久化符号被错误采用则看不到 freshSymbol）
    const hits = third.resolveQuerySymbols('freshSymbol');
    expect(hits.some((s) => s.name === 'freshSymbol')).toBe(true);

    // 还原
    writeFileSync(target, original);
    utimesSync(target, new Date(), new Date());
  });
});

// ---- V5.16 持久化格式 v2 ----

describe('V5.16 持久化格式 v2（imports 种子 + 多根/别名元数据）', () => {
  /** 按 persistKey 找到对应的缓存文件并解析（找不到返回 null） */
  function readCacheFor(persistKey: string): Record<string, unknown> | null {
    const dir = join(configDir, 'cache', 'context');
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir)) {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
        if (data.workingDir === persistKey) return data;
      } catch {
        // 非法 JSON 跳过
      }
    }
    return null;
  }

  it('imports 落盘 + 跨实例种子复用：索引后改盘上内容，种子仍返回解析结果（免读盘）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v516-seed-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'a.ts'), `import { b } from './b';\nexport const a = b;\n`);
    writeFileSync(join(r, 'src', 'b.ts'), `export const b = 1;\n`);

    const first = new ContextEngine();
    await first.index(r);
    expect(first.parseImports('src/a.ts')).toEqual(['src/b.ts']);
    first.resolveQuerySymbols('seedMarker'); // 触发 buildSymbolIndex → 排队落盘（含 imports；单字符 token 会被过滤）
    await first.flushIndexCache();

    const cache = readCacheFor(resolve(r));
    expect(cache).not.toBeNull();
    expect(cache!.version).toBe(2);
    expect(Array.isArray(cache!.roots)).toBe(true);
    expect(typeof cache!.structureHash).toBe('string');
    const aEntry = (cache!.files as Array<{ path: string; imports: string[] }>).find((f) => f.path === 'src/a.ts');
    expect(aEntry?.imports).toEqual(['src/b.ts']);

    // 新实例：加载种子后，把盘上 a.ts 改成无 import——种子不读盘，结果不变
    const second = new ContextEngine();
    await second.index(r);
    writeFileSync(join(r, 'src', 'a.ts'), `export const a = 'no imports now';\n`);
    expect(second.parseImports('src/a.ts')).toEqual(['src/b.ts']);
    rmSync(r, { recursive: true, force: true });
  });

  it('结构指纹门控：新增文件后陈旧 imports 种子被弃用（重解析发现新目标）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v516-gate-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    // helper.ts 尚不存在 → 此时 a.ts 的 import 解析为空
    writeFileSync(join(r, 'src', 'a.ts'), `import { helper } from './helper';\nexport const a = helper;\n`);

    const first = new ContextEngine();
    await first.index(r);
    expect(first.parseImports('src/a.ts')).toEqual([]);
    first.resolveQuerySymbols('gateMarker'); // 触发落盘（imports: [] 也持久化；单字符 token 会被过滤）
    await first.flushIndexCache();

    // 新增 helper.ts：路径集变化 → 结构指纹失配 → 空种子被弃用，重新读盘解析
    writeFileSync(join(r, 'src', 'helper.ts'), `export const helper = 1;\n`);
    const second = new ContextEngine();
    await second.index(r);
    expect(second.parseImports('src/a.ts')).toEqual(['src/helper.ts']);
    rmSync(r, { recursive: true, force: true });
  });

  it('别名清单变化 → 结构指纹失配：imports 种子弃用（重解析走新别名）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v516-alias-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'v516-app', version: '0.0.0' }));
    writeFileSync(join(r, 'src', 'a.ts'), `import { x } from 'v516-lib';\nexport const a = x;\n`);
    mkdirSync(join(r, 'node_modules'), { recursive: true }); // 不入索引，仅为语义真实

    const first = new ContextEngine();
    await first.index(r);
    expect(first.parseImports('src/a.ts')).toEqual([]); // 无 v516-lib 根 → 不解析
    first.resolveQuerySymbols('aliasMarker');
    await first.flushIndexCache();

    // 单根添加 package.json 别名不会生效（别名仅多根）——改用 tsconfig paths 触发清单变化
    writeFileSync(
      join(r, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'v516-lib': ['src/lib.ts'] } } }),
    );
    writeFileSync(join(r, 'src', 'lib.ts'), `export const x = 1;\n`);

    const second = new ContextEngine();
    await second.index(r);
    // tsconfig 新增（清单指纹变化）+ 新文件（路径集变化）→ 种子弃用，走 paths 别名解析
    expect(second.parseImports('src/a.ts')).toEqual(['src/lib.ts']);
    rmSync(r, { recursive: true, force: true });
  });

  it('v1 缓存向后兼容：旧格式仍加载符号种子', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v516-v1-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 's.ts'), `export function realFn(): void {}\n`);

    const first = new ContextEngine();
    await first.index(r);
    first.resolveQuerySymbols('realFn');
    await first.flushIndexCache();

    // 手工降级缓存为 v1 格式（去 roots/manifests/structureHash/imports），并注入幽灵符号
    const dir = join(configDir, 'cache', 'context');
    const target = readdirSync(dir).find((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf-8')).workingDir === resolve(r);
      } catch {
        return false;
      }
    })!;
    const v2 = JSON.parse(readFileSync(join(dir, target), 'utf-8')) as {
      files: Array<{ path: string; size: number; mtime: number; symbols: Array<{ name: string; kind: string; line: number }> }>;
    };
    const ghostEntry = v2.files.find((f) => f.path === 'src/s.ts')!;
    ghostEntry.symbols.push({ name: 'GhostSymbol', kind: 'function', line: 99 });
    const v1 = {
      version: 1,
      workingDir: resolve(r),
      files: v2.files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, symbols: f.symbols })),
    };
    writeFileSync(join(dir, target), JSON.stringify(v1), 'utf-8');

    // v1 缓存被接受：幽灵符号可见（证明种子来自持久化而非读盘）
    const second = new ContextEngine();
    await second.index(r);
    const hits = second.resolveQuerySymbols('GhostSymbol');
    expect(hits.some((s) => s.name === 'GhostSymbol')).toBe(true);
    rmSync(r, { recursive: true, force: true });
  });

  it('多根元数据落盘：roots 双根 + 跨根键空间 imports 种子复用', async () => {
    const rA = mkdtempSync(join(tmpdir(), 'codex-v516-mr-a-'));
    const rB = mkdtempSync(join(tmpdir(), 'codex-v516-mr-b-'));
    mkdirSync(join(rA, 'src'), { recursive: true });
    mkdirSync(join(rB, 'src'), { recursive: true });
    writeFileSync(join(rA, 'src', 'a.ts'), `import { b } from './b';\nexport const a = b;\n`);
    writeFileSync(join(rA, 'src', 'b.ts'), `export const b = 1;\n`);
    writeFileSync(join(rB, 'src', 'c.ts'), `export const c = 2;\n`);

    const nameA = basename(rA); // WorkspaceResolver 根名 = 目录 basename（无冲突不去重）
    const first = new ContextEngine();
    await first.index([rA, rB]);
    expect(first.parseImports(`${nameA}/src/a.ts`)).toEqual([`${nameA}/src/b.ts`]);
    const cache0 = readCacheFor([resolve(rA), resolve(rB)].join('|'));
    expect(cache0).toBeNull(); // 尚未落盘
    first.resolveQuerySymbols('multiRootMarker');
    await first.flushIndexCache();

    const cache = readCacheFor([resolve(rA), resolve(rB)].join('|'));
    expect(cache).not.toBeNull();
    const roots = cache!.roots as Array<{ name: string; abs: string }>;
    expect(roots).toHaveLength(2);
    expect(roots.map((x) => x.abs)).toContain(resolve(rA));
    expect(roots.map((x) => x.abs)).toContain(resolve(rB));
    expect(roots.find((x) => x.abs === resolve(rA))!.name).toBe(nameA);

    // 跨实例：统一键空间（rootName/rel）的 imports 种子复用
    const second = new ContextEngine();
    await second.index([rA, rB]);
    expect(second.parseImports(`${nameA}/src/a.ts`)).toEqual([`${nameA}/src/b.ts`]);
    rmSync(rA, { recursive: true, force: true });
    rmSync(rB, { recursive: true, force: true });
  });
});

// ---- V5.18 索引体检报告 ----

describe('V5.18 getContextReport（codex context stats 数据源）', () => {
  it('单根：规模/别名/缓存字段齐全，无缓存 → persisted null', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v518-solo-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'a.ts'), `import { b } from './b';\nexport class Alpha {}\n`);
    writeFileSync(join(r, 'src', 'b.ts'), `export function beta(): void {}\n`);
    writeFileSync(join(r, 'README.md'), `非源码文件\n`);

    const e = new ContextEngine();
    await e.index(r);
    const report = e.getContextReport();

    expect(report.mode).toBe('single');
    expect(report.roots).toHaveLength(1);
    expect(report.roots[0].fileCount).toBe(3);
    expect(report.fileCount).toBe(3);
    expect(report.sourceFileCount).toBe(2); // README.md 不计
    expect(report.symbolCount).toBeGreaterThanOrEqual(2); // Alpha + beta
    expect(report.importEdgeCount).toBe(1); // a.ts → b.ts
    expect(report.persisted).toBeNull(); // 首次索引无缓存
    expect(report.topFiles.length).toBeGreaterThan(0);
    expect(report.topFiles[0].symbols).toBeGreaterThanOrEqual(report.topFiles[report.topFiles.length - 1].symbols);
    rmSync(r, { recursive: true, force: true });
  });

  it('缓存诊断：落盘后新实例 v2 命中（结构一致 → 种子计数 > 0）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v518-cache-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'a.ts'), `import { b } from './b';\nexport class Alpha {}\n`);
    writeFileSync(join(r, 'src', 'b.ts'), `export function beta(): void {}\n`);

    const first = new ContextEngine();
    await first.index(r);
    first.getContextReport(); // 触发构建 + 排队落盘
    await first.flushIndexCache();

    const second = new ContextEngine();
    await second.index(r);
    const report = second.getContextReport();
    expect(report.persisted).not.toBeNull();
    expect(report.persisted!.version).toBe(2);
    expect(report.persisted!.structureOk).toBe(true);
    expect(report.persisted!.symbolSeeds).toBeGreaterThan(0);
    expect(report.persisted!.importSeeds).toBeGreaterThan(0);
    expect(report.persisted!.savedAt).toBeTruthy();
    rmSync(r, { recursive: true, force: true });
  });

  it('结构指纹失配诊断：新增文件后 structureOk false + importSeeds 归零', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v518-stale-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'a.ts'), `import { helper } from './helper';\nexport class Alpha {}\n`);

    const first = new ContextEngine();
    await first.index(r);
    first.getContextReport();
    await first.flushIndexCache();

    writeFileSync(join(r, 'src', 'helper.ts'), `export const helper = 1;\n`);
    const second = new ContextEngine();
    await second.index(r);
    const report = second.getContextReport();
    expect(report.persisted!.version).toBe(2);
    expect(report.persisted!.structureOk).toBe(false);
    expect(report.persisted!.importSeeds).toBe(0);
    // 符号种子不受结构指纹影响（逐文件指纹校验）
    expect(report.persisted!.symbolSeeds).toBeGreaterThan(0);
    rmSync(r, { recursive: true, force: true });
  });

  it('TS ESM `.js` 后缀约定：`./x.js` 解析到 `x.ts`（真实仓库主路径）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v518-esm-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'a.ts'), `import { b } from './b.js';\nexport const a = b;\n`);
    writeFileSync(join(r, 'src', 'b.ts'), `export const b = 1;\n`);
    writeFileSync(join(r, 'src', 'c.ts'), `import { d } from './sub/index.js';\nexport const c = d;\n`);
    mkdirSync(join(r, 'src', 'sub'), { recursive: true });
    writeFileSync(join(r, 'src', 'sub', 'index.ts'), `export const d = 1;\n`);
    // 真实 .js 文件仍优先命中（原样候选在前）
    writeFileSync(join(r, 'src', 'e.ts'), `import { f } from './f.js';\nexport const e = f;\n`);
    writeFileSync(join(r, 'src', 'f.js'), `export const f = 1;\n`);

    const e = new ContextEngine();
    await e.index(r);
    expect(e.parseImports('src/a.ts')).toEqual(['src/b.ts']); // .js → .ts
    expect(e.parseImports('src/c.ts')).toEqual(['src/sub/index.ts']); // 目录 + index.js → index.ts
    expect(e.parseImports('src/e.ts')).toEqual(['src/f.js']); // 真实 .js 优先
    rmSync(r, { recursive: true, force: true });
  });

  it('多根：根清单/按根文件数/包名别名计数/跨根 import 边', async () => {
    const rA = mkdtempSync(join(tmpdir(), 'codex-v518-mr-a-'));
    const rB = mkdtempSync(join(tmpdir(), 'codex-v518-mr-b-'));
    mkdirSync(join(rA, 'src'), { recursive: true });
    mkdirSync(join(rB, 'src'), { recursive: true });
    writeFileSync(join(rA, 'package.json'), JSON.stringify({ name: '@v518/app' }));
    writeFileSync(join(rB, 'package.json'), JSON.stringify({ name: '@v518/lib' }));
    writeFileSync(join(rA, 'src', 'main.ts'), `import { core } from '@v518/lib/src/core';\nexport class Main {}\n`);
    writeFileSync(join(rB, 'src', 'core.ts'), `export function core(): void {}\n`);
    writeFileSync(join(rB, 'src', 'util.ts'), `export function util(): void {}\n`);

    const e = new ContextEngine();
    await e.index([rA, rB]);
    const report = e.getContextReport();

    expect(report.mode).toBe('multi');
    expect(report.roots).toHaveLength(2);
    const nameB = report.roots.find((x) => x.abs === resolve(rB))!.name;
    expect(report.roots.find((x) => x.abs === resolve(rA))!.fileCount).toBe(2); // package.json + main.ts
    expect(report.roots.find((x) => x.abs === resolve(rB))!.fileCount).toBe(3);
    expect(report.packageAliasCount).toBe(2); // @v518/app + @v518/lib
    expect(report.importEdgeCount).toBe(1); // 跨根：main.ts → lib 根 core.ts
    expect(report.topFiles.some((f) => f.path.startsWith(`${nameB}/src/`))).toBe(true);
    rmSync(rA, { recursive: true, force: true });
    rmSync(rB, { recursive: true, force: true });
  });
});

// ---- 增量刷新 ----

describe('refresh（增量更新）', () => {
  it('新增文件：刷新后符号可见', () => {
    writeFileSync(join(root, 'src', 'new-module.ts'), 'export function brandNewFn(): void {}\n');

    engine.refresh();
    const hits = engine.resolveQuerySymbols('brandNewFn');
    expect(hits.some((s) => s.name === 'brandNewFn' && s.file === 'src/new-module.ts')).toBe(true);
  });

  it('修改文件：刷新后新内容生效', () => {
    const target = join(root, 'src', 'new-module.ts');
    writeFileSync(target, 'export function replacedFn(): void {}\n');
    // 强制 mtime 前移：同尺寸写入可能落在同一毫秒，双指纹都无法区分
    utimesSync(target, new Date(), new Date(Date.now() + 5000));

    engine.refresh();
    const hits = engine.resolveQuerySymbols('replacedFn');
    expect(hits.some((s) => s.name === 'replacedFn')).toBe(true);
    // 旧符号不再出现
    const stale = engine.resolveQuerySymbols('brandNewFn');
    expect(stale.some((s) => s.name === 'brandNewFn')).toBe(false);
  });

  it('删除文件：刷新后从索引消失', () => {
    rmSync(join(root, 'src', 'new-module.ts'));

    engine.refresh();
    expect(engine.fuzzySearchFile('new-module')).toEqual([]);
    expect(engine.getFileContent('src/new-module.ts')).toBeNull();
  });
});

// ---- 共享单例 ----

describe('getSharedContextEngine（内核唯一）', () => {
  it('同目录返回同一实例', () => {
    const a = getSharedContextEngine(root);
    const b = getSharedContextEngine(root);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('不同目录返回新实例', () => {
    const other = mkdtempSync(join(tmpdir(), 'codex-ctx-v34b-'));
    try {
      const a = getSharedContextEngine(root);
      const b = getSharedContextEngine(other);
      expect(a).not.toBe(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('重置后重新构建', () => {
    const a = getSharedContextEngine(root);
    resetSharedContextEngine();
    const b = getSharedContextEngine(root);
    expect(a).not.toBe(b);
  });
});

// ---- V5.19 反向依赖 + re-export 链 ----

describe('V5.19 反向依赖索引 + re-export 链追踪', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v519-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    // widget.ts ← index.ts（barrel：export * from）← consumer.ts（真实消费者）
    writeFileSync(join(r, 'src', 'widget.ts'), 'export class WidgetService {\n  mount(): void {}\n}\n');
    writeFileSync(join(r, 'src', 'index.ts'), "export * from './widget';\nexport * from './helper';\n");
    writeFileSync(join(r, 'src', 'consumer.ts'), "import { WidgetService } from './index';\nexport function render(): void {\n  new WidgetService().mount();\n}\n");
    // 普通 import 链（非 re-export）：helper.ts ← a.ts ← b.ts
    writeFileSync(join(r, 'src', 'helper.ts'), 'export function helperFn(): void {}\n');
    writeFileSync(join(r, 'src', 'a.ts'), "import { helperFn } from './helper';\nexport const a = 1;\n");
    writeFileSync(join(r, 'src', 'b.ts'), "import { a } from './a';\nexport const b = 2;\n");
    // 多跳 barrel 链：deep.ts ← mid.ts（re-export）← top.ts（re-export）← app.ts（消费者）
    mkdirSync(join(r, 'src', 'deep'), { recursive: true });
    writeFileSync(join(r, 'src', 'deep', 'deep.ts'), 'export class DeepService {}\n');
    writeFileSync(join(r, 'src', 'mid.ts'), "export { DeepService } from './deep/deep';\n");
    writeFileSync(join(r, 'src', 'top.ts'), "export * from './mid';\n");
    writeFileSync(join(r, 'src', 'app.ts'), "import { DeepService } from './top';\nexport const app = new DeepService();\n");

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('getImportedBy：直接一级 importer（barrel 转发源文件）', () => {
    expect(e.getImportedBy('src/widget.ts')).toEqual(['src/index.ts']);
    expect(e.getImportedBy('src/helper.ts').sort()).toEqual(['src/a.ts', 'src/index.ts']);
    expect(e.getImportedBy('src/nonexistent.ts')).toEqual([]);
  });

  it('getImportedByExpanded：穿透 barrel 找到真实消费者', () => {
    const expanded = e.getImportedByExpanded('src/widget.ts');
    expect(expanded).toContain('src/index.ts'); // barrel 本身
    expect(expanded).toContain('src/consumer.ts'); // 经 re-export 链的间接消费者
  });

  it('普通 import 不穿透（过度扩散防线）', () => {
    // helper.ts ← a.ts 是普通 import：a.ts 的 importer b.ts 不算 helper 的使用点
    const expanded = e.getImportedByExpanded('src/helper.ts');
    expect(expanded).toContain('src/a.ts');
    expect(expanded).not.toContain('src/b.ts');
  });

  it('多跳 re-export 链（export {…} from 与 export * from 混合）', () => {
    const expanded = e.getImportedByExpanded('src/deep/deep.ts');
    expect(expanded).toContain('src/mid.ts');
    expect(expanded).toContain('src/top.ts');
    expect(expanded).toContain('src/app.ts'); // 两跳 barrel 后的真实消费者
  });

  it('maxHops 截断：1 跳只见 barrel，穿不到消费者', () => {
    const oneHop = e.getImportedByExpanded('src/deep/deep.ts', 1);
    expect(oneHop).toContain('src/mid.ts');
    expect(oneHop).not.toContain('src/app.ts');
  });

  it('refresh 后 re-export 边重建（删 barrel 后消费者不再穿透）', () => {
    rmSync(join(r, 'src', 'index.ts'));
    e.refresh();
    expect(e.getImportedByExpanded('src/widget.ts')).toEqual([]); // barrel 没了，穿透链断
    expect(e.getImportedBy('src/helper.ts')).toEqual(['src/a.ts']);
    // 恢复现场，供后续用例
    writeFileSync(join(r, 'src', 'index.ts'), "export * from './widget';\nexport * from './helper';\n");
    e.refresh();
  });

  it('assembleContext：使用点召回含 barrel 消费者', () => {
    const chunks = e.assembleContext('WidgetService', { maxTokens: 20_000 });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain('src/widget.ts'); // 定义（100）
    expect(paths).toContain('src/consumer.ts'); // 真实使用点（≥15，可能叠加语义命中）
    expect(paths).toContain('src/index.ts'); // barrel 使用点
    expect(chunks.find((c) => c.path === 'src/consumer.ts')!.relevance).toBeGreaterThanOrEqual(15);
  });

  it('getRelatedFiles direction=both：源文件两跳穿到消费者', () => {
    const related = e.getRelatedFiles(['src/widget.ts'], 2, 50, 'both');
    expect(related).toContain('src/index.ts');
    expect(related).toContain('src/consumer.ts');
  });
});

// ---- V5.20 召回分解 ----

describe('V5.20 debugRecall（四路召回分解）', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v520-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'order.ts'), 'export class OrderService {\n  refund(): void {}\n}\n');
    writeFileSync(join(r, 'src', 'index.ts'), "export * from './order';\n");
    writeFileSync(join(r, 'src', 'page.ts'), "import { OrderService } from './index';\nexport function renderRefund(o: OrderService): void {\n  o.refund();\n}\n");

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('分解字段齐全：逐路命中 + 最终组装', () => {
    // 混合查询：order（文件名关键词 → 关键词召回）+ OrderService（符号前缀 → 符号召回）
    const bd = e.debugRecall('order refund OrderService');
    expect(bd.keywords.length).toBeGreaterThan(0);
    expect(bd.symbols.some((s) => s.name === 'OrderService' && s.file === 'src/order.ts')).toBe(true);
    expect(bd.semantic.length).toBeGreaterThan(0);
    expect(bd.semantic.some((c) => c.path === 'src/index.ts')).toBe(true); // barrel 也被语义召回
    expect(bd.keywordsHits.length).toBeGreaterThan(0);
    expect(bd.keywordsHits.some((c) => c.path === 'src/order.ts')).toBe(true);
    expect(bd.usageSites).toContain('src/page.ts'); // re-export 链穿透后的消费者
    expect(bd.assembled.length).toBeGreaterThan(0);
    expect(bd.assembled.some((c) => c.path === 'src/order.ts')).toBe(true);
  });

  it('related：种子文件 deps 1 跳（且排除已被其他路召回的种子）', () => {
    // page render：命中 page.ts（符号前缀 + 文件名关键词），index.ts 不被其他路召回
    const bd = e.debugRecall('page render');
    expect(bd.symbols.some((s) => s.file === 'src/page.ts')).toBe(true);
    expect(bd.related).toContain('src/index.ts'); // page.ts → deps 1 跳
    // order 查询：semantic 已召回 index.ts → 它进种子集合，related 不重复出现
    const bd2 = e.debugRecall('order refund OrderService');
    expect(bd2.semantic.some((c) => c.path === 'src/index.ts')).toBe(true);
    expect(bd2.related).not.toContain('src/index.ts');
  });

  it('usageSites 穿透 barrel（消费者经 index.ts 归位到真实使用点）', () => {
    const bd = e.debugRecall('OrderService');
    expect(bd.usageSites).toContain('src/index.ts');
    expect(bd.usageSites).toContain('src/page.ts');
  });

  it('assembled 与 assembleContext 同参结果一致', () => {
    const bd = e.debugRecall('OrderService refund', { maxTokens: 8_000 });
    const direct = e.assembleContext('OrderService refund', { maxTokens: 8_000 });
    expect(bd.assembled.map((c) => `${c.path}:${c.startLine}`)).toEqual(
      direct.map((c) => `${c.path}:${c.startLine}`),
    );
  });

  it('无命中查询：各路为空、组装为空（不抛错）', () => {
    const bd = e.debugRecall('zzzqqqxxx');
    expect(bd.symbols).toEqual([]);
    expect(bd.semantic).toEqual([]);
    expect(bd.usageSites).toEqual([]);
    expect(bd.assembled).toEqual([]);
  });
});

// ---- V5.21 使用点分层 ----

describe('V5.21 getImportedByLayered（使用点跳数分层）', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v521-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    // widget.ts ← index.ts（re-export）← consumer.ts；helper.ts 双链（index 转发 + a.ts 直接 import）
    writeFileSync(join(r, 'src', 'widget.ts'), 'export class WidgetService {}\n');
    writeFileSync(join(r, 'src', 'helper.ts'), 'export function helperFn(): void {}\n');
    writeFileSync(join(r, 'src', 'index.ts'), "export * from './widget';\nexport * from './helper';\n");
    writeFileSync(join(r, 'src', 'consumer.ts'), "import { WidgetService } from './index';\nexport const c = 1;\n");
    writeFileSync(join(r, 'src', 'a.ts'), "import { helperFn } from './helper';\nexport const a = 1;\n");

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('hop 值：直接 importer 1，barrel 间接消费者 2', () => {
    const layered = e.getImportedByLayered('src/widget.ts');
    const byFile = new Map(layered.map((x) => [x.file, x.hop]));
    expect(byFile.get('src/index.ts')).toBe(1); // barrel（直接 re-exporter）
    expect(byFile.get('src/consumer.ts')).toBe(2); // 经 barrel 的间接消费者
  });

  it('多链可达取最短跳：helper 经 index（hop 2 到 consumer）与 a.ts（hop 1）', () => {
    const byFile = new Map(e.getImportedByLayered('src/helper.ts').map((x) => [x.file, x.hop]));
    expect(byFile.get('src/index.ts')).toBe(1);
    expect(byFile.get('src/a.ts')).toBe(1);
    expect(byFile.get('src/consumer.ts')).toBe(2); // consumer 不 import helper，仅经 barrel 链可达
  });

  it('与 getImportedByExpanded 文件集合一致（分层是同一 BFS 的视图）', () => {
    const layered = e.getImportedByLayered('src/widget.ts').map((x) => x.file).sort();
    const expanded = [...e.getImportedByExpanded('src/widget.ts')].sort();
    expect(layered).toEqual(expanded);
  });

  it('maxHops 截断分层同样生效', () => {
    const byFile = new Map(e.getImportedByLayered('src/widget.ts', 1).map((x) => [x.file, x.hop]));
    expect(byFile.has('src/index.ts')).toBe(true);
    expect(byFile.has('src/consumer.ts')).toBe(false);
  });
});

// ---- V5.22 Python __init__.py re-export 链 ----

describe('V5.22 Python __init__.py re-export 穿透', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v522-'));
    mkdirSync(join(r, 'pkg'), { recursive: true });
    // pkg/helper.py ← pkg/__init__.py（`from .helper import Helper` 转发）← consumer.py
    writeFileSync(join(r, 'pkg', '__init__.py'), 'from .helper import Helper\nfrom .extra import Extra\n');
    writeFileSync(join(r, 'pkg', 'helper.py'), 'class Helper:\n    def run(self):\n        pass\n');
    writeFileSync(join(r, 'pkg', 'extra.py'), 'class Extra:\n    pass\n');
    // `from . import helper` 形态的转发（dotImport 展开）
    mkdirSync(join(r, 'pkg2'), { recursive: true });
    writeFileSync(join(r, 'pkg2', '__init__.py'), 'from . import tool\n');
    writeFileSync(join(r, 'pkg2', 'tool.py'), 'def tool_fn():\n    pass\n');
    writeFileSync(join(r, 'consumer.py'), 'from .pkg import Helper\nfrom .pkg2 import tool\n\ndef use(h: Helper):\n    return h.run()\n');
    // 负例：普通模块间 import 不构成转发边
    writeFileSync(join(r, 'mod_a.py'), 'def a_fn():\n    pass\n');
    writeFileSync(join(r, 'mod_b.py'), 'from .mod_a import a_fn\n\ndef b_fn():\n    return a_fn()\n');
    writeFileSync(join(r, 'mod_c.py'), 'from .mod_b import b_fn\n\ndef c_fn():\n    return b_fn()\n');

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('__init__.py 转发：穿透包入口找到真实消费者（from .mod import X 形态）', () => {
    const expanded = e.getImportedByExpanded('pkg/helper.py');
    expect(expanded).toContain('pkg/__init__.py'); // 包入口（转发者）
    expect(expanded).toContain('consumer.py'); // 经包入口的间接消费者
  });

  it('`from . import mod` 形态同样构成转发边', () => {
    const expanded = e.getImportedByExpanded('pkg2/tool.py');
    expect(expanded).toContain('pkg2/__init__.py');
    expect(expanded).toContain('consumer.py');
  });

  it('普通模块 import 不穿透（mod_a ← mod_b 是普通边，mod_c 不算使用点）', () => {
    const expanded = e.getImportedByExpanded('mod_a.py');
    expect(expanded).toEqual(['mod_b.py']);
  });

  it('分层跳数：__init__ hop 1，消费者 hop 2', () => {
    const byFile = new Map(e.getImportedByLayered('pkg/helper.py').map((x) => [x.file, x.hop]));
    expect(byFile.get('pkg/__init__.py')).toBe(1);
    expect(byFile.get('consumer.py')).toBe(2);
  });
});

// ---- V5.23 单文件召回诊断 ----

describe('V5.23 explainRecall（单文件四路贡献诊断）', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v523-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'order.ts'), 'export class OrderService {\n  refund(): void {}\n}\n');
    writeFileSync(join(r, 'src', 'index.ts'), "export * from './order';\n");
    writeFileSync(join(r, 'src', 'page.ts'), "import { OrderService } from './index';\nexport function renderRefund(o: OrderService): void {\n  o.refund();\n}\n");
    mkdirSync(join(r, 'misc'), { recursive: true });
    writeFileSync(join(r, 'misc', 'noise.ts'), 'export function unrelatedGeometry(): number {\n  return 42;\n}\n');

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('未索引文件：indexed false + 单一原因（不抛错）', () => {
    const why = e.explainRecall('OrderService', 'src/nope.ts');
    expect(why.indexed).toBe(false);
    expect(why.reasons).toHaveLength(1);
    expect(why.reasons[0]).toContain('不在索引内');
    expect(why.assembledChunk).toBeNull();
    expect(why.symbolDefs).toEqual([]);
  });

  it('符号命中文件：symbolDefs + assembledChunk + 已召回原因（含 relevance）', () => {
    const why = e.explainRecall('OrderService refund', 'src/order.ts');
    expect(why.indexed).toBe(true);
    expect(why.symbolDefs.some((s) => s.name === 'OrderService' && s.kind === 'class')).toBe(true);
    expect(why.assembledChunk).not.toBeNull();
    expect(why.reasons.some((x) => x.includes('已召回'))).toBe(true);
    expect(why.reasons.some((x) => x.includes('符号路'))).toBe(true);
  });

  it('使用点文件：usageOf 记录定义文件与 hop（barrel 消费者 hop 2）', () => {
    const why = e.explainRecall('OrderService refund', 'src/page.ts');
    const usage = why.usageOf.find((u) => u.defFile === 'src/order.ts');
    expect(usage).toBeDefined();
    expect(usage!.hop).toBe(2); // page → index（barrel）→ order
    expect(why.assembledChunk).not.toBeNull();
  });

  it('低相关文件：未召回原因逐路给出（符号/关键词/图/使用点）', () => {
    const why = e.explainRecall('OrderService refund', 'misc/noise.ts');
    expect(why.indexed).toBe(true);
    expect(why.assembledChunk).toBeNull();
    expect(why.reasons.some((x) => x.includes('符号路未命中'))).toBe(true);
    expect(why.reasons.some((x) => x.includes('关键词路未命中'))).toBe(true);
    expect(why.reasons.some((x) => x.includes('import 图路'))).toBe(true);
    expect(why.reasons.some((x) => x.includes('使用点路'))).toBe(true);
  });
});

// ---- V5.24 git 最近变更加权 ----

describe('V5.24 git 最近变更加权', () => {
  it('recentFiles：+10 改变排序（召回集合不变，与 cwd 加权同一原则）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v524-'));
    writeFileSync(join(r, 'a-report.ts'), 'export const reportAlpha = 1;\n');
    writeFileSync(join(r, 'b-report.ts'), 'export const reportBeta = 2;\n');
    // 抹平 mtime 差：保证基线是稳定排序（a 在前），加权后才能断言反超
    const t = new Date();
    utimesSync(join(r, 'a-report.ts'), t, t);
    utimesSync(join(r, 'b-report.ts'), t, t);

    const e = new ContextEngine();
    await e.index(r);

    const base = e.assembleContext('report', { maxTokens: 20_000 });
    const basePaths = base.map((c) => c.path);
    expect(basePaths).toContain('a-report.ts');
    expect(basePaths).toContain('b-report.ts');
    expect(basePaths.indexOf('a-report.ts')).toBeLessThan(basePaths.indexOf('b-report.ts')); // 基线：a 在前

    const boosted = e.assembleContext('report', { maxTokens: 20_000, recentFiles: ['b-report.ts'] });
    expect(boosted[0].path).toBe('b-report.ts'); // +10 反超
    expect(boosted[0].relevance).toBe(base.find((c) => c.path === 'b-report.ts')!.relevance + 10);
    // 只改排序不改召回集合
    expect(new Set(boosted.map((c) => c.path))).toEqual(new Set(basePaths));

    rmSync(r, { recursive: true, force: true });
  });

  it('collectGitChangedFiles：porcelain（修改/暂存/未跟踪/rename 取新路径）∪ diff HEAD', () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v524git-'));
    const sh = (cmd: string) => execSync(cmd, { cwd: r, stdio: 'ignore' });
    sh('git init');
    sh('git config user.email test@test.test');
    sh('git config user.name test');
    writeFileSync(join(r, 'committed.ts'), 'export const a = 1;\n');
    writeFileSync(join(r, 'renamed-old.ts'), 'export const b = 2;\n');
    sh('git add .');
    sh('git commit -m init');
    // 工作区变更：修改 / 未跟踪 / 暂存新增 / 重命名
    writeFileSync(join(r, 'committed.ts'), 'export const a = 2;\n');
    writeFileSync(join(r, 'untracked.ts'), 'export const c = 3;\n');
    writeFileSync(join(r, 'staged.ts'), 'export const d = 4;\n');
    sh('git add staged.ts');
    sh('git mv renamed-old.ts renamed-new.ts');

    const changed = collectGitChangedFiles(r).map((p) => basename(p));
    expect(changed).toContain('committed.ts'); // 修改（diff HEAD + porcelain 双源）
    expect(changed).toContain('untracked.ts'); // porcelain -uall
    expect(changed).toContain('staged.ts'); // 暂存
    expect(changed).toContain('renamed-new.ts'); // rename 取箭头右侧（新路径）
    expect(changed).not.toContain('renamed-old.ts');
    // 返回绝对路径（调用方 absToKey 直接消费）
    expect(collectGitChangedFiles(r).every((p) => isAbsoluteWinOrPosix(p))).toBe(true);

    rmSync(r, { recursive: true, force: true });
  });

  it('collectGitChangedFiles：非 git 目录 → 空数组（静默降级，绝不阻断召回）', () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v524nogit-'));
    writeFileSync(join(r, 'x.ts'), 'export const x = 1;\n');
    expect(collectGitChangedFiles(r)).toEqual([]);
    rmSync(r, { recursive: true, force: true });
  });
});

function isAbsoluteWinOrPosix(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

// ---- V5.29 组装缓存 ----

describe('V5.29 组装缓存（同查询短窗复用 + 代际失效）', () => {
  it('命中：同查询同选项两次组装，缓存条目只增 1；结果等价且返回拷贝', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v529-'));
    writeFileSync(join(r, 'svc.ts'), 'export class CacheSvc {\n  run(): void {}\n}\n');
    const e = new ContextEngine();
    await e.index(r);

    const a = e.assembleContext('CacheSvc', { maxTokens: 20_000 });
    expect(e.assembleCacheSize()).toBe(1);
    const b = e.assembleContext('CacheSvc', { maxTokens: 20_000 });
    expect(e.assembleCacheSize()).toBe(1); // 命中不新增

    expect(b.map((c) => `${c.path}:${c.startLine}`)).toEqual(a.map((c) => `${c.path}:${c.startLine}`));

    // 返回拷贝：调用方篡改不污染缓存
    b[0].relevance = 9999;
    const c = e.assembleContext('CacheSvc', { maxTokens: 20_000 });
    expect(c[0].relevance).not.toBe(9999);

    rmSync(r, { recursive: true, force: true });
  });

  it('键含会话活动：记录活动后同查询重新组装，加权生效（防陈旧缓存返回旧排序）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v529act-'));
    writeFileSync(join(r, 'a-cache.ts'), 'export const cacheAlpha = 1;\n');
    writeFileSync(join(r, 'b-cache.ts'), 'export const cacheBeta = 2;\n');
    const t = new Date();
    utimesSync(join(r, 'a-cache.ts'), t, t);
    utimesSync(join(r, 'b-cache.ts'), t, t);
    const e = new ContextEngine();
    await e.index(r);

    const base = e.assembleContext('cache', { maxTokens: 20_000 });
    expect(base[0].path).toBe('a-cache.ts'); // 基线：a 在前

    e.recordSessionActivity(join(r, 'b-cache.ts'));
    const boosted = e.assembleContext('cache', { maxTokens: 20_000 });
    expect(boosted[0].path).toBe('b-cache.ts'); // 活动在键内 → 重新组装而非陈旧缓存
    expect(e.assembleCacheSize()).toBe(2); // 两个不同键

    rmSync(r, { recursive: true, force: true });
  });

  it('代际失效：文件修改 + refresh 后同查询返回新内容（绝不吃陈旧缓存）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v529inv-'));
    writeFileSync(join(r, 'gen.ts'), 'export class GenSvc {\n  old(): void {}\n}\n');
    const e = new ContextEngine();
    await e.index(r);

    const before = e.assembleContext('GenSvc', { maxTokens: 20_000 });
    expect(before.some((c) => c.content.includes('old()'))).toBe(true);

    writeFileSync(join(r, 'gen.ts'), 'export class GenSvc {\n  fresh(): void {}\n}\n');
    e.refresh(); // mtime 变化 → invalidateFile → 代际失效
    const after = e.assembleContext('GenSvc', { maxTokens: 20_000 });
    expect(after.some((c) => c.content.includes('fresh()'))).toBe(true);
    expect(after.every((c) => !c.content.includes('old()'))).toBe(true);

    rmSync(r, { recursive: true, force: true });
  });

  it('无变化 refresh 不失效：代际稳定（agent-loop 每轮 refresh 场景下缓存仍可命中）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v529keep-'));
    writeFileSync(join(r, 'stable.ts'), 'export const stableVal = 1;\n');
    const e = new ContextEngine();
    await e.index(r);
    e.assembleContext('stable', { maxTokens: 20_000 });
    const sizeAfterFirst = e.assembleCacheSize();

    e.refresh(); // 无任何文件变化
    e.assembleContext('stable', { maxTokens: 20_000 });
    expect(e.assembleCacheSize()).toBe(sizeAfterFirst); // 命中同一条目

    rmSync(r, { recursive: true, force: true });
  });
});

// ---- V5.30 组装去重（同文件窗口合并） ----

describe('V5.30 同文件多符号窗口合并', () => {
  /** 生成 N 行填充文件，在指定行放两个导出类 */
  function makeFile(lines: number, alphaLine: number, betaLine: number): string {
    const arr: string[] = [];
    for (let i = 1; i <= lines; i++) {
      if (i === alphaLine) arr.push('export class AlphaService {\n  alpha(): void {}\n}');
      else if (i === betaLine) arr.push('export class BetaService {\n  beta(): void {}\n}');
      else arr.push(`// filler line ${i}`);
    }
    return arr.join('\n') + '\n';
  }

  it('邻近符号（窗口间隔 ≤ 5 行）：合并为单一 chunk 覆盖两个定义', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v530near-'));
    // Alpha L50 → 窗口 [30,70]；Beta L92 → 窗口 [72,112]；间隔 2 ≤ 5 → 合并
    writeFileSync(join(r, 'near.ts'), makeFile(130, 50, 92));
    const e = new ContextEngine();
    await e.index(r);

    const chunks = e.assembleContext('AlphaService BetaService', { maxTokens: 20_000 });
    expect(chunks).toHaveLength(1); // 同文件只出一个 chunk
    const chunk = chunks[0];
    expect(chunk.startLine).toBeLessThanOrEqual(30);
    expect(chunk.endLine).toBeGreaterThanOrEqual(112);
    expect(chunk.content).toContain('AlphaService');
    expect(chunk.content).toContain('BetaService'); // 此前第二符号窗口整体丢失

    rmSync(r, { recursive: true, force: true });
  });

  it('远端符号（合并后两段区间）：不合并，chunk 保持单窗口跨度（防巨型 chunk）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v530far-'));
    // Alpha L50 → [30,70]；Beta L300 → [280,320]；间隔 210 → 两段，不合并
    writeFileSync(join(r, 'far.ts'), makeFile(340, 50, 300));
    const e = new ContextEngine();
    await e.index(r);

    const chunks = e.assembleContext('AlphaService BetaService', { maxTokens: 20_000 });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(45); // ±20 窗口未被展宽
    expect(chunk.content).toContain('AlphaService');
    expect(chunk.content).not.toContain('BetaService'); // 远端符号维持旧行为（不并入）

    rmSync(r, { recursive: true, force: true });
  });

  it('单符号文件：无合并路径，行为与旧版一致', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v530single-'));
    writeFileSync(join(r, 'solo.ts'), 'export class SoloService {\n  solo(): void {}\n}\n');
    const e = new ContextEngine();
    await e.index(r);
    const chunks = e.assembleContext('SoloService', { maxTokens: 20_000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('SoloService');
    rmSync(r, { recursive: true, force: true });
  });
});

// ---- V5.31 全量符号清单（codex context bench 抽样源） ----

describe('V5.31 listSymbols（bench 查询抽样源）', () => {
  it('返回全量符号（类/方法/函数），带 file/line，按名称稳定排序', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v531list-'));
    writeFileSync(
      join(r, 'svc.ts'),
      'export class ZetaService {\n  zeta(): void {}\n}\nexport function alphaHelper(): void {}\n',
    );
    writeFileSync(join(r, 'util.ts'), 'export interface BetaShape {\n  id: string;\n}\n');
    const e = new ContextEngine();
    await e.index(r);

    const syms = e.listSymbols();
    const names = syms.map((s) => s.name);
    // 排序不变量：名称升序（alphaHelper < BetaShape 大小写不敏感 < ZetaService…）
    const lower = names.map((n) => n.toLowerCase());
    expect([...lower]).toEqual([...lower].sort());

    const zeta = syms.find((s) => s.name === 'ZetaService');
    expect(zeta).toBeDefined();
    expect(zeta!.kind).toBe('class');
    expect(zeta!.file).toBe('svc.ts');
    expect(zeta!.line).toBe(1);
    expect(syms.some((s) => s.name === 'zeta' && s.kind === 'method')).toBe(true);
    expect(syms.some((s) => s.name === 'BetaShape' && s.file === 'util.ts')).toBe(true);

    rmSync(r, { recursive: true, force: true });
  });

  it('确定性：两次调用返回完全一致的清单', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v531det-'));
    writeFileSync(join(r, 'a.ts'), 'export class Aaa {}\n');
    writeFileSync(join(r, 'b.ts'), 'export class Bbb {}\nexport function ccc(): void {}\n');
    const e = new ContextEngine();
    await e.index(r);
    expect(e.listSymbols()).toEqual(e.listSymbols());
    rmSync(r, { recursive: true, force: true });
  });

  it('bench 核心不变量：抽样符号查询 → 定义文件在组装结果 top-3', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v531inv-'));
    writeFileSync(
      join(r, 'pay.ts'),
      '/** 支付网关 */\nexport class PayGateway {\n  charge(): void {}\n}\n',
    );
    writeFileSync(join(r, 'cart.ts'), 'export class CartBasket {\n  add(): void {}\n}\n');
    const e = new ContextEngine();
    await e.index(r);

    for (const s of e.listSymbols()) {
      const paths = e.assembleContext(s.name, { maxTokens: 20_000 }).map((c) => c.path);
      const rank = paths.indexOf(s.file) + 1;
      expect(rank).toBeGreaterThanOrEqual(1);
      expect(rank).toBeLessThanOrEqual(3);
    }
    rmSync(r, { recursive: true, force: true });
  });

  it('空工作区：返回空数组', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v531empty-'));
    const e = new ContextEngine();
    await e.index(r);
    expect(e.listSymbols()).toEqual([]);
    rmSync(r, { recursive: true, force: true });
  });
});

// ---- V5.25 会话活动加权 ----

describe('V5.25 会话活动加权（recordSessionActivity）', () => {
  let r: string;
  let e: ContextEngine;

  beforeAll(async () => {
    r = mkdtempSync(join(tmpdir(), 'codex-v525-'));
    writeFileSync(join(r, 'a-note.ts'), 'export const noteAlpha = 1;\n');
    writeFileSync(join(r, 'b-note.ts'), 'export const noteBeta = 2;\n');
    // 抹平 mtime：基线稳定排序（a 在前），加权后才能断言反超
    const t = new Date();
    utimesSync(join(r, 'a-note.ts'), t, t);
    utimesSync(join(r, 'b-note.ts'), t, t);

    e = new ContextEngine();
    await e.index(r);
  });

  afterAll(() => {
    rmSync(r, { recursive: true, force: true });
  });

  it('活动文件 +12 反超排序（召回集合不变，只改排序）', () => {
    const base = e.assembleContext('note', { maxTokens: 20_000 });
    expect(base.map((c) => c.path)).toEqual(['a-note.ts', 'b-note.ts']); // 基线：a 在前

    expect(e.recordSessionActivity(join(r, 'b-note.ts'))).toBe(true);
    const boosted = e.assembleContext('note', { maxTokens: 20_000 });
    expect(boosted[0].path).toBe('b-note.ts'); // +12 反超
    expect(boosted[0].relevance).toBe(base.find((c) => c.path === 'b-note.ts')!.relevance + 12);
    expect(new Set(boosted.map((c) => c.path))).toEqual(new Set(['a-note.ts', 'b-note.ts']));
  });

  it('越界路径拒绝（不污染活动记录）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-v525out-'));
    expect(e.recordSessionActivity(join(outside, 'x.ts'))).toBe(false);
    expect(e.getSessionActivity()).not.toContain('x.ts');
    rmSync(outside, { recursive: true, force: true });
  });

  it('重复操作移到队尾（保"最近"语义）+ clearSessionActivity 清空', () => {
    e.clearSessionActivity();
    e.recordSessionActivity(join(r, 'a-note.ts'));
    e.recordSessionActivity(join(r, 'b-note.ts'));
    e.recordSessionActivity(join(r, 'a-note.ts')); // 重复
    expect(e.getSessionActivity()).toEqual(['b-note.ts', 'a-note.ts']); // a 移到队尾
    e.clearSessionActivity();
    expect(e.getSessionActivity()).toEqual([]);
  });

  it('FIFO 上限：第 51 个挤掉最旧的（防长会话膨胀）', async () => {
    const r2 = mkdtempSync(join(tmpdir(), 'codex-v525fifo-'));
    const files: string[] = [];
    for (let i = 0; i < 55; i++) {
      const name = `f${String(i).padStart(3, '0')}.ts`;
      files.push(name);
      writeFileSync(join(r2, name), `export const v${i} = ${i};\n`);
    }
    const e2 = new ContextEngine();
    await e2.index(r2);
    for (const name of files) e2.recordSessionActivity(join(r2, name));
    const activity = e2.getSessionActivity();
    expect(activity).toHaveLength(50);
    expect(activity[0]).toBe('f005.ts'); // 最旧的 5 个被淘汰
    expect(activity[activity.length - 1]).toBe('f054.ts'); // 最新在队尾
    rmSync(r2, { recursive: true, force: true });
  });
});

// ---- V5.27 加权信号概览 ----

describe('V5.27 getContextReport signals（三路加权信号可观测）', () => {
  it('非 git 目录：权重参数齐全 + gitRecentFiles 空 + 会话活动镜像', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v527-'));
    writeFileSync(join(r, 'svc.ts'), 'export class Svc {}\n');
    const e = new ContextEngine();
    await e.index(r);
    e.recordSessionActivity(join(r, 'svc.ts'));

    const report = e.getContextReport();
    expect(report.signals.weights).toEqual({ cwdSubtree: 15, cwdSameRoot: 8, gitRecent: 10, sessionActivity: 12 });
    expect(report.signals.gitRecentFiles).toEqual([]); // 非 git 仓静默降级
    expect(report.signals.sessionActivityFiles).toEqual(['svc.ts']); // 活动镜像（键空间）

    rmSync(r, { recursive: true, force: true });
  });

  it('git 仓：变更文件映射到键空间（仅索引内）', async () => {
    const r = mkdtempSync(join(tmpdir(), 'codex-v527git-'));
    const sh = (cmd: string) => execSync(cmd, { cwd: r, stdio: 'ignore' });
    sh('git init');
    sh('git config user.email t@t.t');
    sh('git config user.name t');
    writeFileSync(join(r, 'committed.ts'), 'export const a = 1;\n');
    sh('git add .');
    sh('git commit -m init');
    writeFileSync(join(r, 'changed.ts'), 'export const b = 2;\n'); // 未跟踪 → git recent

    const e = new ContextEngine();
    await e.index(r);
    const report = e.getContextReport();
    expect(report.signals.gitRecentFiles).toContain('changed.ts'); // 键空间映射成功
    expect(report.signals.gitRecentFiles).not.toContain('committed.ts'); // 无变更不在集合

    rmSync(r, { recursive: true, force: true });
  });
});

// ---- V5.25 agent-loop 接线 ----

describe('V5.25 agent-loop 会话活动接线（工具 read/write 反馈召回）', () => {
  it('工具 readFile/writeFile 触达的文件进入共享引擎会话活动', async () => {
    const { clearTools, registerBuiltinTools } = await import('../src/tools/builtin.js');
    const { MockProvider } = await import('../src/utils/ai-client.js');
    const { runAgentLoop } = await import('../src/core/agent-loop.js');
    const { InMemoryFileSystem } = await import('../src/core/in-memory-fs.js');
    const { getSharedContextEngine, resetSharedContextEngine } = await import(
      '../src/context/context-engine.js'
    );

    const r = mkdtempSync(join(tmpdir(), 'codex-v525wire-'));
    // MockProvider 脚本硬编码 read_file src/index.ts 与 src/config/config.ts——目录结构对齐
    mkdirSync(join(r, 'src', 'config'), { recursive: true });
    writeFileSync(join(r, 'src', 'index.ts'), 'export const wired = 1;\n');
    writeFileSync(join(r, 'src', 'config', 'config.ts'), 'export const other = 2;\n');
    process.env.CODEX_CONFIG_PATH = join(tmpdir(), `codex-v525cfg-${Date.now()}`);

    clearTools();
    registerBuiltinTools();
    resetSharedContextEngine();

    const fs = new InMemoryFileSystem();
    await fs.snapshot(r);
    const callbacks = {
      onTextDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: () => {},
      onDone: () => {},
    };
    // MockProvider："读取 … 和 …"触发并行 read_file（见 ai-client MockProvider 脚本）
    await runAgentLoop(
      new MockProvider() as never,
      [{ role: 'user', content: '读取 src/index.ts 和 config', timestamp: new Date().toISOString() }],
      fs,
      r,
      callbacks,
    );

    const engine = getSharedContextEngine(r);
    expect(engine).not.toBeNull();
    const activity = engine!.getSessionActivity();
    expect(activity.length).toBeGreaterThan(0); // 工具触达的文件被记录
    expect(activity).toContain('src/index.ts');
    expect(activity).toContain('src/config/config.ts');

    rmSync(r, { recursive: true, force: true });
    resetSharedContextEngine();
    clearTools();
  });
});
