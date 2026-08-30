/**
 * V5.0 多仓库工作区测试
 * 覆盖：WorkspaceResolver（多根注册/根名去重/双向映射/越界拒绝/输入解析）+
 * ContextEngine 多根（统一键空间 rootName/rel、跨根检索、跨根读内容、
 * import 图同根解析、refresh 增量、单根兼容、共享单例多根缓存）+
 * V5.3 跨根包名互引（根 package.json name → 裸说明符跨根解析）+
 * V5.6 Python 跨根（pyproject.toml name 别名 + dotted 说明符解析）+
 * V5.7 tsconfig paths 别名（单根/多根、最长前缀匹配、baseUrl）
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

// ---- V5.3 跨根包名互引 ----

describe('ContextEngine 跨根 import（V5.3 包名别名）', () => {
  let parent: string;
  let appRoot: string; // 目录名 app，package.json name = my-app
  let sharedRoot: string; // 目录名 sharedlib，package.json name = @acme/shared-lib
  let e: ContextEngine;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'codex-ws-xpkg-'));
    appRoot = join(parent, 'app');
    sharedRoot = join(parent, 'sharedlib');
    mkdirSync(join(appRoot, 'src'), { recursive: true });
    mkdirSync(join(sharedRoot, 'src'), { recursive: true });

    // 共享库根：scoped 包名，入口在 src/index.ts（源码布局）
    writeFileSync(join(sharedRoot, 'package.json'), JSON.stringify({ name: '@acme/shared-lib', version: '0.1.0' }));
    writeFileSync(join(sharedRoot, 'src', 'index.ts'), `export { SharedUtil } from './utils';\n`);
    writeFileSync(join(sharedRoot, 'src', 'utils.ts'), `export class SharedUtil { static help(): string { return 'ok'; } }\n`);

    // 应用根：裸说明符跨根互引 + 外部依赖 + node 内建 + 同根相对 import 混合
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'my-app' }));
    writeFileSync(
      join(appRoot, 'src', 'main.ts'),
      [
        `import { SharedUtil } from '@acme/shared-lib';`,
        `import { helper } from '@acme/shared-lib/utils';`,
        `import _ from 'lodash-es';`,
        `import { readFileSync } from 'node:fs';`,
        `import { local } from './local';`,
        ``,
        `export function run(): string { return SharedUtil.help() + local(); }`,
        ``,
      ].join('\n'),
    );
    writeFileSync(join(appRoot, 'src', 'local.ts'), `export function local(): string { return 'L'; }\n`);

    e = new ContextEngine();
    await e.index([appRoot, sharedRoot]);
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('包名互引：@scope/pkg → 目标根入口（src/index 布局兜底命中）', () => {
    const deps = e.parseImports('app/src/main.ts');
    expect(deps).toContain('sharedlib/src/index.ts');
  });

  it('子路径互引：@scope/pkg/sub → 目标根 src/sub.ts', () => {
    const deps = e.parseImports('app/src/main.ts');
    expect(deps).toContain('sharedlib/src/utils.ts');
  });

  it('同根相对 import 不受影响（混合场景）', () => {
    const deps = e.parseImports('app/src/main.ts');
    expect(deps).toContain('app/src/local.ts');
    expect(deps).toHaveLength(3); // 恰好三个：入口 + 子路径 + 相对
  });

  it('import 图 BFS 跨根扩展：getRelatedFiles 触达另一根', () => {
    const related = e.getRelatedFiles(['app/src/main.ts']);
    expect(related).toContain('sharedlib/src/index.ts');
    expect(related).toContain('sharedlib/src/utils.ts');
    expect(related).toContain('app/src/local.ts');
  });

  it('外部依赖与 node: 内建不入图（无假路径）', () => {
    const deps = e.parseImports('app/src/main.ts');
    expect(deps.some((d) => d.includes('lodash'))).toBe(false);
    // 未命中别名的裸包不会被误拼为 dirname/pkg 相对路径
    expect(deps.some((d) => d.startsWith('app/src/lodash'))).toBe(false);
    expect(deps.some((d) => d.includes('node:fs'))).toBe(false);
  });

  it('无别名多根：裸说明符不收集（与旧版行为一致）', async () => {
    const p2 = mkdtempSync(join(tmpdir(), 'codex-ws-noalias-'));
    const a2 = join(p2, 'a');
    const b2 = join(p2, 'b');
    mkdirSync(join(a2, 'src'), { recursive: true });
    mkdirSync(join(b2, 'src'), { recursive: true });
    writeFileSync(join(a2, 'src', 'm.ts'), `import { x } from 'b-lib';\nexport const y = x;\n`);
    writeFileSync(join(b2, 'src', 'lib.ts'), `export const x = 1;\n`);
    const e2 = new ContextEngine();
    await e2.index([a2, b2]);
    expect(e2.parseImports('a/src/m.ts')).toEqual([]);
    rmSync(p2, { recursive: true, force: true });
  });

  it('单根不回归：别名表恒空，裸说明符（含自身包名）从不解析', async () => {
    const p3 = mkdtempSync(join(tmpdir(), 'codex-ws-single-'));
    mkdirSync(join(p3, 'src'), { recursive: true });
    writeFileSync(join(p3, 'package.json'), JSON.stringify({ name: 'solo' }));
    writeFileSync(
      join(p3, 'src', 'm.ts'),
      `import { x } from 'solo';\nimport { y } from './n';\nexport const z = x + y;\n`,
    );
    writeFileSync(join(p3, 'src', 'n.ts'), `export const y = 1;\n`);
    const e3 = new ContextEngine();
    await e3.index(p3);
    // 'solo' 是自己的包名，但单根模式别名关闭 → 只解析相对 import
    expect(e3.parseImports('src/m.ts')).toEqual(['src/n.ts']);
    rmSync(p3, { recursive: true, force: true });
  });
});

// ---- V5.6 Python 跨根 ----

describe('ContextEngine Python 跨根 import（V5.6 pyproject 别名）', () => {
  let parent: string;
  let pyAppRoot: string; // 目录名 pyapp，package.json name = py-app（package.json 优先演示）
  let pyLibRoot: string; // 目录名 pylib，pyproject.toml name = my-lib → 别名 my_lib
  let e: ContextEngine;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'codex-ws-py-'));
    pyAppRoot = join(parent, 'pyapp');
    pyLibRoot = join(parent, 'pylib');
    mkdirSync(join(pyAppRoot, 'src'), { recursive: true });
    mkdirSync(pyLibRoot, { recursive: true });

    // 共享库根：pyproject name "my-lib"（连字符）→ Python 包名 my_lib
    // 布局：根即包（__init__.py + core.py 直接在根下）
    writeFileSync(join(pyLibRoot, 'pyproject.toml'), `[project]\nname = "my-lib"\nversion = "0.1.0"\n`);
    writeFileSync(join(pyLibRoot, '__init__.py'), `from .core import helper\n`);
    writeFileSync(join(pyLibRoot, 'core.py'), `def helper():\n    return 'ok'\n`);

    // 应用根：裸模块互引 + stdlib + 同根相对 import 混合
    writeFileSync(join(pyAppRoot, 'package.json'), JSON.stringify({ name: 'py-app' }));
    writeFileSync(
      join(pyAppRoot, 'src', 'main.py'),
      [
        `from my_lib.core import helper`,
        `import my_lib`,
        `import os`,
        `import json`,
        `from . import sibling`,
        ``,
        `def run():`,
        `    return helper() + sibling.val`,
        ``,
      ].join('\n'),
    );
    writeFileSync(join(pyAppRoot, 'src', 'sibling.py'), `val = 1\n`);

    e = new ContextEngine();
    await e.index([pyAppRoot, pyLibRoot]);
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('pyproject 连字符归一化：from my_lib.core import x → 目标根 core.py', () => {
    const deps = e.parseImports('pyapp/src/main.py');
    expect(deps).toContain('pylib/core.py');
  });

  it('import my_lib（包整体）→ 根 __init__.py 入口', () => {
    const deps = e.parseImports('pyapp/src/main.py');
    expect(deps).toContain('pylib/__init__.py');
  });

  it('同根相对 import（from . import sibling）不受影响', () => {
    const deps = e.parseImports('pyapp/src/main.py');
    expect(deps).toContain('pyapp/src/sibling.py');
    expect(deps).toHaveLength(3); // 恰好三个：core + __init__ + sibling
  });

  it('stdlib 不入图（os/json 未命中别名 → 放弃）', () => {
    const deps = e.parseImports('pyapp/src/main.py');
    expect(deps.some((d) => d.includes('/os') || d.endsWith('/os.py'))).toBe(false);
    expect(deps.some((d) => d.includes('json'))).toBe(false);
  });

  it('import 图 BFS 跨根扩展（Python 混合仓）', () => {
    const related = e.getRelatedFiles(['pyapp/src/main.py']);
    expect(related).toContain('pylib/core.py');
    expect(related).toContain('pylib/__init__.py');
    expect(related).toContain('pyapp/src/sibling.py');
  });

  it('py 子路径嵌套探测：根下同名包目录（src-layout）', async () => {
    const p2 = mkdtempSync(join(tmpdir(), 'codex-ws-py2-'));
    const app2 = join(p2, 'app2');
    const lib2 = join(p2, 'lib2');
    mkdirSync(join(app2), { recursive: true });
    // lib2 布局：根下 data_kit/ 包（src-layout 惯例：目录 = 归一化包名）
    mkdirSync(join(lib2, 'data_kit'), { recursive: true });
    writeFileSync(join(lib2, 'pyproject.toml'), `[project]\nname = "data-kit"\n`);
    writeFileSync(join(lib2, 'data_kit', '__init__.py'), `from .loader import load\n`);
    writeFileSync(join(lib2, 'data_kit', 'loader.py'), `def load():\n    return []\n`);
    writeFileSync(join(app2, 'main.py'), `from data_kit.loader import load\nimport json\n`);
    const e2 = new ContextEngine();
    await e2.index([app2, lib2]);
    // data_kit.loader → 直探 lib2/loader.* 失败 → 嵌套兜底 lib2/data_kit/loader.py 命中
    expect(e2.parseImports('app2/main.py')).toContain('lib2/data_kit/loader.py');
    rmSync(p2, { recursive: true, force: true });
  });

  it('单根 Python 不回归：裸模块（含自身 pyproject name）从不解析', async () => {
    const p3 = mkdtempSync(join(tmpdir(), 'codex-ws-py3-'));
    mkdirSync(join(p3, 'pkg'), { recursive: true });
    writeFileSync(join(p3, 'pyproject.toml'), `[project]\nname = "solo-py"\n`);
    writeFileSync(join(p3, 'pkg', 'm.py'), `from solo_py.core import x\nfrom . import n\n`);
    writeFileSync(join(p3, 'pkg', 'n.py'), `x = 1\n`);
    const e3 = new ContextEngine();
    await e3.index(p3);
    expect(e3.parseImports('pkg/m.py')).toEqual(['pkg/n.py']);
    rmSync(p3, { recursive: true, force: true });
  });
});

// ---- V5.7 tsconfig paths 别名 ----

describe('ContextEngine tsconfig paths 别名（V5.7）', () => {
  let parent: string;
  let webRoot: string; // 目录名 web：tsconfig paths "@/*" → "src/*"
  let uiRoot: string; // 目录名 uikit：tsconfig paths "@ui/*" → "lib/*"（baseUrl="lib"）
  let e: ContextEngine;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'codex-ws-tsp-'));
    webRoot = join(parent, 'web');
    uiRoot = join(parent, 'uikit');
    mkdirSync(join(webRoot, 'src', 'utils'), { recursive: true });
    mkdirSync(join(uiRoot, 'lib', 'button'), { recursive: true });

    // web 根：`@/utils` → src/utils；`@legacy/*` 与 `@legacy/v2/*` 并存（最长前缀测试）
    writeFileSync(
      join(webRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
              '@legacy/*': ['src/old/*'],
              '@legacy/v2/*': ['src/new/*'],
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(webRoot, 'src', 'utils', 'format.ts'), 'export function fmt(): string { return "F"; }\n');
    mkdirSync(join(webRoot, 'src', 'old'), { recursive: true });
    writeFileSync(join(webRoot, 'src', 'old', 'legacy.ts'), 'export const legacy = 1;\n');
    mkdirSync(join(webRoot, 'src', 'new'), { recursive: true });
    writeFileSync(join(webRoot, 'src', 'new', 'legacy.ts'), 'export const legacyV2 = 2;\n');

    // uikit 根：baseUrl "lib" + `@ui/button` → lib/button
    writeFileSync(
      join(uiRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: 'lib', paths: { '@ui/*': ['./*'] } } }, null, 2),
    );
    writeFileSync(join(uiRoot, 'lib', 'button', 'index.ts'), 'export class Button {}\n');

    // 入口文件：混合 @/ 别名 / 跨根 @ui 别名 / 外部包 / 相对 import
    writeFileSync(
      join(webRoot, 'src', 'main.ts'),
      [
        "import { fmt } from '@/utils/format';",
        "import { Button } from '@ui/button';",
        "import { legacy } from '@legacy/legacy';",
        "import { legacyV2 } from '@legacy/v2/legacy';",
        "import _ from 'lodash';",
        "import { local } from './local';",
        'export function run(): void { void fmt; void Button; void legacy; void legacyV2; void local; }',
        '',
      ].join('\n'),
    );
    writeFileSync(join(webRoot, 'src', 'local.ts'), 'export const local = 1;\n');

    e = new ContextEngine();
    await e.index([webRoot, uiRoot]);
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('同根别名：@/utils/format → src/utils/format.ts', () => {
    const deps = e.parseImports('web/src/main.ts');
    expect(deps).toContain('web/src/utils/format.ts');
  });

  it('跨根别名 + baseUrl：@ui/button → 目标根 lib/button/index.ts', () => {
    const deps = e.parseImports('web/src/main.ts');
    expect(deps).toContain('uikit/lib/button/index.ts');
  });

  it('最长前缀匹配：@legacy/v2/legacy 走 v2 别名（src/new），不落 @legacy 的 src/old', () => {
    const deps = e.parseImports('web/src/main.ts');
    expect(deps).toContain('web/src/new/legacy.ts');
    // 若误走短别名 @legacy：v2 说明符会被拼成 src/old/v2/legacy（不存在 → 弃）
    expect(deps).not.toContain('web/src/old/v2/legacy.ts');
  });

  it('普通前缀别名：@legacy/legacy → src/old/legacy.ts', () => {
    const deps = e.parseImports('web/src/main.ts');
    expect(deps).toContain('web/src/old/legacy.ts');
  });

  it('外部包与相对 import 混合场景（总数恰为 5，lodash 不入图）', () => {
    const deps = e.parseImports('web/src/main.ts');
    expect(deps).toContain('web/src/local.ts');
    expect(deps).toHaveLength(5); // format + button + old legacy + v2 legacy + local
    expect(deps.some((d) => d.includes('lodash'))).toBe(false);
  });

  it('import 图 BFS 跨根扩展（tsconfig 别名路径）', () => {
    const related = e.getRelatedFiles(['web/src/main.ts']);
    expect(related).toContain('web/src/utils/format.ts');
    expect(related).toContain('uikit/lib/button/index.ts');
  });

  it('单根 + tsconfig paths：别名同样生效（@/x → src/x）', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-ws-tsp-solo-'));
    mkdirSync(join(solo, 'src'), { recursive: true });
    writeFileSync(
      join(solo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    writeFileSync(join(solo, 'src', 'main.ts'), "import { v } from '@/val';\nexport const w = v;\n");
    writeFileSync(join(solo, 'src', 'val.ts'), 'export const v = 1;\n');
    const es = new ContextEngine();
    await es.index(solo);
    expect(es.parseImports('src/main.ts')).toEqual(['src/val.ts']);
    rmSync(solo, { recursive: true, force: true });
  });

  it('JSONC 容错：带注释与尾逗号的 tsconfig 正常解析', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-ws-tsp-jsonc-'));
    mkdirSync(join(solo, 'src'), { recursive: true });
    writeFileSync(
      join(solo, 'tsconfig.json'),
      [
        '{',
        '  // 编译选项',
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@/*": ["src/*"], // 别名',
        '    },',
        '  },',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(solo, 'src', 'main.ts'), "import { v } from '@/val';\n");
    writeFileSync(join(solo, 'src', 'val.ts'), 'export const v = 1;\n');
    const es = new ContextEngine();
    await es.index(solo);
    expect(es.parseImports('src/main.ts')).toEqual(['src/val.ts']);
    rmSync(solo, { recursive: true, force: true });
  });
});

// ---- V5.13 cwd 邻近加权 ----

describe('ContextEngine cwd 邻近加权（V5.13）', () => {
  let parent: string;
  let e: ContextEngine;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'codex-ws-cwd-'));
    // 两根各放同名同内容文件 → 召回相关性天然相同，排序只受 cwd 加权影响
    for (const root of ['app-web', 'app-api']) {
      mkdirSync(join(parent, root, 'src'), { recursive: true });
      writeFileSync(
        join(parent, root, 'src', 'user-service.ts'),
        'export class UserService {\n  find(id: string): string { return id; }\n}\n',
      );
    }
    e = new ContextEngine();
    await e.index([join(parent, 'app-web'), join(parent, 'app-api')]);
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('无 cwd：稳定排序（索引序，app-web 在前）', () => {
    const chunks = e.assembleContext('UserService');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].path.startsWith('app-web/')).toBe(true);
  });

  it('cwd 指向 app-api/src：该根命中排最前（+15 子树加权）', () => {
    const chunks = e.assembleContext('UserService', { cwd: 'app-api/src' });
    expect(chunks[0].path).toBe('app-api/src/user-service.ts');
    expect(chunks[1].path).toBe('app-web/src/user-service.ts');
  });

  it('cwd 指向 app-web/src：该根命中排最前（对称性）', () => {
    const chunks = e.assembleContext('UserService', { cwd: 'app-web/src' });
    expect(chunks[0].path).toBe('app-web/src/user-service.ts');
  });

  it('cwd 为根级（app-api，非子树）：同根 +8 仍优先于异根', () => {
    const chunks = e.assembleContext('UserService', { cwd: 'app-api' });
    expect(chunks[0].path.startsWith('app-api/')).toBe(true);
  });

  it('反斜杠 cwd 归一化：app-api\\src 等价 app-api/src', () => {
    const chunks = e.assembleContext('UserService', { cwd: 'app-api\\src' });
    expect(chunks[0].path).toBe('app-api/src/user-service.ts');
  });

  it('加权只改排序不改召回集合：有/无 cwd 的命中集合一致', () => {
    const noCwd = e.assembleContext('UserService').map((c) => c.path).sort();
    const withCwd = e.assembleContext('UserService', { cwd: 'app-api/src' }).map((c) => c.path).sort();
    expect(withCwd).toEqual(noCwd);
  });

  it('单根模式：cwd 子树加权同样生效', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-ws-cwd-solo-'));
    mkdirSync(join(solo, 'a'), { recursive: true });
    mkdirSync(join(solo, 'b'), { recursive: true });
    writeFileSync(join(solo, 'a', 'helper.ts'), 'export class Helper {}\n');
    writeFileSync(join(solo, 'b', 'helper.ts'), 'export class Helper {}\n');
    const es = new ContextEngine();
    await es.index(solo);
    const chunks = es.assembleContext('Helper', { cwd: 'b' });
    expect(chunks[0].path).toBe('b/helper.ts');
    rmSync(solo, { recursive: true, force: true });
  });

  // ---- V5.15 absToKey（绝对路径 → 键空间）----

  it('absToKey 多根：根内路径 → rootName/rel；根本身 → rootName', () => {
    expect(e.absToKey(join(parent, 'app-web', 'src', 'user-service.ts'))).toBe('app-web/src/user-service.ts');
    expect(e.absToKey(join(parent, 'app-api'))).toBe('app-api');
  });

  it('absToKey 越界（工作区外绝对路径）→ null', () => {
    expect(e.absToKey(join(tmpdir(), 'codex-outside-nowhere'))).toBeNull();
  });

  it('absToKey 嵌套根最长优先：a/b 归 b 根（非 a 根子树）', async () => {
    const nest = mkdtempSync(join(tmpdir(), 'codex-ws-nest-'));
    mkdirSync(join(nest, 'outer', 'inner'), { recursive: true });
    writeFileSync(join(nest, 'outer', 'o.ts'), 'export const o = 1;\n');
    writeFileSync(join(nest, 'outer', 'inner', 'i.ts'), 'export const i = 1;\n');
    const es = new ContextEngine();
    await es.index([join(nest, 'outer'), join(nest, 'outer', 'inner')]);
    expect(es.absToKey(join(nest, 'outer', 'inner', 'i.ts'))).toBe('inner/i.ts');
    expect(es.absToKey(join(nest, 'outer', 'o.ts'))).toBe('outer/o.ts');
    rmSync(nest, { recursive: true, force: true });
  });

  it('absToKey 单根：工作区内相对化，根本身 → 空串，越界 → null', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-ws-abskey-solo-'));
    mkdirSync(join(solo, 'src'), { recursive: true });
    writeFileSync(join(solo, 'src', 'x.ts'), 'export const x = 1;\n');
    const es = new ContextEngine();
    await es.index(solo);
    expect(es.absToKey(join(solo, 'src', 'x.ts'))).toBe('src/x.ts');
    expect(es.absToKey(solo)).toBe('');
    expect(es.absToKey(join(tmpdir(), 'codex-nowhere-xyz'))).toBeNull();
    rmSync(solo, { recursive: true, force: true });
  });
});
