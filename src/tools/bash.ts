/**
 * bash 工具 —— Phase 3。
 *
 * 设计要点：**执行方式与工具本身解耦**。
 *   `ShellRunner` 是唯一知道"命令怎么跑起来"的地方。
 *   Phase 6 的沙箱只要换一个 runner 实现即可，工具代码一行不用改。
 *
 * 为什么默认用管道而不是 PTY：
 *   工具输出最终是喂给模型的，PTY 会掺入 \r\n、ANSI 转义、stdout/stderr 交织，
 *   对 LLM 全是噪声；管道能保持两路输出分离，且行为可预测。
 *   交互式命令（vim、密码提示）本就不该是 agent 工具在 Phase 3 的职责。
 */

import type { JSONSchema } from "../provider/types.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { createOutputSpool, type OutputSpool, type OutputStreamName } from "./spill.ts";
import { sanitizeEnv } from "../sandbox/env.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * 回传给模型的字符上限。
 *
 * 超出就截断，并把**完整输出**流式写到
 * `~/.bugent/output/<session>/<call>.txt`，在结果里给出路径引导模型自己去读。
 * 这样既不撑爆上下文，又不丢信息 —— 模型需要细节时能按需取。
 */
export const MAX_MODEL_OUTPUT_CHARS = 3000;

export interface ShellRunOptions {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  /** 流式回调：边跑边把输出推给 UI（不参与最终结果）。 */
  onProgress?: (chunk: string) => void;
  /**
   * 原始字节流回调：给完整输出落盘用。
   *
   * 与 `onProgress` 不同，它不会在内存截断点停止，stdout/stderr 的每个
   * chunk 都会原样送达；回调应保持同步且尽量轻量，避免阻塞读流。
   */
  onOutputChunk?: (stream: OutputStreamName, chunk: Uint8Array) => void;
  /**
   * 这一次运行是否放开网络（覆盖沙箱配置）。
   *
   * 用于"先跑失败 → 用户批准 → 保持沙箱只放开网络重跑"这条路径：
   * 沙箱本身不拆，只是这一次不加 --unshare-net。
   */
  allowNetwork?: boolean;
}

/**
 * 网络被沙箱挡住时的典型报错。
 *
 * 只在**已经断网**的前提下才用它做判断，所以不必担心误判 ——
 * 真联网时这些错误也会出现，但那时我们压根不会走升权路径。
 */
const NETWORK_FAILURE_PATTERNS: readonly RegExp[] = [
  // 沙箱的 netns 里 loopback 是 down 的，所以连本机也会失败
  /could not connect to server/i,
  /couldn'?t connect/i,
  /failed to connect/i,
  /connection reset by peer/i,
  /network is unreachable/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /no route to host/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
];

