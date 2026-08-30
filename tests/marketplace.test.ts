/**
 * V4.4 插件市场索引协议测试
 * 覆盖：索引解析（完整 JSON / 围栏块 / 大括号提取）/ 形状校验与容错 /
 * 条目去重与上限 / 本地索引加载 / 按名查找 / install（成功/去重幂等/失败）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMarketplaceIndex,
  loadMarketplaceIndex,
  findEntry,
  installPlugin,
  type PluginLoader,
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
