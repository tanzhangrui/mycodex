/**
 * V5.28 召回质量回归基准
 * ==========================================
 * 固定语料 + 期望命中集：召回链路的任何调参（阈值 / IDF / 权重 / n-gram）
 * 破坏既有召回质量时在此红灯，而非等用户在真实对话里踩坑。
 *
 * 断言分三类：
 * 1. 召回（期望文件必须出现在组装结果中）
 * 2. 排序（期望文件须进 top-N——加权回归的代理指标）
 * 3. 负例（无信号查询不误召回；索引不变量）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../src/context/context-engine.js';

// ---- 固定语料（覆盖 TS 类/函数/barrel/import 图/中文注释语义信号） ----

const CORPUS: Array<[rel: string, content: string]> = [
  [
    'src/user/auth-service.ts',
    `export class AuthService {
  /** 用户登录：校验账号密码并签发会话 token */
  async login(user: string, pass: string): Promise<string> {
    if (!user || !pass) throw new Error('missing credentials');
    return 'token';
  }

  /** 注销当前会话 */
  async logout(): Promise<void> {}
}
`,
  ],
  [
    'src/user/user-repo.ts',
    `import { AuthService } from './auth-service';

export class UserRepository {
  private users: Array<{ id: string; name: string }> = [];

  findUser(id: string) {
    return this.users.find((u) => u.id === id);
  }

  /** 注册前先校验登录态 */
  register(auth: AuthService): void {}
}
`,
  ],
  [
    'src/cart/cart-service.ts',
    `export class CartService {
  private items: Array<{ sku: string; qty: number }> = [];

  /** 购物车添加商品 */
  addItem(sku: string, qty: number): void {}

  /** 结算订单总价 */
  checkout(): Promise<number> {
    return Promise.resolve(0);
  }
}
`,
  ],
  [
    'src/payment/payment-gateway.ts',
    `/** 支付网关：对接三方支付渠道，处理扣款与回调 */
export class PaymentGateway {
  async charge(orderId: string, amount: number): Promise<boolean> {
    return true;
  }

  async refund(orderId: string): Promise<boolean> {
    return false;
  }
}
`,
  ],
  [
    'src/util/logger.ts',
    `export function logInfo(msg: string): void {}
export function logError(msg: string): void {}
`,
  ],
  [
    'src/index.ts',
    `export * from './user/auth-service';
export * from './user/user-repo';
export * from './cart/cart-service';
export * from './payment/payment-gateway';
`,
  ],
  [
    'src/app.ts',
    `import { AuthService, CartService, PaymentGateway } from './index';

export function bootstrap(auth: AuthService, cart: CartService, pay: PaymentGateway): void {
  auth.login('a', 'b');
  cart.checkout();
  pay.charge('o1', 100);
}
`,
  ],
];

let root: string;
let engine: ContextEngine;

beforeAll(async () => {
  process.env.CODEX_CONFIG_PATH = join(tmpdir(), `codex-bench-cfg-${Date.now()}`);
  root = mkdtempSync(join(tmpdir(), 'codex-bench-v528-'));
  for (const [rel, content] of CORPUS) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  engine = new ContextEngine();
  await engine.index(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 组装结果路径序（top-N 断言用） */
function rankedPaths(query: string): string[] {
  return engine.assembleContext(query, { maxTokens: 20_000 }).map((c) => c.path);
}

function rankOf(paths: string[], file: string): number {
  const i = paths.indexOf(file);
  return i === -1 ? Number.POSITIVE_INFINITY : i + 1; // 1 起始
}

describe('V5.28 召回质量回归基准', () => {
  it('符号+语义混合查询：定义文件召回且进 top-3（auth）', () => {
    const paths = rankedPaths('AuthService login token');
    expect(paths).toContain('src/user/auth-service.ts');
    expect(rankOf(paths, 'src/user/auth-service.ts')).toBeLessThanOrEqual(3);
  });

  it('中文口语查询：语义路召回支付网关且进 top-3', () => {
    const paths = rankedPaths('支付 扣款 网关');
    expect(paths).toContain('src/payment/payment-gateway.ts');
    expect(rankOf(paths, 'src/payment/payment-gateway.ts')).toBeLessThanOrEqual(3);
  });

  it('关键词查询：购物车结算召回 cart-service 且进 top-3', () => {
    const paths = rankedPaths('cart checkout');
    expect(paths).toContain('src/cart/cart-service.ts');
    expect(rankOf(paths, 'src/cart/cart-service.ts')).toBeLessThanOrEqual(3);
  });

  it('符号查询：使用点路连带真实消费者（穿透 barrel）', () => {
    const paths = rankedPaths('UserRepository');
    expect(paths).toContain('src/user/user-repo.ts'); // 定义
    expect(paths).toContain('src/index.ts'); // barrel 使用点（hop 1）
  });

  it('多符号查询：app.ts 作为多符号使用点被召回', () => {
    const paths = rankedPaths('AuthService CartService PaymentGateway');
    expect(paths).toContain('src/app.ts'); // 三个命中符号的 hop-2 importer
  });

  it('定义优先不变量：定义文件排在依赖扩展与关键词窗口之前', () => {
    const paths = rankedPaths('AuthService login token');
    const defRank = rankOf(paths, 'src/user/auth-service.ts');
    const loggerRank = rankOf(paths, 'src/util/logger.ts');
    // logger 与查询无关：要么未被召回，要么严格排在定义之后
    if (Number.isFinite(loggerRank)) expect(defRank).toBeLessThan(loggerRank);
  });

  it('负例：无信号查询不误召回（阈值与 IDF 防线）', () => {
    expect(rankedPaths('zzzqqq wvvv')).toEqual([]);
  });

  it('索引不变量：组装结果全部是索引内文件且带行区间', () => {
    const chunks = engine.assembleContext('支付网关 charge refund', { maxTokens: 20_000 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.path.startsWith('src/')).toBe(true);
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      expect(c.relevance).toBeGreaterThan(0);
    }
  });

  it('预算裁剪不变量：收紧 token 预算只减不乱（前缀保持相对序）', () => {
    const wide = engine.assembleContext('支付 扣款 网关 charge', { maxTokens: 20_000 });
    const tight = engine.assembleContext('支付 扣款 网关 charge', { maxTokens: 600 });
    expect(tight.length).toBeLessThanOrEqual(wide.length);
    // 窄预算是宽预算按序的截断（不重排）
    expect(tight.map((c) => c.path)).toEqual(wide.slice(0, tight.length).map((c) => c.path));
  });
});
