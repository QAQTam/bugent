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
import { dirname, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  readonly input: string;

  constructor(input: string, root: string) {
    super(`path escapes the workspace: ${JSON.stringify(input)} is outside ${root}`);
    this.name = "PathEscapeError";
    this.input = input;
  }
}

/**
 * 表示"整个文件系统"。
 *
 * 作为 `resolveReadable` 的 extraRoots 元素时代表"允许任意路径"。用它在调用点
 * 显式写出意图，比传一个裸 `sep` 更容易看出来这里放宽了边界。
 */
export const ANYWHERE = sep;

/** target 是否落在 root 内（含 root 本身）。 */
function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function assertInsideAny(roots: readonly string[], target: string, input: string): void {
  for (const root of roots) {
    if (isInside(root, target)) return;
  }
  throw new PathEscapeError(input, roots.join(" | "));
}

/**
 * 把一个"根"规范成真实路径。
 *
 * 产物目录（`~/.bugent/output/<session>/`）在第一次落盘前并不存在，直接
 * `realpathSync` 会抛错、白名单整个失效。所以对**最近存在的祖先**取真实路径，
 * 再把剩余部分拼回去 —— 与 resolveWithin 对目标做的是同一件事。
 */
function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const existing = nearestExisting(absolute);
  if (!existsSync(existing)) return absolute;
  const real = realpathSync(existing);
  const rest = relative(existing, absolute);
  return rest === "" ? real : resolve(real, rest);
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
 * 把用户传入的路径解析成"允许访问的绝对路径"；越界直接抛错。
 *
 * 相对路径一律相对 `cwd` 解析。`extraRoots` 是**额外的只读白名单**：目前只有
 * `read_file` 用到它，用来读回工具自己落在 `~/.bugent/output/<session>/` 的
 * 完整输出 —— bash 会把那个路径告诉模型，模型必须真的读得到。
 *
 * 写路径**不要**传 extraRoots：写只能落在工作区内。
 */
export function resolveReadable(
  cwd: string,
  input: string,
  extraRoots: readonly string[] = [],
): string {
  const roots = [realpathSync(resolve(cwd)), ...extraRoots.map(canonicalRoot)];
  const target = resolve(roots[0]!, input);

  assertInsideAny(roots, target, input);

  // 符号链接防护（一）：对最近存在的祖先取真实路径再校验
  const existing = nearestExisting(target);
  if (existsSync(existing)) {
    assertInsideAny(roots, realpathSync(existing), input);
  }

  // 符号链接防护（二）：最后一段本身是符号链接时，必须能证明它指向允许范围内。
  // 悬空链接 realpath 会抛错 —— 解不出来就无法证明，一律拒绝。
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      throw new PathEscapeError(input, roots.join(" | "));
    }
    assertInsideAny(roots, resolved, input);
  }

  return target;
}

/**
 * 把用户传入的路径解析成工作目录内的绝对路径；越界直接抛错。
 *
 * 写路径与所有路径型工具走这里 —— 等价于 `resolveReadable(cwd, input, [])`。
 */
export function resolveWithin(cwd: string, input: string): string {
  return resolveReadable(cwd, input);
}

/**
 * 按"本次调用是否获准越界"选择解析宽度。
 *
 * 所有**写**路径都该走这里：`grantedOutside` 来自 `ctx.grant.writeOutside`，
 * 由闸门按次授权得出，不是档位。
 */
export function resolveForWrite(cwd: string, input: string, grantedOutside: boolean): string {
  return grantedOutside ? resolveReadable(cwd, input, [ANYWHERE]) : resolveWithin(cwd, input);
}

/** 转成相对工作目录的展示路径。 */
export function relativeTo(cwd: string, target: string): string {
  const root = resolve(cwd);
  if (target === root) return ".";
  if (target.startsWith(root + sep)) return target.slice(root.length + 1);
  return target;
}
