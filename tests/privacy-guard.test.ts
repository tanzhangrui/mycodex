/**
 * 隐私守卫测试 — 对应 AI-IDE-MASTER-PROMPT.md ADR-5 质量红线
 */
import { describe, it, expect } from 'vitest';
import {
  isSensitivePath,
  commandTouchesSensitiveTarget,
  sanitizeEnvForChild,
  redactSecrets,
} from '../src/core/privacy-guard.js';
import { InMemoryFileSystem } from '../src/core/in-memory-fs.js';
import { Sandbox } from '../src/sandbox/sandbox.js';

describe('isSensitivePath', () => {
  it('拦截 .env 系列文件', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('config/.env')).toBe(true);
    expect(isSensitivePath('C:\\proj\\.env')).toBe(true);
  });

  it('拦截私钥与证书', () => {
    expect(isSensitivePath('server.pem')).toBe(true);
    expect(isSensitivePath('id_rsa')).toBe(true);
    expect(isSensitivePath('~/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('cert.p12')).toBe(true);
  });

  it('拦截凭据文件', () => {
    expect(isSensitivePath('credentials.json')).toBe(true);
    expect(isSensitivePath('.npmrc')).toBe(true);
    expect(isSensitivePath('secrets.yaml')).toBe(true);
    expect(isSensitivePath('.aws/config')).toBe(true);
  });

  it('放行正常代码文件', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false);
    expect(isSensitivePath('environment.ts')).toBe(false);
    expect(isSensitivePath('README.md')).toBe(false);
    expect(isSensitivePath('package.json')).toBe(false);
  });
});

describe('commandTouchesSensitiveTarget', () => {
  it('拦截引用敏感文件的命令', () => {
    expect(commandTouchesSensitiveTarget('cat .env')).toBe(true);
    expect(commandTouchesSensitiveTarget('type .env.local')).toBe(true);
    expect(commandTouchesSensitiveTarget('cat server.pem')).toBe(true);
    expect(commandTouchesSensitiveTarget('cat ~/.ssh/id_rsa')).toBe(true);
  });

  it('拦截读取密钥环境变量的命令', () => {
    expect(commandTouchesSensitiveTarget('echo $GLM_API_KEY')).toBe(true);
    expect(commandTouchesSensitiveTarget('echo %ANTHROPIC_API_KEY%')).toBe(true);
    expect(commandTouchesSensitiveTarget('echo $env:DEEPSEEK_API_KEY')).toBe(true);
  });

  it('放行正常命令', () => {
    expect(commandTouchesSensitiveTarget('npm install')).toBe(false);
    expect(commandTouchesSensitiveTarget('node -v')).toBe(false);
    expect(commandTouchesSensitiveTarget('cat src/index.ts')).toBe(false);
    expect(commandTouchesSensitiveTarget('git status')).toBe(false);
  });
});

describe('sanitizeEnvForChild', () => {
  it('剥离密钥变量，保留普通变量', () => {
    const env = {
      PATH: '/usr/bin',
      GLM_API_KEY: 'secret-key-123',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      MY_TOKEN: 'tok',
      DB_PASSWORD: 'pw',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv;

    const clean = sanitizeEnvForChild(env);
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.NODE_ENV).toBe('test');
    expect(clean.GLM_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.MY_TOKEN).toBeUndefined();
    expect(clean.DB_PASSWORD).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('脱敏密钥值', () => {
    const out = redactSecrets('api_key = "sk-1234567890abcdef"');
    expect(out).not.toContain('sk-1234567890abcdef');
    expect(out).toContain('***REDACTED***');
  });
});

describe('InMemoryFileSystem 隐私隔离', () => {
  it('敏感文件读写删除均被拒绝', async () => {
    const fs = new InMemoryFileSystem();
    await fs.snapshot(process.cwd());

    expect(fs.read('.env')).toBeNull();
    fs.write('.env', 'LEAK=1');
    expect(fs.read('.env')).toBeNull();
    fs.delete('.env');
    expect(fs.isDirty() && fs.read('.env') !== null).toBe(false);
  });
});

describe('Sandbox 隐私拦截', () => {
  it('引用敏感文件的命令被阻止', async () => {
    const sandbox = new Sandbox({ skipConfirm: true });
    const result = await sandbox.execute('cat .env');
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('隐私');
  });

  it('普通命令不受影响', async () => {
    const sandbox = new Sandbox({ skipConfirm: true });
    const result = await sandbox.execute(process.platform === 'win32' ? 'echo hello' : 'echo hello');
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hello');
  });
});
