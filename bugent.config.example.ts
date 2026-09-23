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
});
