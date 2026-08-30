/**
 * V4.1 插件开放协议测试 — 对应 V4.1-ITERATION-PROMPT.md 执行清单
 * 覆盖：合法插件加载执行 / 协议形状校验（畸形拒绝） / name@version 去重 / loadPlugins 批量隔离
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolRegistry } from '../src/tools/registry.js';

// 动态 import 的插件文件必须是真实文件（file:// URL 加载）
let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), 'codex-plugin-'));
  toolRegistry.clear();
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
  toolRegistry.clear();
});

/** 写一个合法插件（注册一个 echo 工具）—— .mjs：Node 原生动态加载，贴近真实插件分发形态 */
function writeValidPlugin(name = 'test-plugin', version = '1.0.0', toolName = 'echo_tool'): string {
  const path = join(pluginDir, `${name.replace(/[^a-z0-9-]/gi, '_')}-${version}.mjs`);
  writeFileSync(
    path,
    `export const plugin = {
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  register(registry) {
    registry.register({
      name: ${JSON.stringify(toolName)},
      description: '回显输入',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (params) => ({ success: true, output: \`echo: \${params.text}\` }),
    });
    return 1;
  },
};
`,
  );
  return path;
}

describe('loadPlugin（V4.1 协议强化）', () => {
  it('合法插件：加载 + 工具可执行', async () => {
    const path = writeValidPlugin();
    const count = await toolRegistry.loadPlugin(path);
    expect(count).toBe(1);
    expect(toolRegistry.get('echo_tool')).toBeDefined();
    expect(toolRegistry.size).toBe(1);

    const result = await toolRegistry.execute('echo_tool', { text: 'hi' }, {
      workingDir: '.',
      readFile: () => null,
      writeFile: () => {},
      listFiles: () => [],
      searchContent: () => [],
      confirm: async () => true,
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('echo: hi');
  });

  it('畸形插件（缺 register）→ 拒绝加载', async () => {
    const path = join(pluginDir, 'bad1.mjs');
    writeFileSync(path, `export const plugin = { name: 'bad', version: '1.0.0' };\n`);
    await expect(toolRegistry.loadPlugin(path)).rejects.toThrow(/CodexPlugin 协议/);
  });

  it('畸形插件（name 为空字符串）→ 拒绝加载', async () => {
    const path = join(pluginDir, 'bad2.mjs');
    writeFileSync(
      path,
      `export const plugin = { name: '  ', version: '1.0.0', register: () => 0 };\n`,
    );
    await expect(toolRegistry.loadPlugin(path)).rejects.toThrow(/CodexPlugin 协议/);
  });

  it('畸形插件（无任何导出）→ 拒绝加载', async () => {
    const path = join(pluginDir, 'bad3.mjs');
    writeFileSync(path, `export const unrelated = 1;\n`);
    await expect(toolRegistry.loadPlugin(path)).rejects.toThrow(/CodexPlugin 协议/);
  });

  it('重复加载同版本插件 → 去重返回 0（不炸）', async () => {
    const path = writeValidPlugin();
    expect(await toolRegistry.loadPlugin(path)).toBe(1);
    // 同一文件再加载：工具名冲突本会抛错，但 name@version 去重先拦截
    expect(await toolRegistry.loadPlugin(path)).toBe(0);
    expect(toolRegistry.size).toBe(1);
  });

  it('同插件升级版本 → 允许再次加载', async () => {
    const v1 = writeValidPlugin('test-plugin', '1.0.0', 'echo_tool');
    await toolRegistry.loadPlugin(v1);
    // 新版本注册不同工具名（同名会冲突——协议层面由插件作者负责改名或版本语义）
    const v2 = writeValidPlugin('test-plugin', '2.0.0', 'echo_tool_v2');
    expect(await toolRegistry.loadPlugin(v2)).toBe(1);
    expect(toolRegistry.size).toBe(2);
  });
});

describe('loadPlugins（批量隔离）', () => {
  it('单插件失败不拖累其他', async () => {
    const good = writeValidPlugin('good-plugin', '1.0.0', 'echo_tool');
    const bad = join(pluginDir, 'broken.mjs');
    writeFileSync(bad, `export const not_a_plugin = true;\n`);

    const results = await toolRegistry.loadPlugins([bad, good]);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeTruthy();
    expect(results[0].count).toBe(0);
    expect(results[1].error).toBeUndefined();
    expect(results[1].count).toBe(1);
    // 好插件正常可用
    expect(toolRegistry.get('echo_tool')).toBeDefined();
  });
});

// ---- V5.2 插件卸载 ----

describe('unloadPlugin（V5.2）', () => {
  it('按 name 卸载：工具移除 + 去重标记清除（可重新加载）', async () => {
    const path = writeValidPlugin('removable', '1.0.0', 'remove_tool');
    expect(await toolRegistry.loadPlugin(path)).toBe(1);
    expect(toolRegistry.get('remove_tool')).toBeDefined();

    const removed = toolRegistry.unloadPlugin('removable');
    expect(removed).toBe(1);
    expect(toolRegistry.get('remove_tool')).toBeUndefined();
    expect(toolRegistry.size).toBe(0);
    expect(toolRegistry.loadedPluginIds).toEqual([]);

    // 去重标记已清除 → 同一插件可重新加载
    expect(await toolRegistry.loadPlugin(path)).toBe(1);
    expect(toolRegistry.get('remove_tool')).toBeDefined();
  });

  it('按完整 id（name@version）卸载', async () => {
    const path = writeValidPlugin('id-based', '3.1.4', 'id_tool');
    await toolRegistry.loadPlugin(path);
    expect(toolRegistry.unloadPlugin('id-based@3.1.4')).toBe(1);
    expect(toolRegistry.get('id_tool')).toBeUndefined();
  });

  it('卸载只移除目标插件的工具（其他插件不受影响）', async () => {
    const a = writeValidPlugin('plugin-a', '1.0.0', 'tool_a');
    const b = writeValidPlugin('plugin-b', '1.0.0', 'tool_b');
    await toolRegistry.loadPlugin(a);
    await toolRegistry.loadPlugin(b);
    expect(toolRegistry.size).toBe(2);

    expect(toolRegistry.unloadPlugin('plugin-a')).toBe(1);
    expect(toolRegistry.get('tool_a')).toBeUndefined();
    expect(toolRegistry.get('tool_b')).toBeDefined(); // plugin-b 完好
    expect(toolRegistry.loadedPluginIds).toEqual(['plugin-b@1.0.0']);
  });

  it('未加载的插件返回 -1', () => {
    expect(toolRegistry.unloadPlugin('never-loaded')).toBe(-1);
  });

  it('卸载后同名工具可被其他来源重新注册（缓存失效）', async () => {
    const path = writeValidPlugin('cache-test', '1.0.0', 'cache_tool');
    await toolRegistry.loadPlugin(path);
    expect(toolRegistry.unloadPlugin('cache-test')).toBe(1);

    // 同名工具重新注册不冲突（工具 Map 已清理）
    toolRegistry.register({
      name: 'cache_tool',
      description: '新来源',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true, output: 'ok' }),
    });
    expect(toolRegistry.get('cache_tool')).toBeDefined();
  });
});
