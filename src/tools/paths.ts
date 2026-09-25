/**
 * 路径约束 —— 文件工具的"沙箱"。
 *
 * 文件工具是**进程内**操作，没法用 bwrap 隔离，所以必须在路径解析这一步兜住：
 *   1. 解析后的绝对路径必须落在工作目录内（挡 `../` 逃逸）
 *   2. 对**最近的存在祖先**做 realpath 再校验一次（挡符号链接逃逸）
 *   3. 最后一段**本身**是符号链接时单独再判一次（挡悬空链接）
 *
 * 第 2 条容易被忽略：`cwd/link -> /etc`，光看 `cwd/link/passwd` 字面上没越界，
 * 但它真实指向工作目录之外。
 *
 * 第 3 条是第 2 条的补丁：`existsSync` 会**跟随**符号链接，悬空链接因此返回
 * false，`nearestExisting` 就一路上溯到父目录（在工作区内），这条路径被判为
 * 安全 —— 但真正写盘时内核会跟随链接，落到工作区外。实测确实能逃逸。
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  readonly input: string;

  constructor(input: string, root: string) {
    super(`path escapes the workspace: ${JSON.stringify(input)} is outside ${root}`);
    this.name = "PathEscapeError";
    this.input = input;
  }
}

function assertInside(root: string, target: string, input: string): void {
  if (target === root) return;
  if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new PathEscapeError(input, root);
  }
}

/** 找到路径上最近的一个已存在的祖先（用于对新文件也做 realpath 校验）。 */
function nearestExisting(target: string): string {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * 把用户传入的路径解析成工作目录内的绝对路径；越界直接抛错。
 */
export function resolveWithin(cwd: string, input: string): string {
  const root = realpathSync(resolve(cwd));
  const target = resolve(root, input);

  assertInside(root, target, input);

  // 符号链接防护（一）：对最近存在的祖先取真实路径再校验
  const existing = nearestExisting(target);
  if (existsSync(existing)) {
    assertInside(root, realpathSync(existing), input);
  }

  // 符号链接防护（二）：最后一段本身是符号链接时，必须能证明它指向工作区内。
  // 悬空链接 realpath 会抛错 —— 解不出来就无法证明，一律拒绝。
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      throw new PathEscapeError(input, root);
    }
    assertInside(root, resolved, input);
  }

  return target;
}

/** 转成相对工作目录的展示路径。 */
export function relativeTo(cwd: string, target: string): string {
  const root = resolve(cwd);
  if (target === root) return ".";
  if (target.startsWith(root + sep)) return target.slice(root.length + 1);
  return target;
}
