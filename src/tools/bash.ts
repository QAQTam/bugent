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
import { homedir } from "node:os";
import { win32 } from "node:path";
import { statSync } from "node:fs";
import type { BashPresentation, ToolOutputSegment } from "../core/presentation.ts";
import type { ResourceClaim } from "./locks.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { createOutputSpool, type OutputSpool, type OutputStreamName } from "./spill.ts";
import { sanitizeEnv } from "../sandbox/env.ts";
import { planWriteApproval, scanCommand, type WriteApprovalPlan } from "../sandbox/command-scan.ts";
import {
  AUTHORIZATION_DENIED,
  describeOutcome,
  type AuthorizationOutcome,
} from "../permission/authorization.ts";

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

/** 本次运行使用的 shell 覆盖（per-call `shell` 参数解析结果）。 */
export interface ShellRunOptions {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  /** per-call 指定的 shell；缺省用 runner 构造时的默认解析。 */
  shell?: ShellResolution;
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
  /**
   * 这一次运行额外可写的路径（覆盖沙箱配置）。
   *
   * 对应"执行前判定出越界 → 用户批准 → 本次 argv 真的放开"这条路径：
   * 沙箱不拆，只是这一次把批准过的目录 `--bind` 成可写。
   *
   * 只对 `createSandboxedShellRunner` 有意义；本地 runner 忽略它。
   */
  writablePaths?: readonly string[];
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

      if (truncated) {
        // 截断后继续喂解码器（丢弃输出）：保持多字节字符的内部状态同步，
        // 否则结尾 flush 会把跨截断点的 UTF-8 序列吐成 U+FFFD 乱码。
        decoder.decode(value, { stream: true });
        continue;
      }

