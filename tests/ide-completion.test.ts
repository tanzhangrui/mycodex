/**
 * V3.3 — 本地 FIM Tab 补全 + 终端自然语言化：纯逻辑测试
 * 对应 V3.3-ITERATION-PROMPT.md 执行清单
 */
import { describe, it, expect } from 'vitest';
import {
  shouldTrigger,
  buildFimPrompt,
  cleanFimResponse,
  FIM_BEGIN,
  FIM_HOLE,
  FIM_END,
  DEFAULT_FIM_LIMITS,
} from '../codex-ide/src/completion/fim-core.js';
import {
  buildNlCommandPrompt,
  parseNlCommandResponse,
  isDangerousCommand,
} from '../codex-ide/src/terminal/nl-command-core.js';

// ---- FIM 触发判定 ----

describe('shouldTrigger（防按键风暴）', () => {
  it('有语义内容的前缀触发', () => {
    expect(shouldTrigger('const us')).toBe(true);
    expect(shouldTrigger('  console.l')).toBe(true);
  });

  it('空/过短前缀不触发', () => {
    expect(shouldTrigger('')).toBe(false);
    expect(shouldTrigger('ab')).toBe(false);
    expect(shouldTrigger('   ')).toBe(false);
  });

  it('纯标点不触发（无补全语义）', () => {
    expect(shouldTrigger('})')).toBe(false);
    expect(shouldTrigger('();')).toBe(false);
  });
});

// ---- FIM prompt 构建 ----

describe('buildFimPrompt（qwen2.5-coder FIM 模板）', () => {
  it('正确套入三段模板', () => {
    const prompt = buildFimPrompt('const a = 1;\n', '\nconst b = 2;');
    expect(prompt.startsWith(FIM_BEGIN)).toBe(true);
    expect(prompt.endsWith(FIM_END)).toBe(true);
    expect(prompt).toContain(`${FIM_HOLE}\nconst b = 2;`);
    expect(prompt).toContain(`const a = 1;\n${FIM_HOLE}`);
  });

  it('prefix 超限裁剪为末尾 N 行', () => {
    const prefix = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
    const prompt = buildFimPrompt(prefix, '', { ...DEFAULT_FIM_LIMITS, maxPrefixLines: 10 });
    const inner = prompt.slice(FIM_BEGIN.length, prompt.indexOf(FIM_HOLE));
    const lines = inner.split('\n');
    expect(lines.length).toBe(10);
    expect(lines[0]).toBe('line-90'); // 保留末尾
    expect(lines[9]).toBe('line-99');
  });

  it('suffix 超限裁剪为开头 M 行', () => {
    const suffix = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
    const prompt = buildFimPrompt('', suffix, { ...DEFAULT_FIM_LIMITS, maxSuffixLines: 5 });
    const inner = prompt.slice(prompt.indexOf(FIM_HOLE) + FIM_HOLE.length, -FIM_END.length);
    const lines = inner.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('line-0'); // 保留开头
  });
});

// ---- FIM 响应清洗 ----

describe('cleanFimResponse（弱模型容错）', () => {
  it('正常补全原样保留（去尾部空白）', () => {
    expect(cleanFimResponse('console.log("hi")  \n')).toBe('console.log("hi")');
  });

  it('截断 FIM_END 模板残留', () => {
    expect(cleanFimResponse(`console.log("hi")${FIM_END}garbage`)).toBe('console.log("hi")');
  });

  it('截断其他模板 token', () => {
    expect(cleanFimResponse('foo()<|endoftext|>bar')).toBe('foo()');
    expect(cleanFimResponse('foo()<|im_end|>bar')).toBe('foo()');
  });

  it('纯空白输出返回空（无幽灵建议）', () => {
    expect(cleanFimResponse('   \n  ')).toBe('');
    expect(cleanFimResponse(FIM_END)).toBe('');
  });

  it('多行补全止于首个空行（弱模型长尾截断）', () => {
    const raw = 'const x = 1;\nconst y = 2;\n\n垃圾长尾内容';
    expect(cleanFimResponse(raw)).toBe('const x = 1;\nconst y = 2;');
  });
});

// ---- NL → 终端命令 ----

describe('buildNlCommandPrompt', () => {
  it('注入平台与 shell 上下文', () => {
    const prompt = buildNlCommandPrompt({ platform: 'win32', shell: 'powershell', workingDir: 'C:\\proj' });
    expect(prompt).toContain('win32');
    expect(prompt).toContain('powershell');
    expect(prompt).toContain('C:\\proj');
    expect(prompt).toContain('只输出一条命令');
  });

  it('无工作目录时省略', () => {
    const prompt = buildNlCommandPrompt({ platform: 'linux', shell: 'bash' });
    expect(prompt).not.toContain('当前工作目录');
  });
});

describe('parseNlCommandResponse（模型输出容错解析）', () => {
  it('裸命令直接返回', () => {
    expect(parseNlCommandResponse('Get-ChildItem -Recurse | Measure-Object')).toBe(
      'Get-ChildItem -Recurse | Measure-Object',
    );
  });

  it('markdown 代码块提取内容', () => {
    const raw = '好的，命令如下：\n```powershell\nGet-Process | Sort-Object CPU -Descending | Select-Object -First 5\n```\n祝使用愉快';
    expect(parseNlCommandResponse(raw)).toBe(
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
    );
  });

  it('跳过模型前言取首个非空行', () => {
    expect(parseNlCommandResponse('命令是：\nls -la\n第二行不需要')).toBe('ls -la');
  });

  it('去掉行内注释', () => {
    expect(parseNlCommandResponse('du -sh * # 查看目录大小')).toBe('du -sh *');
  });

  it('去掉"命令:"前缀', () => {
    expect(parseNlCommandResponse('命令: git status')).toBe('git status');
  });

  it('空输出返回空', () => {
    expect(parseNlCommandResponse('')).toBe('');
    expect(parseNlCommandResponse('   \n ')).toBe('');
  });
});

describe('isDangerousCommand（危险命令检测）', () => {
  it('识别 rm -rf 与变体', () => {
    expect(isDangerousCommand('rm -rf /tmp/x')).toBe(true);
    expect(isDangerousCommand('rm -fr dir')).toBe(true);
  });

  it('识别 Windows 危险命令', () => {
    expect(isDangerousCommand('rmdir /s /q build')).toBe(true);
    expect(isDangerousCommand('Remove-Item -Recurse -Force .')).toBe(true);
    expect(isDangerousCommand('reg delete HKCU\\X /f')).toBe(true);
  });

  it('识别删库/强推/格式化', () => {
    expect(isDangerousCommand('mysql -e "DROP TABLE users"')).toBe(true);
    expect(isDangerousCommand('git push origin main --force')).toBe(true);
    expect(isDangerousCommand('format D:')).toBe(true);
  });

  it('普通命令不误报', () => {
    expect(isDangerousCommand('git status')).toBe(false);
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('npm run build')).toBe(false);
    expect(isDangerousCommand('Get-ChildItem')).toBe(false);
  });
});
