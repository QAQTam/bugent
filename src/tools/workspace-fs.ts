/**
 * 工作区 undo 的真实文件系统适配器。
 *
 * 路径仍走 resolveWithin：undo 不能成为绕过文件工具沙箱的新入口。
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
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
      await writeFile(absolute, text, "utf8");
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
