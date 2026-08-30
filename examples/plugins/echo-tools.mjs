/**
 * 示例插件 — echo-tools
 * ==========================================
 *
 * 演示 CodexPlugin 开放协议（V4.1+）：零依赖纯 Node ESM，可直接被
 * `toolRegistry.loadPlugin()` 加载。两个工具：
 *   - word_count：统计文本词数（无副作用，享受结果缓存）
 *   - timestamp：格式化当前时间戳（有副作用语义，演示参数验证）
 */

export const plugin = {
  name: 'echo-tools',
  version: '1.0.0',

  /**
   * 注册工具。registry 只暴露 register——插件拿不到引擎内部状态。
   * @returns 注册的工具数量
   */
  register(registry) {
    registry.register({
      name: 'word_count',
      description: '统计文本的词数（按空白分词）',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待统计的文本' },
        },
        required: ['text'],
      },
      execute: async (params) => {
        const text = String(params.text ?? '');
        const words = text.split(/\s+/).filter(Boolean).length;
        return {
          success: true,
          output: `${words} 词 / ${text.length} 字符`,
          data: { words, chars: text.length },
        };
      },
    });

    registry.register({
      name: 'timestamp',
      description: '生成格式化时间戳（默认 ISO，可选 local）',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'iso | local' },
        },
      },
      execute: async (params) => {
        const now = new Date();
        const format = params.format === 'local' ? 'local' : 'iso';
        return {
          success: true,
          output: format === 'local' ? now.toLocaleString() : now.toISOString(),
        };
      },
    });

    return 2;
  },
};
