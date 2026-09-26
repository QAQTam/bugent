/**
 * 工作区 undo 的真实文件系统适配器。
 *
 * 路径仍走 resolveWithin：undo 不能成为绕过文件工具沙箱的新入口。
 */

import { stat, unlink } from "node:fs/promises";
import type { WorkspaceFs } from "../core/workspace-undo.ts";
import { atomicWriteWithin } from "./atomic-write.ts";
import { resolveWithin } from "./paths.ts";

export function createWorkspaceFs(root: string): WorkspaceFs {
  return {
    async read(path) {
      const absolute = resolveWithin(root, path);
      const file = Bun.file(absolute);
      return (await file.exists()) ? await file.text() : undefined;
    },

    async write(path, text) {
      const absolute = resolveWithin(root, path);

      // BUG-020：undo 恢复要保留原文件的权限位（脚本丢了 +x 就跑不起来了）。
      const mode = await stat(absolute)
        .then((s) => s.mode & 0o777)
        .catch(() => undefined);

      // 原子写 + TOCTOU 收窄（BUG-012）：与 write_file / edit_file 走同一条
      // 路径 —— temp + rename + 四次边界复核。这里不能图省事直接
      // writeFile(absolute)：那会**跟随**路径上的符号链接，把内容送到工作区外。
      await atomicWriteWithin(root, false, absolute, text, mode);
    },

    async remove(path) {
      const absolute = resolveWithin(root, path);
      try {
        await unlink(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    },
  };
}
