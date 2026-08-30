/**
 * V4.4 插件市场索引协议测试
 * V5.5 远程源（url）安全下载测试
 * 覆盖：索引解析（完整 JSON / 围栏块 / 大括号提取）/ 形状校验与容错 /
 * 条目去重与上限 / 本地索引加载 / 按名查找 / install（成功/去重幂等/失败）/
 * url 源（https 强制 / sha256 pin 必填与校验 / 缓存复用 / 大小上限 / file 源回归）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseMarketplaceIndex,
  loadMarketplaceIndex,
  findEntry,
  installPlugin,
  updatePlugin,
  searchEntries,
  compareVersions,
  type PluginLoader,
  type PluginUpdater,
  type UrlFetcher,
} from '../src/tools/marketplace.js';

const VALID_INDEX = JSON.stringify({
  version: 1,
  plugins: [
    {
      name: 'echo-tools',
      version: '1.0.0',
      description: '示例插件',
      source: { kind: 'file', path: 'plugins/echo-tools.mjs' },
    },
    {
      name: 'lint-helper',
      version: '0.2.1',
      source: { kind: 'file', path: '../shared/lint-helper.mjs' },
    },
  ],
});

describe('parseMarketplaceIndex', () => {
  it('解析完整合法索引', () => {
    const idx = parseMarketplaceIndex(VALID_INDEX);
    expect(idx).not.toBeNull();
    expect(idx!.version).toBe(1);
    expect(idx!.plugins).toHaveLength(2);
    expect(idx!.plugins[0]).toEqual({
      name: 'echo-tools',
      version: '1.0.0',
      description: '示例插件',
      source: { kind: 'file', path: 'plugins/echo-tools.mjs' },
    });
  });

  it('容错：Markdown 围栏块内嵌索引（README 分发场景）', () => {
    const raw = `# 我的市场\n\n\`\`\`json\n${VALID_INDEX}\n\`\`\`\n\n安装说明……`;
    const idx = parseMarketplaceIndex(raw);
    expect(idx).not.toBeNull();
    expect(idx!.plugins).toHaveLength(2);
  });

  it('容错：前后有噪声文本时提取首末大括号子串', () => {
    const raw = `说明文字 ${VALID_INDEX} 尾部噪声`;
    const idx = parseMarketplaceIndex(raw);
    expect(idx).not.toBeNull();
    expect(idx!.plugins).toHaveLength(2);
  });

  it('version !== 1 拒绝', () => {
    expect(parseMarketplaceIndex('{"version": 2, "plugins": []}')).toBeNull();
    expect(parseMarketplaceIndex('{"version": "1", "plugins": []}')).toBeNull();
  });

  it('plugins 非数组拒绝', () => {
    expect(parseMarketplaceIndex('{"version": 1, "plugins": {}}')).toBeNull();
    expect(parseMarketplaceIndex('{"version": 1}')).toBeNull();
  });

  it('非法条目跳过：缺 name/version、空串、source.kind 非 file、path 为空', () => {
    const raw = JSON.stringify({
      version: 1,
      plugins: [
        { version: '1.0.0', source: { kind: 'file', path: 'a.mjs' } }, // 缺 name
        { name: 'x', source: { kind: 'file', path: 'a.mjs' } }, // 缺 version
        { name: '', version: '1.0.0', source: { kind: 'file', path: 'a.mjs' } }, // 空 name
        { name: 'x', version: ' ', source: { kind: 'file', path: 'a.mjs' } }, // 空白 version
        { name: 'x', version: '1.0.0', source: { kind: 'git', path: 'https://...' } }, // 非 file 源
        { name: 'x', version: '1.0.0', source: { kind: 'file', path: '' } }, // 空 path
        { name: 'x', version: '1.0.0' }, // 缺 source
        null, // 非对象
        { name: 'ok', version: '1.0.0', source: { kind: 'file', path: 'ok.mjs' } }, // 合法
      ],
    });
    const idx = parseMarketplaceIndex(raw);
    expect(idx).not.toBeNull();
    expect(idx!.plugins).toHaveLength(1);
    expect(idx!.plugins[0].name).toBe('ok');
  });

  it('同名条目去重（首个保留）', () => {
    const raw = JSON.stringify({
      version: 1,
      plugins: [
        { name: 'dup', version: '1.0.0', source: { kind: 'file', path: 'first.mjs' } },
        { name: 'dup', version: '2.0.0', source: { kind: 'file', path: 'second.mjs' } },
      ],
    });
    const idx = parseMarketplaceIndex(raw);
    expect(idx!.plugins).toHaveLength(1);
    expect(idx!.plugins[0].source.path).toBe('first.mjs');
  });

  it('条目上限截断（防恶意巨型索引）', () => {
    const plugins = Array.from({ length: 300 }, (_, i) => ({
      name: `p${i}`,
      version: '1.0.0',
      source: { kind: 'file', path: `p${i}.mjs` },
    }));
    const idx = parseMarketplaceIndex(JSON.stringify({ version: 1, plugins }));
    expect(idx!.plugins).toHaveLength(200);
  });

  it('完全非法输入返回 null', () => {
    expect(parseMarketplaceIndex('')).toBeNull();
    expect(parseMarketplaceIndex('not json at all')).toBeNull();
    expect(parseMarketplaceIndex('{"broken": ')).toBeNull();
    expect(parseMarketplaceIndex('[]')).toBeNull();
  });
});

describe('loadMarketplaceIndex + findEntry', () => {
  let dir: string;

  it('从本地文件加载，baseDir 为索引所在目录', () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-mkt-'));
    const indexFile = join(dir, 'marketplace.json');
    writeFileSync(indexFile, VALID_INDEX, 'utf-8');

    const loaded = loadMarketplaceIndex(indexFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.baseDir).toBe(dir);
    expect(loaded!.index.plugins).toHaveLength(2);

    const hit = findEntry(loaded!, 'echo-tools');
    expect(hit?.version).toBe('1.0.0');
    expect(findEntry(loaded!, 'nonexistent')).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在 / 内容非法 → null（不抛错）', () => {
    expect(loadMarketplaceIndex(join(tmpdir(), 'codex-mkt-no-such-file.json'))).toBeNull();

    const dir2 = mkdtempSync(join(tmpdir(), 'codex-mkt-'));
    const bad = join(dir2, 'bad.json');
    writeFileSync(bad, '这不是索引', 'utf-8');
    expect(loadMarketplaceIndex(bad)).toBeNull();
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('installPlugin', () => {
  const loaded = (() => {
    const idx = parseMarketplaceIndex(VALID_INDEX)!;
    return { index: idx, baseDir: 'C:\\base' };
  })();

  it('成功安装：相对路径以索引目录为基准，返回绝对 pluginPath', async () => {
    const loader: PluginLoader = {
      loadPlugin: async (p) => {
        expect(p.endsWith(join('plugins', 'echo-tools.mjs'))).toBe(true);
        return 2;
      },
    };
    const result = await installPlugin(loaded, loaded.index.plugins[0], loader);
    expect(result.success).toBe(true);
    expect(result.detail).toBe('已加载 2 个工具');
    expect(result.pluginPath).toBe(join('C:\\base', 'plugins', 'echo-tools.mjs'));
  });

  it('loadPlugin 返回 0 = 去重幂等成功', async () => {
    const loader: PluginLoader = { loadPlugin: async () => 0 };
    const result = await installPlugin(loaded, loaded.index.plugins[0], loader);
    expect(result.success).toBe(true);
    expect(result.detail).toContain('去重');
  });

  it('loadPlugin 抛错 = 结构化失败（含原因，不抛出）', async () => {
    const loader: PluginLoader = {
      loadPlugin: async () => {
        throw new Error('插件形状非法');
      },
    };
    const result = await installPlugin(loaded, loaded.index.plugins[0], loader);
    expect(result.success).toBe(false);
    expect(result.detail).toBe('插件形状非法');
    expect(result.pluginPath).toBeUndefined();
  });

  it('绝对路径 source.path 不做基准拼接', async () => {
    const entry = {
      name: 'abs-plugin',
      version: '1.0.0',
      source: { kind: 'file' as const, path: 'D:\\plugins\\abs.mjs' },
    };
    const loader: PluginLoader = {
      loadPlugin: async (p) => {
        expect(p).toBe('D:\\plugins\\abs.mjs');
        return 1;
      },
    };
    const result = await installPlugin(loaded, entry, loader);
    expect(result.success).toBe(true);
    expect(result.pluginPath).toBe('D:\\plugins\\abs.mjs');
  });
});

// ---- V5.5 远程源（url）----

describe('url 源：索引形状校验', () => {
  it('合法 url 条目解析（https + 64 位 sha256）', () => {
    const raw = JSON.stringify({
      version: 1,
      plugins: [
        {
          name: 'remote-tool',
          version: '1.0.0',
          source: { kind: 'url', url: 'https://cdn.example.com/remote-tool.mjs', sha256: 'a'.repeat(64) },
        },
      ],
    });
    const idx = parseMarketplaceIndex(raw);
    expect(idx).not.toBeNull();
    expect(idx!.plugins).toHaveLength(1);
    expect(idx!.plugins[0].source).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/remote-tool.mjs',
      sha256: 'a'.repeat(64),
    });
  });

  it('供应链红线：http:// / 缺 sha256 / 短 sha256 条目均被剔除（不降级）', () => {
    const mk = (source: unknown) =>
      JSON.stringify({ version: 1, plugins: [{ name: 'r', version: '1.0.0', source }] });
    // 非法条目跳过后索引仍合法但 plugins 为空（与既有"逐条过滤"语义一致）
    expect(parseMarketplaceIndex(mk({ kind: 'url', url: 'http://cdn.example.com/x.mjs', sha256: 'a'.repeat(64) }))!.plugins).toHaveLength(0);
    expect(parseMarketplaceIndex(mk({ kind: 'url', url: 'https://cdn.example.com/x.mjs' }))!.plugins).toHaveLength(0);
    expect(parseMarketplaceIndex(mk({ kind: 'url', url: 'https://cdn.example.com/x.mjs', sha256: 'a'.repeat(63) }))!.plugins).toHaveLength(0);
    expect(parseMarketplaceIndex(mk({ kind: 'url', url: 'https://cdn.example.com/x.mjs', sha256: 'xyz' }))!.plugins).toHaveLength(0);
    // 未知 kind 依旧剔除
    expect(parseMarketplaceIndex(mk({ kind: 'git', url: 'https://x' }))!.plugins).toHaveLength(0);
  });

  it('混合源索引：file 与 url 条目共存', () => {
    const raw = JSON.stringify({
      version: 1,
      plugins: [
        { name: 'local-a', version: '1.0.0', source: { kind: 'file', path: 'a.mjs' } },
        { name: 'remote-b', version: '1.0.0', source: { kind: 'url', url: 'https://x/b.mjs', sha256: 'b'.repeat(64) } },
      ],
    });
    const idx = parseMarketplaceIndex(raw)!;
    expect(idx.plugins).toHaveLength(2);
    expect(idx.plugins[0].source.kind).toBe('file');
    expect(idx.plugins[1].source.kind).toBe('url');
  });
});

describe('url 源：installPlugin 下载与校验', () => {
  let configDir: string;
  const PLUGIN_CONTENT = `export const plugin = { name: 'remote-tool', version: '1.0.0', register: () => 1 };\n`;
  const GOOD_SHA = createHash('sha256').update(PLUGIN_CONTENT).digest('hex');

  const remoteEntry = {
    name: 'remote-tool',
    version: '1.0.0',
    source: { kind: 'url' as const, url: 'https://cdn.example.com/remote-tool.mjs', sha256: GOOD_SHA },
  };

  /** 桩下载器：返回固定内容并记录调用次数 */
  function stubFetcher(content: string): UrlFetcher & { calls: number } {
    const fn = (async () => {
      fn.calls++;
      return new TextEncoder().encode(content).buffer as ArrayBuffer;
    }) as UrlFetcher & { calls: number };
    fn.calls = 0;
    return fn;
  }

  beforeAll(() => {
    // 隔离配置目录（下载缓存落此处）
    configDir = join(tmpdir(), `codex-test-config-v55-${Date.now()}`);
    process.env.CODEX_CONFIG_PATH = configDir;
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('成功安装：下载 → sha256 通过 → 落缓存 → loadPlugin', async () => {
    const fetcher = stubFetcher(PLUGIN_CONTENT);
    const loader: PluginLoader = {
      loadPlugin: async (p) => {
        expect(existsSync(p)).toBe(true); // 落盘后才加载
        expect(readFileSync(p, 'utf-8')).toBe(PLUGIN_CONTENT);
        return 1;
      },
    };
    const result = await installPlugin({ index: { version: 1, plugins: [] }, baseDir: '.' }, remoteEntry, loader, fetcher);
    expect(result.success).toBe(true);
    expect(result.detail).toBe('已加载 1 个工具');
    expect(fetcher.calls).toBe(1);
    // 缓存目录确实有文件
    expect(readdirSync(join(configDir, 'plugins')).length).toBe(1);
  });

  it('缓存复用：二次安装不重复下载（本地 sha256 复核通过）', async () => {
    const fetcher = stubFetcher(PLUGIN_CONTENT);
    const loader: PluginLoader = { loadPlugin: async () => 0 };
    const loaded = { index: { version: 1 as const, plugins: [] }, baseDir: '.' };
    await installPlugin(loaded, remoteEntry, loader, fetcher);
    expect(fetcher.calls).toBe(0); // 上一测试已缓存，本次零下载
    const result = await installPlugin(loaded, remoteEntry, loader, fetcher);
    expect(result.success).toBe(true);
    expect(fetcher.calls).toBe(0);
  });

  it('sha256 不符 → 拒绝安装且不落盘（pin 红线）', async () => {
    const tampered = stubFetcher(PLUGIN_CONTENT + '// 被篡改的内容\n');
    const loader: PluginLoader = { loadPlugin: async () => { throw new Error('不应到达'); } };
    const result = await installPlugin(
      { index: { version: 1, plugins: [] }, baseDir: '.' },
      {
        name: 'remote-tool',
        version: '9.9.9', // 不同版本 → 不同缓存文件名，避开上一缓存
        source: { kind: 'url', url: 'https://cdn.example.com/remote-tool-v99.mjs', sha256: GOOD_SHA },
      },
      loader,
      tampered,
    );
    expect(result.success).toBe(false);
    expect(result.detail).toContain('sha256 校验失败');
  });

  it('下载内容为空 → 拒绝', async () => {
    const empty = stubFetcher('');
    const loader: PluginLoader = { loadPlugin: async () => 1 };
    const result = await installPlugin(
      { index: { version: 1, plugins: [] }, baseDir: '.' },
      {
        name: 'remote-tool',
        version: '8.8.8',
        source: { kind: 'url', url: 'https://cdn.example.com/empty.mjs', sha256: createHash('sha256').update('').digest('hex') },
      },
      loader,
      empty,
    );
    expect(result.success).toBe(false);
    expect(result.detail).toContain('为空');
  });

  it('缓存被篡改 → 复核失败作废重下（不静默采用污染缓存）', async () => {
    // 先用正确内容装一次建立缓存
    const good = stubFetcher(PLUGIN_CONTENT);
    const loader: PluginLoader = { loadPlugin: async () => 1 };
    const entry = {
      name: 'remote-tool',
      version: '7.7.7',
      source: { kind: 'url' as const, url: 'https://cdn.example.com/remote-tool-v77.mjs', sha256: GOOD_SHA },
    };
    await installPlugin({ index: { version: 1, plugins: [] }, baseDir: '.' }, entry, loader, good);

    // 篡改缓存文件内容
    const cacheDir = join(configDir, 'plugins');
    const file = readdirSync(cacheDir).find((f) => f.includes('7.7.7'))!;
    writeFileSync(join(cacheDir, file), '恶意替换内容', 'utf-8');

    // 再装：缓存复核失败 → 作废 → 重新下载正确内容 → 成功
    const refetch = stubFetcher(PLUGIN_CONTENT);
    const result = await installPlugin({ index: { version: 1, plugins: [] }, baseDir: '.' }, entry, loader, refetch);
    expect(result.success).toBe(true);
    expect(refetch.calls).toBe(1);
    expect(readFileSync(join(cacheDir, file), 'utf-8')).toBe(PLUGIN_CONTENT);
  });

  it('下载器抛错 → 结构化失败（网络错误不炸）', async () => {
    const fail: UrlFetcher = async () => {
      throw new Error('下载失败: HTTP 404');
    };
    const loader: PluginLoader = { loadPlugin: async () => 1 };
    const result = await installPlugin(
      { index: { version: 1, plugins: [] }, baseDir: '.' },
      {
        name: 'remote-tool',
        version: '6.6.6',
        source: { kind: 'url', url: 'https://cdn.example.com/missing.mjs', sha256: 'c'.repeat(64) },
      },
      loader,
      fail,
    );
    expect(result.success).toBe(false);
    expect(result.detail).toContain('HTTP 404');
  });

  it('file 源回归：不经下载器（fetcher 零调用）', async () => {
    const fetcher = stubFetcher(PLUGIN_CONTENT);
    const loader: PluginLoader = { loadPlugin: async () => 1 };
    const entry = { name: 'f', version: '1.0.0', source: { kind: 'file' as const, path: 'x.mjs' } };
    const result = await installPlugin({ index: { version: 1, plugins: [] }, baseDir: '.' }, entry, loader, fetcher);
    expect(result.success).toBe(true);
    expect(fetcher.calls).toBe(0);
  });
});

