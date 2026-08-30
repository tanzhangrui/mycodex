/**
 * V3.2 上下文引擎测试 — 对应 V3.2-ITERATION-PROMPT.md 执行清单
 * 覆盖：符号索引 / import 图相关文件收集 / 大仓库懒加载 / 隐私拦截 / 预算裁剪 / 提示词注入
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, extractSymbols } from '../src/context/context-engine.js';

// V3.4：隔离配置目录，持久化缓存绝不污染真实用户 home
process.env.CODEX_CONFIG_PATH = join(tmpdir(), 'codex-test-config-v32');

// ---- 测试夹具：模拟小型项目 ----

let root: string;
let engine: ContextEngine;

const USER_SERVICE_TS = `export interface UserProfile {
  id: string;
  name: string;
}

export class UserService {
  private cache = new Map<string, UserProfile>();

  async loadUser(id: string): Promise<UserProfile | null> {
    return this.cache.get(id) ?? null;
  }

  saveUser(user: UserProfile): void {
    this.cache.set(user.id, user);
  }
}

export function createUserService(): UserService {
  return new UserService();
}
`;

const HANDLER_TS = `import { createUserService } from './user-service';

export function handleRequest(id: string): string {
  const svc = createUserService();
  return \`ok:\${id}\`;
}
`;

const UTILS_PY = `def format_result(data):
    return str(data)


class ResultPrinter:
    def print(self, data):
        print(format_result(data))
`;

const SECRET_ENV = `GLM_API_KEY=sk-test-secret-123456
DEEPSEEK_API_KEY=sk-another-secret
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'codex-ctx-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'user-service.ts'), USER_SERVICE_TS);
  writeFileSync(join(root, 'src', 'handler.ts'), HANDLER_TS);
  writeFileSync(join(root, 'src', 'utils.py'), UTILS_PY);
  writeFileSync(join(root, '.env'), SECRET_ENV);

  engine = new ContextEngine();
  await engine.index(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---- 符号提取 ----

describe('extractSymbols（零依赖正则近似 AST）', () => {
  it('提取 TS 的 interface / class / method / function + 行号', () => {
    const symbols = extractSymbols(USER_SERVICE_TS, 'ts');
    const names = symbols.map((s) => s.name);

    expect(names).toContain('UserProfile');
    expect(names).toContain('UserService');
    expect(names).toContain('loadUser');
    expect(names).toContain('saveUser');
    expect(names).toContain('createUserService');

    const cls = symbols.find((s) => s.name === 'UserService');
    expect(cls?.kind).toBe('class');
    expect(cls?.line).toBeGreaterThan(0);

    // 方法行号应指向定义行（loadUser 在第 9 行）
    const method = symbols.find((s) => s.name === 'loadUser');
    expect(method?.kind).toBe('method');
    expect(method?.line).toBe(9);
  });

  it('提取 Python 的 def / class', () => {
    const symbols = extractSymbols(UTILS_PY, 'py');
    const names = symbols.map((s) => s.name);

    expect(names).toContain('format_result');
    expect(names).toContain('ResultPrinter');
    expect(symbols.find((s) => s.name === 'format_result')?.kind).toBe('function');
  });

  it('控制流关键字不误报为方法', () => {
    const content = `class Foo {
  bar(): void {
    if (x) {
      return;
    }
    for (let i = 0; i < 3; i++) {}
  }
}`;
    const names = extractSymbols(content, 'ts').map((s) => s.name);
    expect(names).toContain('bar');
    expect(names).not.toContain('if');
    expect(names).not.toContain('for');
  });
});

// ---- 符号索引查询 ----

describe('resolveQuerySymbols（符号 → 定义位置）', () => {
  it('中文查询中提到的符号能定位到定义文件与行号', () => {
    const hits = engine.resolveQuerySymbols('修改 UserService 的 loadUser 方法');
    expect(hits.length).toBeGreaterThan(0);

    const cls = hits.find((s) => s.name === 'UserService');
    expect(cls?.file).toBe('src/user-service.ts');
    expect(cls?.kind).toBe('class');

    const method = hits.find((s) => s.name === 'loadUser');
    expect(method?.file).toBe('src/user-service.ts');
    expect(method?.line).toBe(9);
  });

  it('大小写不敏感匹配', () => {
    const hits = engine.resolveQuerySymbols('userservice 是什么');
    expect(hits.some((s) => s.name === 'UserService')).toBe(true);
  });
});

// ---- import 图 ----

describe('import 图（自动相关文件收集）', () => {
  it('解析相对 import（扩展名探测）', () => {
    const imports = engine.parseImports('src/handler.ts');
    expect(imports).toContain('src/user-service.ts');
  });

  it('BFS 扩展：从 handler.ts 找到 user-service.ts', () => {
    const related = engine.getRelatedFiles(['src/handler.ts']);
    expect(related).toContain('src/user-service.ts');
  });

  it('包外绝对导入被忽略', () => {
    // 夹具中没有绝对导入的文件，handler 仅一条相对导入
    const imports = engine.parseImports('src/handler.ts');
    expect(imports.every((p) => p.startsWith('src/'))).toBe(true);
  });
});

// ---- 三路召回融合 ----

describe('assembleContext（符号 → 关键词 → 依赖图）', () => {
  it('符号命中优先：定义处 chunk 相关性 100', () => {
    const chunks = engine.assembleContext('修改 UserService 的 loadUser 方法');
    expect(chunks.length).toBeGreaterThan(0);

    const top = chunks[0];
    expect(top.relevance).toBeGreaterThanOrEqual(100);
    expect(top.content).toContain('class UserService');
  });

  it('import 图扩展：查询 handleRequest 时依赖文件也进入上下文', () => {
    const chunks = engine.assembleContext('handleRequest 是做什么的');
    const paths = chunks.map((c) => c.path);

    expect(paths).toContain('src/handler.ts');
    // 依赖 user-service.ts 的头部作为补充上下文（低相关性）
    expect(paths).toContain('src/user-service.ts');
  });

  it('token 预算裁剪：极小预算下返回受限或空结果', () => {
    const chunks = engine.assembleContext('修改 UserService 的 loadUser 方法', { maxTokens: 1 });
    // 预算 1 token：任何 chunk 都放不下
    expect(chunks.length).toBe(0);
  });

  it('按路径去重：同一文件只保留最高相关性 chunk', () => {
    const chunks = engine.assembleContext('修改 UserService 的 loadUser 方法');
    const paths = chunks.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

// ---- 懒加载 ----

describe('大仓库懒加载', () => {
  it('扫描阶段零内容读取：preview 惰性填充', async () => {
    const fresh = new ContextEngine();
    await fresh.index(root);

    // 惰性：索引后可按需读取内容
    const content = fresh.getFileContent('src/user-service.ts');
    expect(content).toContain('class UserService');

    // preview 按需生成且截断至 500 字符
    const preview = fresh.getPreview('src/user-service.ts');
    expect(preview.length).toBeLessThanOrEqual(500);
    expect(preview).toContain('UserProfile');
  });

  it('索引未初始化时所有查询安全返回空', () => {
    const fresh = new ContextEngine();
    expect(fresh.assembleContext('UserService')).toEqual([]);
    expect(fresh.getRelatedFiles(['src/handler.ts'])).toEqual([]);
    expect(fresh.resolveQuerySymbols('UserService')).toEqual([]);
  });
});

// ---- 隐私红线 ----

describe('隐私守卫（V3.2 修复：.env 不再进入索引）', () => {
  it('.env 文件绝不入索引', () => {
    const files = engine.fuzzySearchFile('env');
    expect(files.some((f) => f === '.env' || f.endsWith('.env'))).toBe(false);
  });

  it('.env 内容不可达', () => {
    expect(engine.getFileContent('.env')).toBeNull();
  });

  it('密钥不泄漏到任何上下文产出', () => {
    const chunks = engine.assembleContext('env 配置 API key 密钥');
    const all = chunks.map((c) => c.content).join('\n');
    expect(all).not.toContain('sk-test-secret-123456');
    expect(all).not.toContain('sk-another-secret');
  });
});

// ---- 系统提示词 ----

describe('buildSystemPrompt（上下文注入）', () => {
  it('注入相关文件上下文', () => {
    const prompt = engine.buildSystemPrompt('修改 UserService 的 loadUser 方法', 'BASE');
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('src/user-service.ts');
    expect(prompt).toContain('class UserService');
  });

  it('无命中时不注入上下文区块', () => {
    const prompt = engine.buildSystemPrompt('zzz完全不存在的查询xxx', 'BASE');
    expect(prompt).not.toContain('相关文件上下文');
  });
});

// ---- 统计 ----

describe('getStats', () => {
  it('返回索引统计（含符号数）', () => {
    // 触发符号索引构建
    engine.resolveQuerySymbols('UserService');
    const stats = engine.getStats();
    expect(stats.fileCount).toBeGreaterThanOrEqual(3);
    expect(stats.symbolCount).toBeGreaterThan(0);
    expect(stats.lazy).toBe(false); // 小仓库非懒加载模式
  });
});
