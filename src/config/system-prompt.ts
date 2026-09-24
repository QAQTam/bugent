/**
 * System prompt 加载。
 *
 * system prompt 不再写死在源码里，而是从 Markdown 文件读取。
 * 默认使用仓库内的 `src/prompts/system.md`；配置可覆盖为任意路径。
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { embeddedFile, SYSTEM_PROMPT_ASSET } from "../runtime/standalone.ts";

export interface LoadedSystemPrompt {
  text: string;
  source: string;
}

function resolvePromptPath(input: string, cwd: string): string {
  let path = input;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export async function loadSystemPrompt(options: {
  file?: string;
  cwd: string;
}): Promise<LoadedSystemPrompt> {
  if (options.file === undefined) {
    const embedded = embeddedFile(SYSTEM_PROMPT_ASSET);
    if (embedded !== undefined) {
      const text = (await embedded.text()).trimEnd();
      if (text.length === 0) throw new Error("standalone system prompt 为空");
      return { text, source: `embedded:${SYSTEM_PROMPT_ASSET}` };
    }
  }

  const source =
    options.file !== undefined
      ? resolvePromptPath(options.file, options.cwd)
      : join(import.meta.dir, "../prompts/system.md");

  const file = Bun.file(source);
  if (!(await file.exists())) {
    throw new Error(`system prompt 文件不存在：${source}`);
  }
  const text = (await file.text()).trimEnd();
  if (text.length === 0) {
    throw new Error(`system prompt 文件为空：${source}`);
  }
  return { text, source };
}
