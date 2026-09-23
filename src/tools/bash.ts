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

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ShellRunOptions {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
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
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<CappedText> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      if (truncated) continue; // 已经截断，只负责排空

      if (bytes + value.byteLength > cap) {
        const remaining = Math.max(0, cap - bytes);
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        continue;
      }

      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
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

/**
 * 通用子进程 runner。
 *
 * 沙箱（Phase 6）就是换一个 ArgvBuilder —— 前面加上 bwrap 参数而已，
 * 超时、中断、输出截断这些逻辑完全复用。
 */
export function createProcessRunner(buildArgv: ArgvBuilder): ShellRunner {
  return {
    async run(options: ShellRunOptions): Promise<ShellResult> {
      const startedAt = Bun.nanoseconds();
      const argv = buildArgv(options);

      const proc = Bun.spawn(argv, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(options.env ?? {}) },
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
          readCapped(proc.stdout as ReadableStream<Uint8Array>, options.maxOutputBytes),
          readCapped(proc.stderr as ReadableStream<Uint8Array>, options.maxOutputBytes),
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
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 本地子进程 runner（默认实现，不做任何隔离）。 */
export function createShellRunner(shell = defaultShell()): ShellRunner {
  return createProcessRunner((options) => [shell, "-lc", options.command]);
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

      const result = await runner.run({
        command,
        cwd: ctx.cwd,
        timeoutMs,
        maxOutputBytes,
        signal: ctx.signal,
      });

      return formatResult(result, timeoutMs, maxOutputBytes);
    },
  };
}