// ---- V5.8 插件更新（卸旧装新版本升级流）----

describe('updatePlugin', () => {
  const loaded = (() => {
    const idx = parseMarketplaceIndex(VALID_INDEX)!;
    return { index: idx, baseDir: 'C:\\base' };
  })();

  /** 桩更新器：记录调用顺序，可配置 loadPlugin 行为 */
  function stubRegistry(
    behavior: { load?: (p: string) => number | Promise<number>; unloadReturn?: number } = {},
  ): PluginUpdater & { calls: string[] } {
    const stub = {
      calls: [] as string[],
      async loadPlugin(p: string): Promise<number> {
        stub.calls.push(`load:${p}`);
        if (behavior.load) return await behavior.load(p);
        return 2;
      },
      unloadPlugin(id: string): number {
        stub.calls.push(`unload:${id}`);
        return behavior.unloadReturn ?? 2;
      },
    };
    return stub;
  }

  it('升级成功：先卸旧（按名）后装新，removedPaths 含旧路径、pluginPath 为新路径', async () => {
    const reg = stubRegistry();
    const oldPath = 'C:\\config\\plugins\\echo-tools-0.9.0-abcd1234.mjs';
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, [oldPath]);
    expect(result.success).toBe(true);
    expect(result.pluginPath).toBe(join('C:\\base', 'plugins', 'echo-tools.mjs'));
    expect(result.removedPaths).toEqual([oldPath]);
    expect(result.detail).toContain('已升级到 1.0.0');
    // 顺序红线：unload 必须先于 load（按名卸载晚于装新会误删新版注册）
    expect(reg.calls[0]).toBe('unload:echo-tools');
    expect(reg.calls[1]).toBe('load:' + join('C:\\base', 'plugins', 'echo-tools.mjs'));
    expect(reg.calls).toHaveLength(2);
  });

  it('原子性：安装失败 → removedPaths 恒空（旧版配置不动），detail 含失败原因', async () => {
    const reg = stubRegistry({ load: () => { throw new Error('新版协议校验失败'); } });
    const oldPath = 'C:\\config\\plugins\\echo-tools-0.9.0-abcd1234.mjs';
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, [oldPath]);
    expect(result.success).toBe(false);
    expect(result.removedPaths).toEqual([]);
    expect(result.pluginPath).toBeUndefined();
    expect(result.detail).toContain('升级到 1.0.0 失败');
    expect(result.detail).toContain('新版协议校验失败');
    expect(result.detail).toContain('旧版配置未动');
  });

  it('同路径原地刷新：新旧路径相同 → removedPaths 为空（配置无需变更）', async () => {
    const reg = stubRegistry();
    const samePath = join('C:\\base', 'plugins', 'echo-tools.mjs');
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, [samePath]);
    expect(result.success).toBe(true);
    expect(result.pluginPath).toBe(samePath);
    expect(result.removedPaths).toEqual([]);
  });

  it('多条旧路径（url 缓存 + file 源并存）全部列入 removedPaths', async () => {
    const reg = stubRegistry();
    const old1 = 'C:\\config\\plugins\\echo-tools-0.9.0-11111111.mjs';
    const old2 = 'D:\\legacy\\echo-tools.mjs';
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, [old1, old2]);
    expect(result.success).toBe(true);
    expect(result.removedPaths).toEqual([old1, old2]);
  });

  it('运行时未加载旧版（unloadPlugin 返回 -1）→ 仍可升级，detail 不含卸载信息', async () => {
    const reg = stubRegistry({ unloadReturn: -1 });
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, ['C:\\old\\echo-tools.mjs']);
    expect(result.success).toBe(true);
    expect(result.detail).not.toContain('卸载旧版');
  });

  it('url 源升级：新版本缓存文件名不同 → 旧缓存路径列入 removedPaths', async () => {
    const PLUGIN_V2 = `export const plugin = { name: 'remote-tool', version: '2.0.0', register: () => 1 };\n`;
    const shaV2 = createHash('sha256').update(PLUGIN_V2).digest('hex');
    const configDir = join(tmpdir(), `codex-test-config-v58-${Date.now()}`);
    process.env.CODEX_CONFIG_PATH = configDir;
    try {
      const fetcher = (async () =>
        new TextEncoder().encode(PLUGIN_V2).buffer as ArrayBuffer) as UrlFetcher;
      const reg = stubRegistry();
      const oldCache = join(configDir, 'plugins', 'remote-tool-1.0.0-aaaaaaaa.mjs');
      const entry = {
        name: 'remote-tool',
        version: '2.0.0',
        source: { kind: 'url' as const, url: 'https://cdn.example.com/remote-tool.mjs', sha256: shaV2 },
      };
      const result = await updatePlugin(
        { index: { version: 1, plugins: [] }, baseDir: '.' },
        entry,
        reg,
        [oldCache],
        fetcher,
      );
      expect(result.success).toBe(true);
      expect(result.pluginPath).not.toBe(oldCache);
      expect(result.removedPaths).toEqual([oldCache]);
      expect(existsSync(result.pluginPath!)).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ---- V5.9 版本感知更新 ----

describe('compareVersions', () => {
  it('基本数值比较：主/次/修订级', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0); // 数值比较非字符串
    expect(compareVersions('1.0', '1.0.0')).toBe(0); // 缺失段按 0
  });

  it('预发布低于正式版：1.0.0-beta < 1.0.0', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBeLessThan(0);
  });

  it('v 前缀与大小写容错', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('V2.0.0', 'v1.9.9')).toBeGreaterThan(0);
  });
});

