/**
 * 配置加载。
 *
 * 解析顺序（先命中先用）：
 *   1. `~/.bugent/config.toml`   —— 首选，缺失时自动生成一份带注释的默认配置
 *   2. `./bugent.config.ts`      —— 项目级覆盖（Bun 原生 import TS）
 *   3. 环境变量                   —— 最后的兜底
 *
 * 项目级 `.ts/.js` 配置是**任意代码** —— import 即执行（BUG-014）。所以它
 * 必须过一道确认门：首次（或文件变化后）执行前向用户展示路径与 SHA256，
 * 确认结果记入 `~/.bugent/trusted-project-configs.json`（路径 → 哈希），
 * 之后同哈希免提示。`--yes` 语义是"跳过所有权限确认"，同样适用于这里。
 * 确认钩子由入口注入（`confirmProjectConfig`）；不注入（测试 / 嵌入调用）
 * 时保持旧行为直接执行。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BugentConfig } from "./schema.ts";
import { configDir, configFilePath, ensureConfigFile, parseConfigToml } from "./toml.ts";

const PROJECT_CONFIG_FILENAMES = ["bugent.config.ts", "bugent.config.js", "bugent.config.mjs"];

export interface ProjectConfigConfirmation {
  /** 即将执行的项目配置的绝对路径。 */
  path: string;
  /** 文件内容的 SHA256（信任记录的键值）。 */
  hash: string;
}

/** 返回 true 表示用户同意执行并记住这份哈希。 */
export type ProjectConfigConfirm = (request: ProjectConfigConfirmation) => Promise<boolean>;

function trustedConfigsPath(home?: string): string {
  return join(configDir(home), "trusted-project-configs.json");
}

async function readTrustedConfigs(home?: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(trustedConfigsPath(home)).text());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

async function rememberTrustedConfig(path: string, hash: string, home?: string): Promise<void> {
  const trusted = await readTrustedConfigs(home);
  trusted[path] = hash;
  mkdirSync(configDir(home), { recursive: true });
  await Bun.write(trustedConfigsPath(home), `${JSON.stringify(trusted, null, 2)}\n`);
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

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

async function loadProjectConfig(
  cwd: string,
  gate: { confirm: ProjectConfigConfirm | undefined; home?: string } = { confirm: undefined },
): Promise<BugentConfig | undefined> {
  for (const name of PROJECT_CONFIG_FILENAMES) {
    const path = join(cwd, name);
    if (!(await Bun.file(path).exists())) continue;

    // 确认门（BUG-014）：import 即执行任意代码，首次 / 哈希变化时必须先问。
    // 没注入确认钩子的调用方（测试 / 嵌入）保持旧行为。
    let cacheBust: string | undefined;
    if (gate.confirm !== undefined) {
      const hash = await sha256File(path);
      cacheBust = hash;
      const trusted = await readTrustedConfigs(gate.home);
      if (trusted[path] !== hash) {
        const approved = await gate.confirm({ path, hash });
        if (!approved) {
          throw new Error(
            `拒绝执行 ${name}：项目级配置是任意代码，且尚未获得信任。` +
              "确认可信后重跑并批准；一次性场景可用 --yes 跳过确认。",
          );
        }
        await rememberTrustedConfig(path, hash, gate.home);
      }
    }

    // 缓存隔离：Bun 的模块缓存对 `file://…?query` 不去重，对**裸路径+query**
    // 才会区分（实测）。POSIX 上用裸路径 + 哈希查询；Windows 退回 file URL
    // （每进程只 loadConfig 一次，跨内容重导只影响测试 / 嵌入场景）。
    const specifier =
      cacheBust !== undefined && process.platform !== "win32"
        ? `${path}?bugent_hash=${cacheBust}`
        : pathToFileURL(path).href;
    const module = (await import(specifier)) as { default?: unknown };
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
  /**
   * 项目级 bugent.config.ts 的执行确认门（BUG-014）。入口必须注入；
   * 缺省（测试 / 嵌入）时保持旧行为直接执行。
   */
  confirmProjectConfig?: ProjectConfigConfirm;
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
    const projectConfig = await loadProjectConfig(cwd, {
      confirm: options.confirmProjectConfig,
      ...(options.home !== undefined ? { home: options.home } : {}),
    });
    if (projectConfig !== undefined) {
      return { config: projectConfig, source: "bugent.config.ts", created };
    }
  }

  // 3) 环境变量
  return { config: configFromEnv(), source: "环境变量", created: false };
}

export type { BugentConfig };
