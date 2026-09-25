/**
 * 工作区 undo 的真实文件系统适配器。
 *
 * 路径仍走 resolveWithin：undo 不能成为绕过文件工具沙箱的新入口。
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceFs } from "../core/workspace-undo.ts";
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
      await mkdir(dirname(absolute), { recursive: true });

      // 原子写：与 write_file / edit_file 保持一致，先写同目录临时文件再 rename。
      //
      // 这里不能图省事直接 writeFile(absolute)：那会**跟随**路径上的符号链接。
      // 工作区里可以合法存在一个指向外面的悬空链接（bash 在 workspace-write 档
      // 下能建），直接写就等于把内容送到工作区外。rename 是替换目标而不是跟随，
      // 顺带还拿到"写一半崩掉不留半截文件"的好处。
      const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temp, text, "utf8");
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
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
