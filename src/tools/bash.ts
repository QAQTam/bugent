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
import { win32 } from "node:path";
import type { BashPresentation, ToolOutputSegment } from "../core/presentation.ts";
import type { ResourceClaim } from "./locks.ts";
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
  onProgress?: (chunk: string, stream: "stdout" | "stderr") => void;
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
  /** 子进程收到的信号；正常退出为 null。 */
  signalCode?: string | number | null;
  /** Bun.spawn 提供的进程资源用量；平台不支持时可能为 undefined。 */
  resourceUsage?: Bun.ResourceUsage;
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
  onChunk?: (text: string, stream: "stdout" | "stderr") => void,
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
        if (progress.length > 0) onChunk(progress, streamName);
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
      if (progressTail.length > 0) onChunk(progressTail, streamName);
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

export interface ShellResolution {
  /** 起进程用的 shell 可执行文件。 */
  command: string;
  /** 为什么用它、缺什么 —— 会拼进启动横幅里的沙箱说明。 */
  note?: string;
}

/**
 * Windows 自带的 `System32\bash.exe` 是 WSL 的入口，不是普通 POSIX shell：
 * `bash -lc "ls"` 会跑进 WSL，工作目录是 `C:\...`，在那边根本不存在 ——
 * 命令"成功"了但看的是另一套文件系统，错得莫名其妙。这里把它认出来并跳过。
 *
 * 用 `path.win32` 而不是 `path.resolve`：后者绑定运行平台，在 Linux 上测
 * Windows 路径时会把 `C:\...` 当成相对路径拼到 cwd 上，判定必然失败。
 */
function isWslLauncher(path: string, env: Record<string, string | undefined>): boolean {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const stub = win32.resolve(root, "System32", "bash.exe");
  return win32.normalize(path).toLowerCase() === stub.toLowerCase();
}

/**
 * 解析本地 shell。
 *
 * 顺序：`BUGENT_SHELL` 覆盖 → PATH 上的 bash → sh。都没有时**不抛错**，
 * 而是返回一个必然失败的命令并带上说明 —— 抛错会让 bugent 在没有 POSIX
 * shell 的机器上直接起不来，而 read_file / write_file 这些根本不需要 shell。
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  which: (name: string) => string | null = (name) => Bun.which(name),
): ShellResolution {
  const override = env.BUGENT_SHELL;
  if (override !== undefined && override.trim().length > 0) {
    return { command: override.trim(), note: "shell 来自 BUGENT_SHELL" };
  }
  for (const name of ["bash", "sh"]) {
    const found = which(name);
    if (found === null) continue;
    if (platform === "win32" && isWslLauncher(found, env)) continue;
    return { command: found };
  }
  const hint =
    platform === "win32"
      ? "未找到 bash/sh：请安装 Git for Windows，或用 BUGENT_SHELL 指向 bash.exe"
      : "未找到 bash/sh：请安装 bash，或用 BUGENT_SHELL 指定路径";
  return { command: platform === "win32" ? "bash" : "/bin/sh", note: hint };
}

function defaultShell(): string {
  return resolveShell().command;
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

      // 已取消的 signal 不应再启动进程；Bun.spawn 对已 abort 的 signal
      // 会直接抛错，这里显式返回统一的 aborted 结果。
      if (options.signal.aborted) {
        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          aborted: true,
          truncated: false,
          durationMs: 0,
          signalCode: null,
        };
      }

      let exitSignalCode: string | number | null = null;
      const proc = Bun.spawn(argv, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        // 超时与外部取消都交给 Bun：统一用 SIGKILL，避免 shell 捕获信号后
        // 继续留下子进程。读取/落盘失败时仍由下面 catch 兜底 kill。
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        signal: options.signal,
        onExit: (_proc, _exitCode, signalCode) => {
          exitSignalCode = signalCode;
        },
      });

      let timedOut = false;
      let aborted = false;
      // Bun 自己负责 kill；这个 timer 只记录“确实触发了 timeout”，
      // 不能靠 proc.killed 判断（正常退出时它也可能为 true）。
      const timer = setTimeout(() => {
        timedOut = true;
      }, options.timeoutMs);

      const onAbort = (): void => {
        aborted = true;
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) aborted = true;

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

        // resourceUsage 在 exited 之后偶尔要等一个事件循环拍才可见。
        let resourceUsage = proc.resourceUsage();
        if (resourceUsage === undefined) {
          await Bun.sleep(0);
          resourceUsage = proc.resourceUsage();
        }

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          timedOut,
          aborted,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: (Bun.nanoseconds() - startedAt) / 1e6,
          signalCode: exitSignalCode ?? proc.signalCode,
          ...(resourceUsage !== undefined ? { resourceUsage } : {}),
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
    command: { type: "string", description: "Shell command to run in the workspace root." },
    timeoutMs: {
      type: "number",
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
    },
  },
  required: ["command"],
};

/**
 * 能明确证明只读的命令。列表刻意保持保守：不确定的一律按写处理。
 *
 * bash 是不透明执行层，无法可靠知道 python / sed -i / 重定向会改哪些文件，
 * 因此非只读命令统一拿整个 workspace 写锁。这样 `edit_file` 与
 * `python -c "open(...)"` 也会因为资源键重叠而串行。
 */
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "true",
  "false",
  "date",
  "printenv",
  "id",
  "whoami",
  "uname",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "describe",
]);