describe('updatePlugin 版本感知（V5.9）', () => {
  const loaded = (() => {
    const idx = parseMarketplaceIndex(VALID_INDEX)!;
    return { index: idx, baseDir: 'C:\\base' };
  })();

  function stubRegistry(): PluginUpdater & { calls: string[] } {
    const stub = {
      calls: [] as string[],
      async loadPlugin(p: string): Promise<number> {
        stub.calls.push(`load:${p}`);
        return 1;
      },
      unloadPlugin(id: string): number {
        stub.calls.push(`unload:${id}`);
        return 1;
      },
    };
    return stub;
  }

  it('已装版本 = 索引版本 → 跳过（零卸载零安装，upToDate 标记）', async () => {
    const reg = stubRegistry();
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, ['C:\\old\\p.mjs'], undefined, '1.0.0');
    expect(result.success).toBe(true);
    expect(result.upToDate).toBe(true);
    expect(result.detail).toContain('已是最新版本 1.0.0');
    expect(result.removedPaths).toEqual([]);
    expect(result.pluginPath).toBeUndefined();
    expect(reg.calls).toHaveLength(0); // 未触碰 registry
  });

  it('已装版本 > 索引版本（索引滞后）→ 跳过并提示', async () => {
    const reg = stubRegistry();
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, ['C:\\old\\p.mjs'], undefined, '2.0.0');
    expect(result.upToDate).toBe(true);
    expect(result.detail).toContain('比索引 1.0.0 更新');
    expect(reg.calls).toHaveLength(0);
  });

  it('已装版本 < 索引版本 → 正常升级（走卸旧装新流）', async () => {
    const reg = stubRegistry();
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, ['C:\\old\\p.mjs'], undefined, '0.9.0');
    expect(result.success).toBe(true);
    expect(result.upToDate).toBeUndefined();
    expect(result.pluginPath).toBe(join('C:\\base', 'plugins', 'echo-tools.mjs'));
    expect(reg.calls).toHaveLength(2); // unload + load
  });

  it('无 currentVersion → 保持 V5.8 行为（总是升级）', async () => {
    const reg = stubRegistry();
    const result = await updatePlugin(loaded, loaded.index.plugins[0], reg, ['C:\\old\\p.mjs']);
    expect(result.upToDate).toBeUndefined();
    expect(reg.calls).toHaveLength(2);
  });
});

