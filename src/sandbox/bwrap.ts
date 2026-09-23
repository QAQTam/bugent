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
  type ShellRunner,
  type ShellRunOptions,
} from "../tools/bash.ts";

export const SANDBOX_BINARY = "bwrap";

export interface SandboxOptions {
  /** 额外可写路径。工作目录总是可写，不用列。 */
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

  if (sandbox.allowNetwork !== true) argv.push("--unshare-net");

  // 顺序要紧：先 tmpfs /tmp，再叠加可写绑定，后挂载的覆盖先挂载的。
  for (const path of sandbox.writablePaths ?? []) {
    argv.push("--bind", path, path);
  }
  argv.push("--bind", options.cwd, options.cwd);
  argv.push("--chdir", options.cwd);
  argv.push("--");
  argv.push(shell, "-lc", options.command);

  return argv;
}

export function createSandboxedShellRunner(
  sandbox: SandboxOptions = {},
  shell = defaultShell(),
): ShellRunner {
  return createProcessRunner((options) => buildSandboxArgv(options, sandbox, shell));
}
