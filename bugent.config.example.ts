/**
 * bugent 配置示例。复制成 `bugent.config.ts` 后按需修改。
 *
 * 没有配置文件时，bugent 会退回环境变量：
 *   BUGENT_API_KEY / OPENAI_API_KEY、BUGENT_BASE_URL、BUGENT_MODEL
 */

import { defineConfig, DEFAULT_SYSTEM_PROMPT } from "./src/config/schema.ts";

export default defineConfig({
  /** 默认模型，格式 "provider/model"。 */
  defaultModel: "openai/gpt-4o-mini",

  providers: [
    {
      id: "openai",
      endpoint: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
    },
    {
      // 任何 OpenAI 兼容端点都能这样接（DeepSeek / Moonshot / Ollama / vLLM …）
      id: "deepseek",
      endpoint: "openai-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
    {
      // 无网络联调用
      id: "mock",
      endpoint: "mock",
    },
  ],

  agent: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxSteps: 16,
  },

  /**
   * 权限策略：规则按顺序匹配，第一条命中即生效；都不命中用 default。
   * default 默认是 "ask"（每次执行工具都问一次）。
   *
   * 注意 glob 里的 `*` 匹配任意字符（含 `/`），所以给 bash 配白名单要非常小心：
   * `"ls*"` 会把 `ls; rm -rf /` 一起放行。
   */
  permissions: {
    default: "ask",
    rules: [
      // 只读操作自动放行，减少打断
      { tool: "read_file", decision: "allow" },
      // 明确禁止的危险命令
      { tool: "bash", resource: "rm -rf /*", decision: "deny" },
      { tool: "bash", resource: "sudo *", decision: "deny" },
    ],
  },

  /**
   * 沙箱档位（Linux / bubblewrap）。
   *
   *   read-only        根只读 + 工作区只读 + 断网
   *   workspace-write  根只读 + 工作区可写 + 断网
   *   no-sandbox       不隔离，可读写任意位置
   *
   * 联网不走档位 —— 默认断网，命令失败时按次询问授权（带真实报错）。
   */
  sandbox: {
    mode: "workspace-write",
    // 需要写 $HOME 下缓存时显式放行（默认 HOME 是只读的）
    writablePaths: [],
  },
});
