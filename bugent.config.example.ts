/**
 * bugent 配置示例。复制成 `bugent.config.ts` 后按需修改。
 *
 * 没有配置文件时，bugent 会退回环境变量：
 *   BUGENT_API_KEY / OPENAI_API_KEY、BUGENT_BASE_URL、BUGENT_MODEL
 */

import { defineConfig } from "./src/config/schema.ts";

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
    systemPromptFile: "~/.bugent/SYSTEM.md",
    maxSteps: 16,
  },

  /**
   * 权限策略：规则按顺序匹配，第一条命中即生效；都不命中用 default。
   * default 默认是 "ask"（每次执行工具都问一次）。
   *
   * 注意 glob 里的 `*` 匹配任意字符（含 `/`），所以给 bash 配白名单要非常小心：
   * `"ls*"` 会把 `ls; rm -rf /` 一起放行。
   *
   * ⚠️ bash 规则按**原始命令文本**匹配 —— 这是有意的取舍，必须知道它的局限：
   *   { tool: "bash", resource: "rm -rf /*", decision: "deny" }
   * 挡不住 `env rm -rf /`、`sudo rm -rf /`、`bash -c "rm -rf /*"`、
   * `rm${IFS}-rf ...`、`\rm`、换行/引号/大小写变体 —— 规则匹配的是字面量，
   * 不是命令语义。要把 bash 限制住，靠的是沙箱档位（read-only 档内核挡写）
   * 和按次授权，而不是 deny 规则；deny 适合挡"这条具体命令绝对不要跑"。
   */
  permissions: {
    default: "ask",
    rules: [
      // 只读操作自动放行，减少打断
      { tool: "read_file", decision: "allow" },
      // 明确禁止的具体命令（字面匹配，见上方的局限说明）
      { tool: "bash", resource: "rm -rf /*", decision: "deny" },
      { tool: "bash", resource: "sudo *", decision: "deny" },
    ],
  },

  /**
   * 沙箱档位（Linux / bubblewrap）。
   *
   * 档位 = **默认批准范围**，不是隔离开关。沙箱恒开，档位只决定"要不要问"。
   *
   *   read-only        读免问；写工作区 / 写工作区外 / 联网 → 逐次批准
   *   workspace-write  读 + 写工作区免问；写工作区外 / 联网 → 逐次批准
   *   no-sandbox       全部免问（沙箱仍在，只是不拦截）
   *
   * 读工作区之外在三档都是自由的。
   *
   * 联网不走档位 —— 默认断网，命令失败时按次询问授权（带真实报错）。
   */
  sandbox: {
    mode: "workspace-write",
    // 需要写 $HOME 下缓存时显式放行（默认 HOME 是只读的）
    writablePaths: [],
  },

  /**
   * 授权硬件提醒。
   *
   * 授权窗口 60 秒没人应答就按超时**拒绝**。终端 BEL 只在终端里响，TUI
   * 重绘时还常被吞掉 —— 这个开关让提醒走硬件，用户切到别的窗口也能被叫回来：
   *
   *   speaker  主板蜂鸣器（pcspkr）。绕过音量/耳机/静音，只要机器通电就响；
   *            需要 /dev/input/eventN 的写权限，装一次 udev 规则即可（见
   *            docs/authorization-alert.md）。
   *   sound    声卡合成音。无特权要求，但会被音量/静音影响。
   *   bell     终端 BEL。兜底，等价于现有行为。
   *
   * 时序：弹窗出现响一个三音上行动机 → 最后 urgencyWindowMs 内按
   * 10/5/3/1 秒四档升级（越接近超时越急促）→ 批准/拒绝各一个收尾音。
   *
   * 默认关闭：它会真的让机器发声，不能替用户默认打开。
   */
  alert: {
    enabled: false,
    channels: ["speaker", "sound"],
    urgencyWindowMs: 10_000,
    volume: 0.55,
    // speakerDevice: "/dev/input/event17",
    // soundPlayer: ["paplay", "--raw", "--format=s16le", "--rate=48000", "--channels=1"],
  },

  /**
   * Skills 采用渐进披露：
   *   - msgid2 只注入 name + description + load 工具名；
   *   - 模型匹配任务后才调用 skill__<name>__load 读取 SKILL.md 正文。
   *
   * 默认发现 ~/.bugent/skills、~/.agents/skills 和项目内同名目录。
   */
  skills: {
    paths: [],
    disabled: [],
  },
});
