/**
 * V5.0 多仓库工作区测试
 * 覆盖：WorkspaceResolver（多根注册/根名去重/双向映射/越界拒绝/输入解析）+
 * ContextEngine 多根（统一键空间 rootName/rel、跨根检索、跨根读内容、
 * import 图同根解析、refresh 增量、单根兼容、共享单例多根缓存）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceResolver, createWorkspace } from '../src/core/workspace.js';
import {
  ContextEngine,
  getSharedContextEngine,
  resetSharedContextEngine,
} from '../src/context/context-engine.js';

// ---- 测试脚手架：前端仓 + 服务仓（独立目录树） ----

let workspaceParent: string;
let frontendRoot: string; // 目录名 frontend
let backendRoot: string; // 目录名 backend
let engine: ContextEngine;
let configDir: string;

const AUTH_TS = `import { TokenStore } from './token-store';

export class AuthService {
  login(user: string): string {
    return TokenStore.issue(user);
  }
}
`;

const TOKEN_STORE_TS = `export class TokenStore {
  static issue(user: string): string {
    return 'tok';
  }
}
`;

const API_TS = `export function createUser(name: string) {
  // 后端创建用户
  return { id: 1, name };
}
`;

beforeAll(async () => {
  configDir = join(tmpdir(), `codex-test-config-v50-${Date.now()}`);
  process.env.CODEX_CONFIG_PATH = configDir;

  workspaceParent = mkdtempSync(join(tmpdir(), 'codex-ws-'));
  frontendRoot = join(workspaceParent, 'frontend');
  backendRoot = join(workspaceParent, 'backend');
  mkdirSync(join(frontendRoot, 'src'), { recursive: true });
  mkdirSync(join(backendRoot, 'src'), { recursive: true });
  writeFileSync(join(frontendRoot, 'src', 'auth-service.ts'), AUTH_TS);
  writeFileSync(join(frontendRoot, 'src', 'token-store.ts'), TOKEN_STORE_TS);
  writeFileSync(join(backendRoot, 'src', 'api.ts'), API_TS);

  engine = new ContextEngine();
  await engine.index([frontendRoot, backendRoot]);
});

afterAll(() => {
  rmSync(workspaceParent, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  resetSharedContextEngine();
});

// ---- WorkspaceResolver ----

describe('WorkspaceResolver', () => {
  it('多根注册 + 根名列表 + 主根语义', () => {
    const r = new WorkspaceResolver([frontendRoot, backendRoot]);
    expect(r.rootNames).toEqual(['frontend', 'backend']);
    expect(r.primaryRoot).toBe(frontendRoot);
    expect(r.rootList).toHaveLength(2);
  });

  it('空根列表抛错；根不存在/非目录抛错', () => {
    expect(() => new WorkspaceResolver([])).toThrow();
    expect(() => new WorkspaceResolver([join(tmpdir(), 'codex-ws-no-such-dir')])).toThrow();
  });

  it('同名根去重：repo → repo-2', () => {
    const parent = mkdtempSync(join(tmpdir(), 'codex-ws-dup-'));
    const a = join(parent, 'x', 'repo');
    const b = join(parent, 'y', 'repo');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const r = new WorkspaceResolver([a, b]);
    expect(r.rootNames).toEqual(['repo', 'repo-2']);
    rmSync(parent, { recursive: true, force: true });
  });

  it('双向映射：绝对路径 ⇄ rootName/rel', () => {
    const r = new WorkspaceResolver([frontendRoot, backendRoot]);
    const abs = join(frontendRoot, 'src', 'auth-service.ts');
    expect(r.toWorkspaceRel(abs)).toBe('frontend/src/auth-service.ts');
    expect(r.toAbsolute('frontend/src/auth-service.ts')).toBe(abs);
    expect(r.toAbsolute('backend')).toBe(backendRoot); // 根本身
  });

  it('越界路径拒绝：toWorkspaceRel 返回 null', () => {
    const r = new WorkspaceResolver([frontendRoot, backendRoot]);
    expect(r.toWorkspaceRel(join(workspaceParent, 'other', 'a.ts'))).toBeNull();
    expect(r.contains(join(workspaceParent, 'other'))).toBe(false);
    expect(r.contains(join(frontendRoot, 'src'))).toBe(true);
    // 根内嵌套目录前缀伪装（backend-inside 不是 backend）
    mkdirSync(join(workspaceParent, 'backend-inside'), { recursive: true });
    expect(r.contains(join(workspaceParent, 'backend-inside', 'x.ts'))).toBe(false);
  });

  it('toAbsolute 段级逃逸拒绝（未知根名 / .. 穿越）', () => {
    const r = new WorkspaceResolver([frontendRoot, backendRoot]);
    expect(r.toAbsolute('unknown/src/a.ts')).toBeNull();
    expect(r.toAbsolute('frontend/src/../..')).toBeNull();
    // 反斜杠与重复斜杠归一化
    expect(r.toAbsolute('frontend\\src\\api.ts')).toBe(join(frontendRoot, 'src', 'api.ts'));
  });

  it('resolveInput：相对主根解析；越界 null', () => {
    const r = new WorkspaceResolver([frontendRoot, backendRoot]);
    expect(r.resolveInput('src/auth-service.ts')).toBe(join(frontendRoot, 'src', 'auth-service.ts'));
    expect(r.resolveInput(join(backendRoot, 'src', 'api.ts'))).toBe(join(backendRoot, 'src', 'api.ts'));
    expect(r.resolveInput('../outside/x.ts')).toBeNull();
  });

  it('createWorkspace 单根兼容层', () => {
    const r = createWorkspace(frontendRoot);
    expect(r.rootNames).toHaveLength(1);
    expect(r.primaryRoot).toBe(frontendRoot);
  });
});

// ---- ContextEngine 多根 ----

describe('ContextEngine 多根（V5.0）', () => {
  it('统一键空间：所有文件键为 rootName/rel 前缀形式', () => {
    const stats = engine.getStats();
    const files = (stats as { fileCount: number }).fileCount;
    expect(files).toBeGreaterThanOrEqual(3);

    // 通过符号查询验证键空间（符号的 file 字段带根前缀）
    const syms = engine.resolveQuerySymbols('AuthService');
    expect(syms.length).toBeGreaterThan(0);
    expect(syms[0].file).toBe('frontend/src/auth-service.ts');
  });

  it('跨根检索：查询命中另一根的符号', () => {
    const syms = engine.resolveQuerySymbols('createUser');
    expect(syms.length).toBeGreaterThan(0);
    expect(syms[0].file).toBe('backend/src/api.ts');
  });

  it('跨根读内容：getFileContent 按统一键路由到对应根', () => {
    const content = engine.getFileContent('backend/src/api.ts');
    expect(content).toContain('createUser');
    expect(engine.getFileContent('backend/src/no-such.ts')).toBeNull();
  });

  it('assembleContext 跨根召回：口语化查询命中后端文件', () => {
    const chunks = engine.assembleContext('创建用户 createUser 的逻辑在哪');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.path === 'backend/src/api.ts')).toBe(true);
  });

  it('import 图在统一键空间内解析（同根相对 import）', () => {
    const related = engine.getRelatedFiles(['frontend/src/auth-service.ts']);
    expect(related).toContain('frontend/src/token-store.ts');
  });

  it('敏感文件跨根依然拦截（隐私红线不因多根放松）', () => {
    writeFileSync(join(backendRoot, '.env'), 'SECRET=1', 'utf-8');
    engine.refresh();
    expect(engine.getFileContent('backend/.env')).toBeNull();
  });

  it('refresh 增量：多根下新增/变更文件被发现', () => {
    writeFileSync(join(backendRoot, 'src', 'new-module.ts'), 'export class NewModule {}\n', 'utf-8');
    engine.refresh();
    const syms = engine.resolveQuerySymbols('NewModule');
    expect(syms.length).toBeGreaterThan(0);
    expect(syms[0].file).toBe('backend/src/new-module.ts');

    // 变更检测：改内容 + 推 mtime（同 size 写入的指纹陷阱）
    const p = join(backendRoot, 'src', 'new-module.ts');
    writeFileSync(p, 'export class NewModule { version = 2 }\n', 'utf-8');
    const future = new Date(Date.now() + 5000);
    utimesSync(p, future, future);
    engine.refresh();
    const content = engine.getFileContent('backend/src/new-module.ts');
    expect(content).toContain('version = 2');
  });

  it('单根 string 入参与旧版行为完全一致（无前缀键）', async () => {
    const e = new ContextEngine();
    await e.index(frontendRoot);
    const syms = e.resolveQuerySymbols('AuthService');
    expect(syms[0].file).toBe('src/auth-service.ts'); // 无根前缀
  });

  it('多根持久化与单根缓存隔离（persistKey 语义）', async () => {
    // 单根引擎：建索引并等待落盘
    const single = new ContextEngine();
    await single.index(frontendRoot);
    single.resolveQuerySymbols('AuthService'); // 触发符号索引构建 + 异步落盘
    await single.flushIndexCache();

    // 多根引擎：同一主根但键空间不同，绝不误读单根缓存
    const multi = new ContextEngine();
    await multi.index([frontendRoot, backendRoot]);
    const syms = multi.resolveQuerySymbols('AuthService');
    expect(syms[0].file).toBe('frontend/src/auth-service.ts');
  });
});

// ---- 共享单例多根 ----

describe('getSharedContextEngine 多根缓存', () => {
  it('相同根列表复用实例；顺序不同视为不同工作区', () => {
    resetSharedContextEngine();
    const a = getSharedContextEngine([frontendRoot, backendRoot]);
    const b = getSharedContextEngine([frontendRoot, backendRoot]);
    expect(a).toBe(b);

    const c = getSharedContextEngine([backendRoot, frontendRoot]);
    expect(c).not.toBe(a);
    resetSharedContextEngine();
  });

  it('单根 string 与单元素数组等价（键归一化）', () => {
    resetSharedContextEngine();
    const a = getSharedContextEngine(frontendRoot);
    const b = getSharedContextEngine([frontendRoot]);
    expect(a).toBe(b);
    resetSharedContextEngine();
  });
});
