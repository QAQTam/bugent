/**
 * bubblewrap 沙箱 —— Phase 6 的隔离层。
 *
 * 隔离模型（最小惊讶原则）：
 *   - 根文件系统**只读**挂载：能读、不能写
 *   - 工作目录**可写**（外加配置里显式列出的路径）
 *   - `/tmp` 是私有 tmpfs，退出即销毁
 *   - 默认**断开网络**（--unshare-net）
 *   - 独立 PID namespace + die-with-parent：进程不会泄漏到宿主机
 *
 * 已知取舍：`$HOME` 保持只读，所以依赖写 ~/.cache 的工具会失败。
 * 这是有意的 —— 想放行就在配置里把路径加进 writablePaths。
 */

import {
  createProcessRunner,
  type ProcessRunnerOptions,
  type ShellRunner,
  type ShellRunOptions,
} from "../tools/bash.ts";

export const SANDBOX_BINARY = "bwrap";

export interface SandboxOptions {
  /**
   * 工作区是否可写。
   *
   * 这是 `read-only` 与 `workspace-write` 两档的**唯一区别**：
   * 关掉之后 `sed -i` / `python -c "open(...,'w')"` / `>` 重定向
   * 全都会撞上内核的 Read-only file system，不需要我们去枚举命令。
   */
  workspaceWrite?: boolean;
  /** 额外可写路径。工作目录可写时不用列。 */
  writablePaths?: readonly string[];
  /** 允许联网。默认 false。 */
  allowNetwork?: boolean;
  /** 覆盖 bwrap 可执行文件路径。 */
  binary?: string;
}

function defaultShell(): string {
  return Bun.which("bash") ?? Bun.which("sh") ?? "/bin/sh";
}

export function isSandboxAvailable(binary = SANDBOX_BINARY): boolean {
  return Bun.which(binary) !== null;
}

/** 拼出完整的 bwrap argv。纯函数，便于单测。 */
export function buildSandboxArgv(
  options: ShellRunOptions,
  sandbox: SandboxOptions,
  shell: string,
): string[] {
  const argv: string[] = [
    sandbox.binary ?? SANDBOX_BINARY,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
  ];

  // 网络：沙箱配置默认断网，但**单次运行**可以覆盖（用户批准后只放开这一次）
  const networkAllowed = options.allowNetwork === true || sandbox.allowNetwork === true;
  if (!networkAllowed) argv.push("--unshare-net");

  // 顺序要紧：先 tmpfs /tmp，再叠加可写绑定，后挂载的覆盖先挂载的。
  for (const path of sandbox.writablePaths ?? []) {
    argv.push("--bind", path, path);
  }

  // 关键分档点：workspaceWrite 为 false 时**不**绑可写工作区，
  // 于是整个文件系统（含工作区）都是只读的。
  if (sandbox.workspaceWrite !== false) {
    argv.push("--bind", options.cwd, options.cwd);
  }

  argv.push("--chdir", options.cwd);
  argv.push("--");
  argv.push(shell, "-lc", options.command);

  return argv;
}

export function createSandboxedShellRunner(
  sandbox: SandboxOptions = {},
  shell = defaultShell(),
  runnerOptions: ProcessRunnerOptions = {},
): ShellRunner {
  return createProcessRunner(
    (options) => buildSandboxArgv(options, sandbox, shell),
    runnerOptions,
  );
}