      if (bytes + value.byteLength > cap) {
        const remaining = Math.max(0, cap - bytes);
        // 截断点按字节切、流式解码：不完整序列留在解码器状态里，
        // 由后续 chunk（或结尾 flush）接管，文本不会以半个字符收尾。
        const piece = decoder.decode(value.subarray(0, remaining), { stream: true });
        text += piece;
        truncated = true;
        decoder.decode(value.subarray(remaining), { stream: true });
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
  /**
   * shell 家族。决定 argv 模式（见 buildShellArgv），刻意**不进工具描述**：
   * 模型第一次跑错语法、从报错里自己认出 exec 用的是什么 shell（"碰壁学习"）。
   * powershell 5.1 与 pwsh 共用 "pwsh"（两者都支持 -EncodedCommand）。
   */
  kind: "posix" | "pwsh" | "cmd";
  /** 为什么用它、缺什么 —— 会拼进启动横幅里的沙箱说明。 */
  note?: string;
}

export function psEncode(command: string): string {
  const utf16le: number[] = [];
  for (let i = 0; i < command.length; i += 1) {
    const code = command.charCodeAt(i);
    utf16le.push(code & 0xff, (code >> 8) & 0xff);
  }
  return Buffer.from(utf16le).toString("base64");
}

/**
 * 按 shell 家族派生 argv。
 *
 * `-lc` 只对 POSIX 壳成立；pwsh/PowerShell 用 `-EncodedCommand`（UTF-16LE
 * base64）字节级保真地传命令，绕开 CreateProcess 与 PowerShell 双重引号
 * 剥离的 quoting 地狱；cmd 用 `/d /s /c`（/d 跳过 AutoRun，/s 规整引号）。
 */
export function buildShellArgv(shell: ShellResolution, command: string): string[] {
  switch (shell.kind) {
    case "pwsh":
      return [
        shell.command,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-InputFormat",
        "Text",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        psEncode(command),
      ];
    case "cmd":
      return [shell.command, "/d", "/s", "/c", command];
    default:
      return [shell.command, "-lc", command];
  }
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

/** BUGENT_SHELL 指到的壳按名字认家族，决定 argv 模式。 */
function shellKindByName(path: string): ShellResolution["kind"] {
  const name = win32.basename(path).toLowerCase();
  if (name.startsWith("pwsh") || name.startsWith("powershell")) return "pwsh";
  if (name === "cmd" || name.startsWith("cmd.exe")) return "cmd";
  return "posix";
}

/**
 * 解析本地 shell。
 *
 * Windows 链：`pwsh 7 → powershell 5.1 → bash(Git for Windows) → cmd`。
 * pwsh 的 MSIX 商店别名是 0 字节的 reparse point，"which 找到了"≠"能跑"，
 * 所以候选一律用 stat 体积筛过（0 字节 ⇒ 跳过）。
 *
 * POSIX 链：`BUGENT_SHELL` 覆盖 → PATH 上的 bash → sh。都没有时**不抛错**，
 * 而是返回一个必然失败的命令并带上说明 —— 抛错会让 bugent 在没有 shell 的
 * 机器上直接起不来，而 read_file / write_file 这些根本不需要 shell。
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  which: (name: string) => string | null = (name) => Bun.which(name),
  fileSize: (path: string) => number | null = (path) => {
    try {
      const size = statSync(path, { throwIfNoEntry: false })?.size;
      return size === undefined ? null : size;
    } catch {
      return null;
    }
  },
): ShellResolution {
  const override = env.BUGENT_SHELL;
  if (override !== undefined && override.trim().length > 0) {
    const command = override.trim();
    return { command, kind: shellKindByName(command), note: "shell 来自 BUGENT_SHELL" };
  }

  const alive = (path: string): boolean => (fileSize(path) ?? 0) > 0;

  if (platform === "win32") {
    // pwsh 7：PATH 命中（MSI / scoop / choco shim）+ 显式落点兜底。
    // 0 字节 ⇒ MSIX 应用执行别名（用户可在设置里关掉），跳过。
    const pwshCandidates = [
      which("pwsh"),
      win32.resolve(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      win32.resolve(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7-preview", "pwsh.exe"),
      env["ProgramFiles(x86)"] === undefined
        ? null
        : win32.resolve(env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe"),
      env.LOCALAPPDATA === undefined
        ? null
        : win32.resolve(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"),
    ];
    for (const candidate of pwshCandidates) {
      if (candidate !== null && alive(candidate)) return { command: candidate, kind: "pwsh" };
    }

    // powershell 5.1：路径确定，PS 2.0 起就支持 -EncodedCommand。
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const powershell51 = win32.resolve(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (alive(powershell51)) return { command: powershell51, kind: "pwsh" };

    // bash（Git for Windows / MSYS2）：跳过 System32 的 WSL 启动器。
    for (const name of ["bash", "sh"]) {
      const found = which(name);
      if (found === null) continue;
      if (isWslLauncher(found, env)) continue;
      return { command: found, kind: "posix" };
    }

    // cmd：System32 恒在，解析链的确定性兜底。
    const cmd = win32.resolve(systemRoot, "System32", "cmd.exe");
    if (alive(cmd)) return { command: cmd, kind: "cmd" };
    return { command: "cmd", kind: "cmd", note: "未找到 cmd.exe：子进程大概率无法启动" };
  }

  for (const name of ["bash", "sh"]) {
    const found = which(name);
    if (found === null) continue;
    return { command: found, kind: "posix" };
  }
  const hint = "未找到 bash/sh：请安装 bash，或用 BUGENT_SHELL 指定路径";
  return { command: "/bin/sh", kind: "posix", note: hint };
}

/**
 * per-call `shell` 参数的解析：接受已知 shell 名或绝对/相对路径。
 *
 * 未知名字直接报错（不静默猜），模型能从报错里学到可选值；
 * 路径形式按可执行名认家族，找不到文件也直接报错 —— 又是一面墙。
 */
export function resolveShellByName(
  name: string,
  env: Record<string, string | undefined> = process.env,
  which: (name: string) => string | null = (candidate) => Bun.which(candidate),
  fileSize: (path: string) => number | null = (path) => {
    try {
      const size = statSync(path, { throwIfNoEntry: false })?.size;
      return size === undefined ? null : size;
    } catch {
      return null;
    }
  },
): ShellResolution {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("`shell` must not be empty");

  if (/[\\/]/.test(trimmed)) {
    if ((fileSize(trimmed) ?? 0) <= 0) throw new Error(`shell not found: ${trimmed}`);
    return { command: trimmed, kind: shellKindByName(trimmed) };
  }

  const base = trimmed.toLowerCase().replace(/\.exe$/u, "");
  const alive = (path: string): boolean => (fileSize(path) ?? 0) > 0;

  if (base === "pwsh" || base === "powershell") {
    if (base === "pwsh") {
      const found = which("pwsh");
      if (found !== null && alive(found)) return { command: found, kind: "pwsh" };
      const programFiles = env.ProgramFiles ?? "C:\\Program Files";
      for (const candidate of [
        win32.resolve(programFiles, "PowerShell", "7", "pwsh.exe"),
        win32.resolve(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
      ]) {
        if (alive(candidate)) return { command: candidate, kind: "pwsh" };
      }
    } else {
      const found = which("powershell");
      if (found !== null && alive(found)) return { command: found, kind: "pwsh" };
    }
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const windowsPowerShell = win32.resolve(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (alive(windowsPowerShell)) return { command: windowsPowerShell, kind: "pwsh" };
    throw new Error(`shell not found: ${trimmed}`);
  }

  if (base === "cmd") {
    const found = which("cmd");
    if (found !== null && alive(found)) return { command: found, kind: "cmd" };
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const cmd = win32.resolve(systemRoot, "System32", "cmd.exe");
    if (alive(cmd)) return { command: cmd, kind: "cmd" };
    throw new Error(`shell not found: ${trimmed}`);
  }

  if (base === "bash" || base === "zsh" || base === "sh") {
    const found = which(base);
    if (found !== null && !(base === "bash" && isWslLauncher(found, env))) {
      return { command: found, kind: "posix" };
    }
    throw new Error(`shell not found: ${trimmed}`);
  }

  throw new Error(
    `unknown shell: ${trimmed} (known names: bash, zsh, sh, pwsh, powershell, cmd, or a shell executable path)`,
  );
}

function defaultShell(): ShellResolution {
  return resolveShell();
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
  shell: ShellResolution = defaultShell(),
  options: ProcessRunnerOptions = {},
): ShellRunner {
  return createProcessRunner(
    (options_) => buildShellArgv(options_.shell ?? shell, options_.command),
    options,
  );
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

/** exec 工具名。历史上叫 `bash`，改名为平台中立的 `exec`。 */
export const EXEC_TOOL_NAME = "exec";

export interface ExecInput {
  command?: unknown;
  /** 可选：shell 名（bash/zsh/sh/pwsh/powershell/cmd）或可执行文件路径。 */
  shell?: unknown;
  timeoutMs?: unknown;
}

/** 兼容别名：改名前的接口/参数名仍然可用。 */
export type BashInput = ExecInput;

export const EXEC_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Command to run in the workspace root." },
    shell: { type: "string", description: "Optional. Shell name or executable path." },
    timeoutMs: {
      type: "number",
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
    },
  },
  required: ["command"],
};

export const BASH_PARAMETERS = EXEC_PARAMETERS;

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
    const inPlace = rest.some(
      (word) =>
        word === "--in-place" ||
        word.startsWith("--in-place=") ||
        (word.startsWith("-") && !word.startsWith("--") && word.includes("i")),
    );
    if (inPlace) return false;
    // sed 脚本体内的 w/W（把模式空间写入文件）/r/R（读文件并入输出）是命令体
    // 内的写原语：`sed 's/a/b/w out.txt' f` 不带 -i 也确实落盘，持读锁会和
    // 并发 edit_file 丢更新。引号已被上面的空格切分打散，松散匹配整个片段；
    // 刻意不要求词首边界（`5w out` 是合法的 sed 写法）。宁可误判成写
    // （串行化），也不漏判。
    const scriptWrites = rest.some((word) => /(^|[^\\])[wWrR](\s|$)/.test(word));
    return !scriptWrites;
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

  const segments = trimmed.split(/\|\||&&|;|\||\n|\r/);
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
  /**
   * 当前档位下工作区是否可写。
   *
   * `false`（read-only 档）时，连"写工作区内"都要按次批准 —— 否则那条路径
   * 只会撞上内核的 `Read-only file system`，用户连申请的机会都没有。
   * 默认 true（缺省视为工作区可写），保持老调用点的行为。
   */
  workspaceWritable?: boolean;
  /**
   * 执行前是否要先问用户。
   *
   * `no-sandbox` 档的语义是"默认批准一切、不再拦截"，那一档不该弹窗 ——
   * 档位就是用户的预先授权。默认 true；只有 `no-sandbox` 传 false。
   */
  authorizeBeforeRun?: boolean;
  /**
   * 没有内核级沙箱（bwrap 缺失）时置 true：**每条**命令执行前都请求确认。
   *
   * 背景：扫描层的"漏判不等于放行"依赖内核兜底（EROFS）；执行层退化为
   * 裸子进程时这个前提消失，任何扫描漏判都会变成无提示的真实写/联网。
   * 所以此时把安全边界整体退到"逐条询问"。`no-sandbox` 档（用户预授权
   * 一切）不受影响 —— 那是用户主动选的。
   */
  requireApprovalEveryRun?: boolean;
}

function firstLines(text: string, count: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const head = lines.slice(0, count).join(" / ");
  return head.length > 300 ? `${head.slice(0, 300)}…` : head;
}

/** 本次调用获准的越界能力（执行前按次授权的结果）。 */
export interface RunGrant {
  allowNetwork?: boolean;
  writablePaths?: readonly string[];
}

/** 执行前授权被拒时回给模型的文本。拒绝与超时必须能区分。 */
function refusalText(outcome: AuthorizationOutcome, command: string): string {
  const head = describeOutcome(outcome) ?? AUTHORIZATION_DENIED;
  return `${head}：exec 未执行这条命令 —— ${command}`;
}

function escalationReasonFor(plan: WriteApprovalPlan | undefined, needsNetwork: boolean): string {
  if (plan !== undefined && needsNetwork) {
    return "这条命令会写工作区之外的文件，并且需要联网。";
  }
  if (needsNetwork) return "这条命令需要联网。";
  if (plan?.undecidable === true && plan.paths.length === 0) {
    return "这条命令可能在写文件，但目标静态判不出来。";
  }
  return "这条命令会写工作区之外的文件。";
}

/**
 * 弹窗里必须写清"批准后到底放开了什么"。
 *
 * 只说"是否允许"是不够的：授权是按次下发的，用户得知道这一次的范围
 * 是某一个文件、还是整个目录。
 */
function escalationDetailsFor(
  command: string,
  plan: WriteApprovalPlan | undefined,
): string[] {
  const details = [`命令：${command}`];
  if (plan === undefined) return details;
  if (plan.paths.length > 0) details.push(`目标：${plan.paths.join("、")}`);
  if (plan.binds.length > 0) {
    details.push(`批准后将放开：${plan.binds.join("、")}（含其中任意文件）`);
  }
  if (plan.undecidable && plan.binds.length === 0) {
    details.push("目标判不出来（解释器 / 动态路径）：批准只表示允许执行，写工作区外仍会被沙箱挡住");
  }
  return details;
}

function formatResult(result: ShellResult, timeoutMs: number, maxOutputBytes: number): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push(`[timeout] command did not finish within ${timeoutMs}ms and was killed`);
  } else if (result.aborted) {
    parts.push("[aborted] command was cancelled");
  }