// ---- V5.10 市场关键词搜索 ----

describe('searchEntries', () => {
  const loaded = (() => {
    const idx = parseMarketplaceIndex(
      JSON.stringify({
        version: 1,
        plugins: [
          { name: 'echo-tools', version: '1.0.0', description: '回显与时间戳示例工具', source: { kind: 'file', path: 'a.mjs' } },
          { name: 'echo-advanced', version: '2.0.0', description: '高级回显', source: { kind: 'file', path: 'b.mjs' } },
          { name: 'lint-helper', version: '0.2.1', description: 'echo 风格的 lint 辅助', source: { kind: 'file', path: 'c.mjs' } },
          { name: 'time-utils', version: '1.1.0', source: { kind: 'file', path: 'd.mjs' } },
        ],
      }),
    )!;
    return { index: idx };
  })();

  it('子串命中 name 与 description（大小写不敏感）', () => {
    const hits = searchEntries(loaded, 'ECHO');
    expect(hits.map((h) => h.name)).toContain('echo-tools');
    expect(hits.map((h) => h.name)).toContain('lint-helper'); // 命中 description
    expect(hits.some((h) => h.name === 'time-utils')).toBe(false);
  });

  it('相关性排序：name 前缀 > name 包含 > 仅 description 命中', () => {
    const hits = searchEntries(loaded, 'echo');
    expect(hits[0].name).toBe('echo-tools'); // 前缀（3 分）高于 advanced 的包含（2 分）？二者均前缀——精确比较
    expect(hits.map((h) => h.name)).not.toContain('time-utils');
  });

  it('精确名命中排最前', () => {
    const hits = searchEntries(loaded, 'echo-tools');
    expect(hits).toHaveLength(1); // 仅 echo-tools 精确命中（lint-helper 描述无该子串）
    expect(hits[0].name).toBe('echo-tools');
  });

  it('多关键词 AND 语义：全命中才返回', () => {
    // lint-helper：name 含 lint + description 含 echo → 双词全中；
    // echo-tools：echo 命中但 lint 双域皆无 → 排除
    const hits = searchEntries(loaded, 'echo lint');
    expect(hits.map((h) => h.name)).toEqual(['lint-helper']);
    expect(searchEntries(loaded, 'echo 回显').map((h) => h.name)).toContain('echo-tools');
  });

  it('空查询 / 纯空白 → 空（不等于全量列表）', () => {
    expect(searchEntries(loaded, '')).toEqual([]);
    expect(searchEntries(loaded, '   ')).toEqual([]);
  });

  it('无命中 → 空数组', () => {
    expect(searchEntries(loaded, 'zzz不存在')).toEqual([]);
  });
});