function commandHead(segment: string): { head: string | undefined; rest: string[] } {
  const words = segment.trim().split(/\s+/).filter((word) => word.length > 0);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  return { head: words[index], rest: words.slice(index + 1) };
}

function isReadOnlySegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.includes(">")) return false;

  const { head, rest } = commandHead(trimmed);
  if (head === undefined) return true;

  if (head === "sed") {
    return !rest.some(
      (word) =>
        word === "--in-place" ||
        word.startsWith("--in-place=") ||
        (word.startsWith("-") && !word.startsWith("--") && word.includes("i")),
    );
  }
  if (head === "find") {
    const mutatingFlags = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf"];
    return !rest.some((word) => mutatingFlags.some((flag) => word === flag || word.startsWith(`${flag}=`)));
  }
  if (head === "git") {
    const subcommand = rest[0];
    if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
    return !rest.some((word) => word.startsWith("--output"));
  }

  return READ_ONLY_COMMANDS.has(head);
}

/** bash 的资源声明；只读命令拿 workspace 读锁，其余拿 workspace 写锁。 */
export function bashResourceClaims(command: string): readonly ResourceClaim[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [{ key: "workspace", access: "write" }];

  // 命令替换、进程替换与重定向都可能写文件或执行任意代码。
  if (
    trimmed.includes("$(") ||
    trimmed.includes("`") ||
    trimmed.includes("<(") ||
    trimmed.includes(">(") ||
    trimmed.includes(">")
  ) {
    return [{ key: "workspace", access: "write" }];
  }

  const segments = trimmed.split(/\|\||&&|;|\|/);
  if (segments.every(isReadOnlySegment)) return [{ key: "workspace", access: "read" }];
  return [{ key: "workspace", access: "write" }];
}

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

/** 生成 TUI 专用的结构化展示信息；模型仍只看到 formatResult 的文本。 */
function buildBashPresentation(
  command: string,
  result: ShellResult,
  timeoutMs: number,
  maxOutputBytes: number,
): BashPresentation {
  const segments: ToolOutputSegment[] = [];

  if (result.timedOut) {
    segments.push({ kind: "meta", text: `[超时] 命令在 ${timeoutMs}ms 内未结束，已强制终止` });
  } else if (result.aborted) {
    segments.push({ kind: "meta", text: "[中断] 命令被取消" });
  }

  const stdout = result.stdout.replace(/\s+$/, "");
  const stderr = result.stderr.replace(/\s+$/, "");
  if (stdout.length > 0) segments.push({ kind: "stdout", text: stdout });
  if (stderr.length > 0) segments.push({ kind: "stderr", text: stderr });
  if (result.truncated) {
    segments.push({ kind: "meta", text: `[输出超过 ${maxOutputBytes} 字节，已截断]` });
  }
  if (segments.length === 0) segments.push({ kind: "meta", text: "(无输出)" });

  return {
    kind: "bash",
    command,
    segments,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
  };
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
    description: "Run a shell command in the workspace and return its output.",
    parameters: BASH_PARAMETERS,
    needsSandbox: true,

    resources(input): readonly ResourceClaim[] {
      const command =
        typeof (input as BashInput | null)?.command === "string"
          ? ((input as BashInput).command as string)
          : "";
      return bashResourceClaims(command);
    },

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

      ctx.onPresentation?.(
        buildBashPresentation(command, result, timeoutMs, maxOutputBytes),
      );

      return clampForModel(
        formatResult(result, timeoutMs, maxOutputBytes),
        attempt.spool,
        result.truncated,
      );
    },
  };
}