  const stdout = result.stdout.replace(/\s+$/, "");
  const stderr = result.stderr.replace(/\s+$/, "");

  if (stdout.length > 0) parts.push(stdout);
  if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr}`);
  if (result.truncated) parts.push(`[output exceeded ${maxOutputBytes} bytes and was truncated]`);
  if (parts.length === 0) parts.push("(no output)");

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
    segments.push({ kind: "meta", text: `[timeout] command did not finish within ${timeoutMs}ms and was killed` });
  } else if (result.aborted) {
    segments.push({ kind: "meta", text: "[aborted] command was cancelled" });
  }

  const stdout = result.stdout.replace(/\s+$/, "");
  const stderr = result.stderr.replace(/\s+$/, "");
  if (stdout.length > 0) segments.push({ kind: "stdout", text: stdout });
  if (stderr.length > 0) segments.push({ kind: "stderr", text: stderr });
  if (result.truncated) {
    segments.push({ kind: "meta", text: `[output exceeded ${maxOutputBytes} bytes and was truncated]` });
  }
  if (segments.length === 0) segments.push({ kind: "meta", text: "(no output)" });

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
    `[full output is ${spilled.bytes} bytes, written to: ${spilled.path}]`,
    `[use read_file on that path when you need the details]`,
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
    `[... truncated: ${omitted} characters omitted. Narrow the command (head/tail/grep) or read the full output path below.]`,
    text.slice(text.length - tailBudget),
    "",
    ...pathHint,
  ].join("\n");
}

/** authorizeExecRun 的选项：与 BashToolOptions 中"执行前授权"相关的字段同名。 */
export interface ExecAuthorizationOptions {
  workspaceWritable?: boolean | undefined;
  authorizeBeforeRun?: boolean | undefined;
  requireApprovalEveryRun?: boolean | undefined;
  networkBlocked?: boolean | undefined;
}

export interface ExecAuthorization {
  /** 拒绝/超时的结论；undefined = 放行。 */
  refused?: AuthorizationOutcome;
  /** 本次获准的越界能力（联网 / 可写目录），执行时必须原样带上。 */
  grant: RunGrant;
}

/**
 * exec 的执行前授权链（无沙箱逐条确认 → 静态扫描越界/联网 → 按次授权）。
 *
 * 从 createBashTool.run 抽出来，供"换了个工具入口、危险程度相同"的命令执行
 * 复用 —— apply_subagent_patch 的 verify_commands 走这里，保证同一条授权链
 * 不会因为入口不同而被绕开。
 *
 * **不含**用户显式规则（deny/ask）那层：它由闸门在 registry.execute 里对
 * `exec` 工具判定。需要同款规则判定的调用方（工具内部想以 exec 语义再过一道）
 * 应通过 `ToolCtx.authorizeAs` 走闸门，不要在这里复制规则匹配。
 */
export async function authorizeExecRun(
  command: string,
  ctx: ToolCtx,
  options: ExecAuthorizationOptions,
): Promise<ExecAuthorization> {
  // 先静态扫描，再决定问什么：无沙箱逐条确认与越界/联网升权合并成
  // **一次**询问 —— 同一条命令先弹"无隔离"再弹"越界"两次，只会把用户
  // 训练成无脑点允许。合并后一次说清两件事。
  const scan = scanCommand(command, { cwd: ctx.cwd });
  const plan = planWriteApproval(scan, {
    cwd: ctx.cwd,
    home: homedir(),
    workspaceWritable: options.workspaceWritable !== false,
    command,
  });
  const needsNetwork = scan.network && options.networkBlocked === true;
  const needsEscalation = plan !== undefined || needsNetwork;

  const perRunConfirmation =
    options.requireApprovalEveryRun === true && options.authorizeBeforeRun !== false;

  if (ctx.onRequestCapability === undefined) return { grant: {} };

  if (perRunConfirmation && !needsEscalation) {
    const outcome = await ctx.onRequestCapability({
      capability: {},
      reason: "当前没有可用的内核级沙箱（未找到 bwrap），这条命令将在无隔离的情况下直接执行。",
      details: [`命令：${command}`],
    });
    if (outcome !== "approved") return { refused: outcome, grant: {} };
    return { grant: {} };
  }

  if (needsEscalation && options.authorizeBeforeRun !== false) {
    const noSandboxNote = perRunConfirmation
      ? "当前没有可用的内核级沙箱（未找到 bwrap），这条命令将在无隔离的情况下直接执行。"
      : undefined;
    const reason = escalationReasonFor(plan, needsNetwork);
    const outcome = await ctx.onRequestCapability({
      capability: {
        ...(plan !== undefined ? { writeOutside: true } : {}),
        ...(needsNetwork ? { network: true } : {}),
      },
      reason: noSandboxNote === undefined ? reason : `${noSandboxNote}${reason}`,
      details: escalationDetailsFor(command, plan),
    });
    if (outcome !== "approved") return { refused: outcome, grant: {} };
    return {
      grant: {
        ...(needsNetwork ? { allowNetwork: true } : {}),
        ...(plan !== undefined && plan.binds.length > 0 ? { writablePaths: plan.binds } : {}),
      },
    };
  }

  return { grant: {} };
}

export function createBashTool(
  runner: ShellRunner,
  options: BashToolOptions = {},
): Tool<BashInput, string> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: EXEC_TOOL_NAME,
    description: "Run a shell command in the workspace and return its output.",
    parameters: EXEC_PARAMETERS,
    needsSandbox: true,

    resources(input): readonly ResourceClaim[] {
      const command =
        typeof (input as ExecInput | null)?.command === "string"
          ? ((input as ExecInput).command as string)
          : "";
      return bashResourceClaims(command);
    },

    describe(input: unknown): { resource: string; summary: string } {
      const command =
        typeof (input as ExecInput | null)?.command === "string"
          ? ((input as ExecInput).command as string)
          : "";
      return { resource: command, summary: `执行命令：${command}` };
    },

    async run(input: ExecInput, ctx: ToolCtx): Promise<string> {
      const command = input.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("exec: `command` must be a non-empty string");
      }

      // per-call `shell`：env/config 钉死时明确拒绝（用户意图不该被模型覆盖），
      // 否则按名字/路径解析 —— 解析失败本身也是一面墙。
      let shellOverride: ShellResolution | undefined;
      if (input.shell !== undefined) {
        if (typeof input.shell !== "string") {
          throw new Error("exec: `shell` must be a string");
        }
        const pinned = process.env.BUGENT_SHELL;
        if (pinned !== undefined && pinned.trim().length > 0) {
          throw new Error("exec: the shell is pinned via BUGENT_SHELL; per-call `shell` is disabled");
        }
        shellOverride = resolveShellByName(input.shell);
      }

      let timeoutMs = defaultTimeoutMs;
      if (input.timeoutMs !== undefined) {
        if (
          typeof input.timeoutMs !== "number" ||
          !Number.isFinite(input.timeoutMs) ||
          input.timeoutMs <= 0
        ) {
          throw new Error("exec: `timeoutMs` must be a positive number");
        }
        timeoutMs = Math.min(input.timeoutMs, MAX_TIMEOUT_MS);
      }

      const runOnce = async (grant: RunGrant = {}): Promise<{ result: ShellResult; spool: OutputSpool }> => {
        const spool = await createOutputSpool(ctx.sessionId, ctx.callId);
        try {
          const result = await runner.run({
            command,
            cwd: ctx.cwd,
            timeoutMs,
            maxOutputBytes,
            signal: ctx.signal,
            ...(shellOverride !== undefined ? { shell: shellOverride } : {}),
            ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
            onOutputChunk: (stream, chunk) => spool.write(stream, chunk),
            ...(grant.allowNetwork === true ? { allowNetwork: true } : {}),
            ...(grant.writablePaths !== undefined ? { writablePaths: grant.writablePaths } : {}),
          });
          return { result, spool };
        } catch (error) {
          await spool.discard();
          throw error;
        }
      };

      // 执行前授权链与 apply_subagent_patch 的验证命令共用（见 authorizeExecRun）。
      const auth = await authorizeExecRun(command, ctx, {
        workspaceWritable: options.workspaceWritable,
        authorizeBeforeRun: options.authorizeBeforeRun,
        requireApprovalEveryRun: options.requireApprovalEveryRun,
        networkBlocked: options.networkBlocked,
      });
      if (auth.refused !== undefined) return refusalText(auth.refused, command);
      let grant: RunGrant = auth.grant;

      let attempt = await runOnce(grant);
      let result = attempt.result;

      // 联网兜底：静态没识别出来、跑起来才被沙箱断网挡住时，**带着真实报错**
      // 去要授权。刻意不做"先行拦截"的那部分由上面的 scan 覆盖；这里保底。
      // grant.allowNetwork 已置位（静态识别出联网获批，或本次兜底已批准过）
      // 时跳过 —— 重跑仍失败就如实回传，不再弹第二次同语义的网络授权。
      if (
        result.exitCode !== 0 &&
        options.networkBlocked === true &&
        grant.allowNetwork !== true &&
        ctx.onRequestCapability !== undefined &&
        looksLikeNetworkFailure(`${result.stdout}\n${result.stderr}`)
      ) {
        const errorText = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim();
        const outcome = await ctx.onRequestCapability({
          capability: { network: true },
          // BUG-009：报错摘录来自命令自身的输出 —— 模型可以伪造它来提高
          // 获批概率。文案必须如实说明这一点；批准的对象是"完整命令带网
          // 重跑一次"，重跑本身已天然最多一次。
          reason:
            "这条命令在断网沙箱中失败（沙箱确实断网，由配置决定）。是否允许带网重跑一次？",
          details: [
            `命令：${command}`,
            `退出码：${result.exitCode ?? "unknown"}`,
            ...(errorText.length > 0
              ? [`报错摘录（来自命令自身输出，不保证真实）：${firstLines(errorText, 3)}`]
              : []),
          ],
        });

        if (outcome !== "approved") {
          // 第一次失败只用于申请授权；用户没批准就把否定结论如实回传，
          // 不能让模型以为"重跑也没用"是别的原因。
          await attempt.spool.discard();
          ctx.onPresentation?.(buildBashPresentation(command, result, timeoutMs, maxOutputBytes));
          return refusalText(outcome, command);
        }

        // 最终给模型的应是重跑结果，不是那次失败的。grant 记下"网络本次已放行"，
        // 重跑再失败直接回传，不再触发第二次网络授权（幂等）。
        await attempt.spool.discard();
        grant = { ...grant, allowNetwork: true };
        attempt = await runOnce(grant);
        result = attempt.result;
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
