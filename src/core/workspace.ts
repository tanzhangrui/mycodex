/**
 * V5.0 — 多仓库工作区解析器（核心层）
 * ==========================================
 *
 * 单 workingDir 假设贯穿引擎/agent-loop/IDE——monorepo 多仓场景（前端仓 +
 * 服务仓 + 共享库仓）下检索只见一仓。本模块提供多根基础原语：
 *
 * - 多根注册 + 根名去重（repo → repo-2）
 * - 双向路径映射：绝对路径 ⇄ 工作区相对路径（rootName/相对路径）
 * - 边界安全：越界路径显式拒绝（contains / toWorkspaceRel 返回 null）
 *
 * 引擎侧（context-engine）以 rootName/rel 为统一平面键空间消费多根。
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { statSync } from 'node:fs';

export interface WorkspaceRoot {
  /** 工作区内唯一名（去重后） */
  name: string;
  /** 绝对路径（已 resolve） */
  abs: string;
}

export class WorkspaceResolver {
  private readonly roots: WorkspaceRoot[] = [];
  private readonly byName = new Map<string, WorkspaceRoot>();

  /**
   * @param roots 根目录列表（首个为主根：CODEX.md 规则、默认工作目录）
   * @throws 根路径不存在或不是目录
   */
  constructor(roots: string[]) {
    if (roots.length === 0) throw new Error('WorkspaceResolver 至少需要一个根目录');

    const usedNames = new Set<string>();
    for (const root of roots) {
      const abs = resolve(root);
      const stat = statSync(abs);
      if (!stat.isDirectory()) throw new Error(`工作区根不是目录: ${abs}`);

      // 根名去重：basename 冲突时追加 -2/-3…（双仓同 basename 是常态）
      let name = abs.split(sep).filter(Boolean).pop() ?? 'root';
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${name}-${suffix++}`;
      }
      usedNames.add(name);

      const entry: WorkspaceRoot = { name, abs };
      this.roots.push(entry);
      this.byName.set(name, entry);
    }
  }

  /** 主根（第一个）：规则文件与默认工作目录语义 */
  get primaryRoot(): string {
    return this.roots[0].abs;
  }

  get rootList(): readonly WorkspaceRoot[] {
    return this.roots;
  }

  get rootNames(): string[] {
    return this.roots.map((r) => r.name);
  }

  /** 绝对路径是否在任一根内（边界安全判定；先 resolve 防 ../../../ 逃逸） */
  contains(absPath: string): boolean {
    const abs = resolve(absPath);
    return this.roots.some((r) => this.isInside(abs, r.abs));
  }

  /**
   * 绝对路径 → 工作区相对路径（rootName/rel）。
   * 越界（不在任何根内）返回 null——路径逃逸是安全问题不是 bug。
   */
  toWorkspaceRel(absPath: string): string | null {
    const abs = resolve(absPath);
    for (const r of this.roots) {
      if (this.isInside(abs, r.abs)) {
        const rel = relative(r.abs, abs);
        if (!rel) return r.name; // 根目录本身
        return `${r.name}/${rel.split(sep).join('/')}`;
      }
    }
    return null;
  }

  /**
   * 工作区相对路径（rootName/rel）→ 绝对路径。
   * 未知根名 / 空段返回 null。
   */
  toAbsolute(wsRel: string): string | null {
    const normalized = wsRel.replace(/\\/g, '/').replace(/\/+/g, '/');
    const sepIdx = normalized.indexOf('/');
    const rootName = sepIdx === -1 ? normalized : normalized.slice(0, sepIdx);
    const rest = sepIdx === -1 ? '' : normalized.slice(sepIdx + 1);

    const root = this.byName.get(rootName);
    if (!root) return null;
    if (rest.includes('..')) return null; // 段级逃逸拒绝
    if (rest === '') return root.abs;
    return resolve(root.abs, rest);
  }

  /**
   * 解析任意输入路径（绝对或相对主根）→ 绝对路径。
   * 相对路径以主根为基准；结果必须落在任一根内，否则 null。
   */
  resolveInput(inputPath: string): string | null {
    const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(this.primaryRoot, inputPath);
    return this.contains(abs) ? abs : null;
  }

  /** path 是否严格位于 root 内（含等于 root 本身） */
  private isInside(path: string, root: string): boolean {
    if (path === root) return true;
    return path.startsWith(root + sep);
  }
}

/**
 * 便捷构造：单根时行为与旧 workingDir 完全一致（兼容层）。
 * @throws 根不存在
 */
export function createWorkspace(roots: string | string[]): WorkspaceResolver {
  return new WorkspaceResolver(Array.isArray(roots) ? roots : [roots]);
}
