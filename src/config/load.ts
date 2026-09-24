/**
 * 配置加载。
 *
 * 解析顺序（先命中先用）：
 *   1. `~/.bugent/config.toml`   —— 首选，缺失时自动生成一份带注释的默认配置
 *   2. `./bugent.config.ts`      —— 项目级覆盖（Bun 原生 import TS）
 *   3. 环境变量                   —— 最后的兜底
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BugentConfig } from "./schema.ts";
import { configFilePath, ensureConfigFile, parseConfigToml } from "./toml.ts";

const PROJECT_CONFIG_FILENAMES = ["bugent.config.ts", "bugent.config.js", "bugent.config.mjs"];

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
  };
}

async function loadProjectConfig(cwd: string): Promise<BugentConfig | undefined> {
  for (const name of PROJECT_CONFIG_FILENAMES) {
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
  /** 跳过所有配置文件，只用环境变量。 */
  ignoreFile?: boolean;
  /** 覆盖 home 目录（测试用）。 */
  home?: string;
  /** 缺失时不生成默认配置（测试用，避免污染真实 HOME）。 */
  noCreate?: boolean;
}

export interface LoadedConfig {
  config: BugentConfig;
  /** 配置来源，用于在 UI 上如实告知用户"读的是哪份配置"。 */
  source: string;
  /** 本次是否新建了默认配置文件。 */
  created: boolean;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();

  if (!options.ignoreFile) {
    // 1) ~/.bugent/config.toml
    const userPath = configFilePath(options.home);
    const created = options.noCreate === true ? false : await ensureConfigFile(userPath);

    if (await Bun.file(userPath).exists()) {
      const text = await Bun.file(userPath).text();
      try {
        return { config: parseConfigToml(text), source: userPath, created };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${userPath} 解析失败：${detail}`);
      }
    }

    // 2) 项目内配置
    const projectConfig = await loadProjectConfig(cwd);
    if (projectConfig !== undefined) {
      return { config: projectConfig, source: "bugent.config.ts", created };
    }
  }

  // 3) 环境变量
  return { config: configFromEnv(), source: "环境变量", created: false };
}

export type { BugentConfig };