export function looksLikeNetworkFailure(text: string): boolean {
  return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 被调用方通过 AbortSignal 取消。 */
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

/** 执行层抽象：默认是本地子进程，Phase 6 会换成 bwrap 沙箱版本。 */
export interface ShellRunner {
  run(options: ShellRunOptions): Promise<ShellResult>;
}

interface CappedText {
  text: string;
  truncated: boolean;
}

/**
 * 读取流并把大小限制在 cap 字节内。
 *
 * 注意：即使已经超限也要**继续消费**流，否则子进程会因为管道写满而卡死，
 * 后续 `await proc.exited` 会永远挂住。
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  streamName: OutputStreamName,
  onChunk?: (text: string) => void,
  onRawOutput?: (stream: OutputStreamName, chunk: Uint8Array) => void,
): Promise<CappedText> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const progressDecoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      // 原始字节先落盘/交给调用方，**不经过内存截断**。
      onRawOutput?.(streamName, value);

      // UI 进度也继续消费完整流；只有给模型的 text 受 cap 限制。
      if (onChunk !== undefined) {
        const progress = progressDecoder.decode(value, { stream: true });
        if (progress.length > 0) onChunk(progress);
      }

      if (truncated) continue;

      if (bytes + value.byteLength > cap) {
        const remaining = Math.max(0, cap - bytes);
        const piece = decoder.decode(value.subarray(0, remaining), { stream: true });
        text += piece;
        truncated = true;
        continue;
      }

      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }

    const tail = decoder.decode();
    if (tail.length > 0) text += tail;

    if (onChunk !== undefined) {
      const progressTail = progressDecoder.decode();
      if (progressTail.length > 0) onChunk(progressTail);
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

function defaultShell(): string {
  return Bun.which("bash") ?? Bun.which("sh") ?? "/bin/sh";
}

/** 由调用方决定实际启动什么进程（本地 shell / bwrap 沙箱 / …）。 */
export type ArgvBuilder = (options: ShellRunOptions) => string[];

export interface ProcessRunnerOptions {
  /**
   * 是否过滤环境变量。默认 **true** —— 子进程默认继承整个 process.env，
   * 意味着 API key 对沙箱内任意命令可读。
   */
  filterEnv?: boolean;
  /** 额外放行的环境变量名（配置里的 `sandbox.pass_env`）。 */
  passEnv?: readonly string[];
}

/**
 * 通用子进程 runner。
 *
 * 沙箱（Phase 6）就是换一个 ArgvBuilder —— 前面加上 bwrap 参数而已，
 * 超时、中断、输出截断这些逻辑完全复用。
 */
export function createProcessRunner(
  buildArgv: ArgvBuilder,
  runnerOptions: ProcessRunnerOptions = {},
): ShellRunner {
  const filter = runnerOptions.filterEnv !== false;

  return {
    async run(options: ShellRunOptions): Promise<ShellResult> {
      const startedAt = Bun.nanoseconds();
      const argv = buildArgv(options);

      // 环境变量过滤：默认只放行白名单里的，其余一律剔除。
      // 不做这一步的话，`curl $OPENAI_API_KEY` 就能把 key 带出沙箱。
      const env = filter
        ? sanitizeEnv(process.env, {
            ...(runnerOptions.passEnv !== undefined ? { allow: runnerOptions.passEnv } : {}),
            ...(options.env !== undefined ? { extra: options.env } : {}),
          }).env
        : { ...process.env, ...(options.env ?? {}) };

      const proc = Bun.spawn(argv, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        proc.kill("SIGKILL");
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const [stdout, stderr] = await Promise.all([
          readCapped(
            proc.stdout as ReadableStream<Uint8Array>,
            options.maxOutputBytes,
            "stdout",
            options.onProgress,
            options.onOutputChunk,
          ),
          readCapped(
            proc.stderr as ReadableStream<Uint8Array>,
            options.maxOutputBytes,
            "stderr",
            options.onProgress,
            options.onOutputChunk,
          ),
        ]);
        const exitCode = await proc.exited;

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          timedOut,
          aborted,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: (Bun.nanoseconds() - startedAt) / 1e6,
        };
      } catch (error) {
        // 读取/落盘失败时不能让子进程继续跑并占着管道。
        proc.kill("SIGKILL");
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 本地子进程 runner（不做文件系统隔离，但**仍然过滤环境变量**）。 */
export function createShellRunner(
  shell = defaultShell(),
  options: ProcessRunnerOptions = {},
): ShellRunner {
  return createProcessRunner((options_) => [shell, "-lc", options_.command], options);
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

export interface BashInput {
  command?: unknown;
  timeoutMs?: unknown;
}

export const BASH_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "要执行的 shell 命令（在项目工作目录下运行）" },
    timeoutMs: {
      type: "number",
      description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
    },
  },
  required: ["command"],
};

export interface BashToolOptions {
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  /**
   * 当前执行层是否处于"断网沙箱"状态。
   * 只有为 true 时才可能在失败后触发联网授权 —— 否则不该去打扰用户。
   */
  networkBlocked?: boolean;
}

function firstLines(text: string, count: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const head = lines.slice(0, count).join(" / ");
  return head.length > 300 ? `${head.slice(0, 300)}…` : head;
}

function formatResult(result: ShellResult, timeoutMs: number, maxOutputBytes: number): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push(`[超时] 命令在 ${timeoutMs}ms 内未结束，已强制终止`);
  } else if (result.aborted) {
    parts.push("[中断] 命令被取消");
  }

  const stdout = result.stdout.replace(/\s+$/, "");
  const stderr = result.stderr.replace(/\s+$/, "");

  if (stdout.length > 0) parts.push(stdout);
  if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr}`);
  if (result.truncated) parts.push(`[输出超过 ${maxOutputBytes} 字节，已截断]`);
  if (parts.length === 0) parts.push("(无输出)");

  parts.push(`[exit code: ${result.exitCode ?? "unknown"}]`);

  return parts.join("\n");
}

/**
 * 超长输出：截断给模型 + 完整版落盘。
 *
 * 头 7 : 尾 3 的分配是有意的 —— bash 的失败原因通常出现在结尾，
 * 只给头部会让模型看不到为什么失败。
 */
async function clampForModel(
  text: string,
  spool: OutputSpool,
  forceSpill = false,
): Promise<string> {
  if (!forceSpill && text.length <= MAX_MODEL_OUTPUT_CHARS) {
    await spool.discard();
    return text;
  }

  const spilled = await spool.promote();
  const pathHint = [
    `[完整输出共 ${spilled.bytes} 字节，已写入：${spilled.path}]`,
    `[需要细节时用 read_file 读取该路径]`,
  ];

  if (text.length <= MAX_MODEL_OUTPUT_CHARS) {
    return [text, "", ...pathHint].join("\n");
  }

  const headBudget = Math.floor(MAX_MODEL_OUTPUT_CHARS * 0.7);
  const tailBudget = MAX_MODEL_OUTPUT_CHARS - headBudget;
  const omitted = text.length - MAX_MODEL_OUTPUT_CHARS;

  return [
    text.slice(0, headBudget),
    "",
    `[... 已省略 ${omitted} 字符 ...]`,
    text.slice(text.length - tailBudget),
    "",
    ...pathHint,
  ].join("\n");
}

export function createBashTool(
  runner: ShellRunner,
  options: BashToolOptions = {},
): Tool<BashInput, string> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "bash",
    description: [
      "在项目工作目录中执行 shell 命令并返回输出。",
      "适合查看文件、搜索代码、运行测试与构建。",
      "命令是非交互式的：不要执行需要用户输入的程序。",
    ].join(" "),
    parameters: BASH_PARAMETERS,
    needsSandbox: true,

    describe(input: unknown): { resource: string; summary: string } {
      const command =
        typeof (input as BashInput | null)?.command === "string"
          ? ((input as BashInput).command as string)
          : "";
      return { resource: command, summary: `执行命令：${command}` };
    },

    async run(input: BashInput, ctx: ToolCtx): Promise<string> {
      const command = input.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("bash: `command` 必须是非空字符串");
      }

      let timeoutMs = defaultTimeoutMs;
      if (input.timeoutMs !== undefined) {
        if (
          typeof input.timeoutMs !== "number" ||
          !Number.isFinite(input.timeoutMs) ||
          input.timeoutMs <= 0
        ) {
          throw new Error("bash: `timeoutMs` 必须是正数");
        }
        timeoutMs = Math.min(input.timeoutMs, MAX_TIMEOUT_MS);
      }

      const runOnce = async (
        allowNetwork?: boolean,
      ): Promise<{ result: ShellResult; spool: OutputSpool }> => {
        const spool = await createOutputSpool(ctx.sessionId, ctx.callId);
        try {
          const result = await runner.run({
            command,
            cwd: ctx.cwd,
            timeoutMs,
            maxOutputBytes,
            signal: ctx.signal,
            ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
            onOutputChunk: (stream, chunk) => spool.write(stream, chunk),
            ...(allowNetwork === true ? { allowNetwork: true } : {}),
          });
          return { result, spool };
        } catch (error) {
          await spool.discard();
          throw error;
        }
      };

      let attempt = await runOnce();
      let result = attempt.result;

      // 先真跑一次；失败且像是被沙箱断网挡住时，**带着真实报错**去要授权。
      //
      // 刻意不做"先行拦截"：那样用户看到的是一句没有上下文的"是否允许联网"，
      // 新手根本不知道自己在批准什么。现在的流程是
      // 「跑 → 失败 → 这是哪条命令、为什么失败、要不要放开这一次」。
      if (
        result.exitCode !== 0 &&
        options.networkBlocked === true &&
        ctx.onRequestCapability !== undefined &&
        looksLikeNetworkFailure(`${result.stdout}\n${result.stderr}`)
      ) {
        const errorText = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim();
        const approved = await ctx.onRequestCapability({
          capability: { network: true },
          reason: "这条命令因为沙箱断网失败了。允许联网后重跑吗？",
          details: [
            `命令：${command}`,
            ...(errorText.length > 0 ? [`报错：${firstLines(errorText, 3)}`] : []),
          ],
        });

        if (approved) {
          // 第一次失败只用于申请授权，最终给模型的应是重跑结果。
          await attempt.spool.discard();
          attempt = await runOnce(true);
          result = attempt.result;
        }
      }

      return clampForModel(
        formatResult(result, timeoutMs, maxOutputBytes),
        attempt.spool,
        result.truncated,
      );
    },
  };
}
