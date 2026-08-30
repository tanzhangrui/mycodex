/**
 * V3.4 上下文进阶测试 — 对应 V3.4-ITERATION-PROMPT.md 执行清单
 * 覆盖：n-gram 分词（token 覆盖率匹配）/ 语义召回 / 索引持久化（指纹校验）/ 增量刷新 / 共享单例
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import {
  ContextEngine,
  tokenizeForEmbedding,
  getSharedContextEngine,
  resetSharedContextEngine,
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
