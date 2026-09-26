/**
 * 工作区内原子写 + TOCTOU 收窄（BUG-012）。
 *
 * `resolveWithin` 的符号链接防护发生在**解析时**；真正落盘的
 * `mkdir` / `writeFile` / `rename` 会穿透中间目录的符号链接。并行工具批里
 * （loop 用 Promise.all 并发执行），一个 bash 调用可以在 resolve 之后把目录
 * 换成指向工作区外的符号链接 —— 旧实现对此毫无防护。
 *
 * 这里把窗口从"resolve 到 rename 的全程"收窄成毫秒级的校验间隙：
 *   1. mkdir 前核对目录真身仍在边界内；
 *   2. mkdir 后、temp 落盘前再核一次（mkdir 可能穿过了被换掉的链接）；
 *   3. temp 写完、rename 前最后一道闸；
 *   4. rename 后核对最终落点，发现落点越界时清除自己刚写的文件并报错。
 * 剩余窗口需要攻击者连续赢下毫秒级竞态；彻底关闭需要
 * openat2(RESOLVE_NO_SYMLINKS) 语义，等运行时暴露。
 *
 * 注意：越界授权（`grantedOutside`，来自闸门按次授权）时不再核对 ——
 * 此时边界本来就更宽，核对只会误杀合法写。
 */

import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithin } from "./paths.ts";

function realPathOfExisting(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function assertDirInside(root: string, dir: string): void {
  // resolveWithin 自带符号链接防护；真身若在边界外直接抛 PathEscapeError
  resolveWithin(root, dir);
}

export async function atomicWriteWithin(
  root: string,
  grantedOutside: boolean,
  absolute: string,
  contents: string,
  mode: number | undefined,
): Promise<void> {
  const dir = dirname(absolute);

  // 校验 1：建目录之前
  if (!grantedOutside) {
    const before = realPathOfExisting(dir);
    if (before !== undefined) assertDirInside(root, before);
  }

  await mkdir(dir, { recursive: true });

  // temp 名加入随机段：同毫秒并发写同一目标不再共享临时文件
  const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    // 校验 2：temp 落盘之前（mkdir 可能已经穿过了被换掉的目录）
    if (!grantedOutside) {
      assertDirInside(root, realPathOfExisting(dir) ?? dir);
    }
    await writeFile(temp, contents, {
      encoding: "utf8",
      flag: "wx",
      ...(mode !== undefined ? { mode } : {}),
    });
    if (mode !== undefined) await chmod(temp, mode);

    // 校验 3：rename 前的最后一道闸
    if (!grantedOutside) {
      assertDirInside(root, realPathOfExisting(dir) ?? dir);
    }
    await rename(temp, absolute);

    // 校验 4：rename 与校验 3 之间目录仍可能被换 —— 最终落点越界就清除
    // 自己刚写的文件并如实报错。
    if (!grantedOutside) {
      const landed = realPathOfExisting(absolute);
      if (landed !== undefined) {
        try {
          resolveWithin(root, landed);
        } catch (error) {
          await unlink(absolute).catch(() => {});
          throw error;
        }
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
