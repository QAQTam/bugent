/**
 * 工具产物落盘。
 *
 * 为什么需要：bash 的输出可能几十万字符，全塞给模型既浪费上下文又没意义。
 * 做法是——**给模型看截断版，完整版写到文件并告诉它去哪读**。
 *
 * 存放位置刻意放在 `~/.bugent/output/<sessionId>/` 而不是工作目录：
 * 不污染用户的仓库。代价是 read_file 需要为这个目录开一个只读白名单
 * （见 src/tools/paths.ts 的 resolveReadable）。
 */

import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { configDir } from "../config/toml.ts";

export const OUTPUT_DIR_NAME = "output";

export function outputRoot(home?: string): string {
  return `${configDir(home)}/${OUTPUT_DIR_NAME}`;
}

export function sessionOutputDir(sessionId: string, home?: string): string {
  return `${outputRoot(home)}/${sessionId}`;
}

/** 完整输出落盘，返回绝对路径。 */
export async function spillOutput(
  sessionId: string,
  callId: string,
  text: string,
  home?: string,
): Promise<string> {
  const dir = sessionOutputDir(sessionId, home);
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${callId}.txt`;
  await Bun.write(path, text);
  return path;
}

/** 路径是否落在产物目录内（read_file 的只读白名单判定）。 */
export function isInsideOutputRoot(target: string, home?: string): boolean {
  const root = resolve(outputRoot(home));
  const resolved = resolve(target);
  return resolved === root || resolved.startsWith(root + sep);
}
