/**
 * 配置加载：优先读 cwd 下的 `bugent.config.ts`，没有就退回环境变量。
 * 环境变量覆盖（Phase 5 会扩展成完整的优先级链）。
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SYSTEM_PROMPT, type BugentConfig } from "./schema.ts";

const CONFIG_FILENAMES = ["bugent.config.ts", "bugent.config.js", "bugent.config.mjs"];

function configFromEnv(): BugentConfig {
  const apiKey = Bun.env.BUGENT_API_KEY ?? Bun.env.OPENAI_API_KEY;
  const baseUrl = Bun.env.BUGENT_BASE_URL ?? "https://api.openai.com/v1";
  const model = Bun.env.BUGENT_MODEL ?? "gpt-4o-mini";

  return {
    defaultModel: `openai/${model}`,
    providers: [
      {
        id: "openai",
        endpoint: "openai-chat",
        baseUrl,
        ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
      },
    ],
    agent: { systemPrompt: DEFAULT_SYSTEM_PROMPT },
  };
}

async function loadConfigFile(cwd: string): Promise<BugentConfig | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const path = join(cwd, name);
    if (!(await Bun.file(path).exists())) continue;

    const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
    const config = module.default;
    if (config === undefined || typeof config !== "object") {
      throw new Error(`${name} 必须 default export 一个配置对象（建议用 defineConfig）`);
    }
    return config as BugentConfig;
  }
  return undefined;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** 强制忽略 config 文件，只用环境变量（`--mock` 等场景用）。 */
  ignoreFile?: boolean;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<BugentConfig> {
  const cwd = options.cwd ?? process.cwd();
  if (!options.ignoreFile) {
    const fromFile = await loadConfigFile(cwd);
    if (fromFile !== undefined) return fromFile;
  }
  return configFromEnv();
}

export { DEFAULT_SYSTEM_PROMPT };
export type { BugentConfig };
