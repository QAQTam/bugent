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
  buildShellArgv,
  createProcessRunner,
  resolveShell,
  type ProcessRunnerOptions,
  type ShellResolution,
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

/** 沙箱内的 shell 与本地 runner 用同一套解析（含 `BUGENT_SHELL` 覆盖）。 */
function defaultShell(): ShellResolution {
  return resolveShell();
}

export function isSandboxAvailable(binary = SANDBOX_BINARY): boolean {
  return Bun.which(binary) !== null;
}

/** 拼出完整的 bwrap argv。纯函数，便于单测。 */
export function buildSandboxArgv(
  options: ShellRunOptions,
  sandbox: SandboxOptions,
  shell: ShellResolution,
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
    /*
     * /run 必须整段遮掉：它是宿主机 IPC socket 的家（用户 D-Bus、systemd
     * user manager、ssh-agent、gnome-keyring）。connect() 只要求 socket
     * inode 本身的写权限，mount 只读挡不住，--unshare-net 也不管 AF_UNIX ——
     * 不遮的话，沙箱内一条 `systemd-run --user` 就能脱离沙箱在宿主机上
     * 执行任意代码。现代发行版 /var/run -> /run 是符号链接，遮 /run 即
     * 同时遮掉 /var/run（符号链接本身在只读的 / 里，解析后落进新 tmpfs）。
     */
    "--tmpfs",
    "/run",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
  ];

  // 网络：沙箱配置默认断网，但**单次运行**可以覆盖（用户批准后只放开这一次）
  const networkAllowed = options.allowNetwork === true || sandbox.allowNetwork === true;
  if (!networkAllowed) argv.push("--unshare-net");

  // 顺序要紧：先 tmpfs /tmp，再叠加可写绑定，后挂载的覆盖先挂载的。
  //
  // 工作区必须在沙箱里**存在** —— `--chdir` 到一个不存在的目录会直接失败，
  // 而 `/tmp` 已经被换成了私有 tmpfs，工作区落在 `/tmp` 下时就会凭空消失
  // （实测 `bwrap: Can't chdir to /tmp/xxx: No such file or directory`）。
  // 所以这里无条件把工作区绑回来：可写档绑成可写，只读档绑成**只读**
  // （`/` 本来就是只读的，这一步只是把被 tmpfs 遮掉的那份重新露出来）。
  if (sandbox.workspaceWrite !== false) {
    argv.push("--bind", options.cwd, options.cwd);
  } else {
    argv.push("--ro-bind", options.cwd, options.cwd);
  }

  // 配置里的额外可写路径排在基础策略**之后**，这样它才能覆盖基础策略。
  for (const path of sandbox.writablePaths ?? []) {
    argv.push("--bind", path, path);
  }

  // 按次授权：本次调用额外放开那些目录。同样排在基础策略之后 ——
  // read-only 档批准一次写工作区，靠的就是它盖掉上面那条 `--ro-bind`。
  for (const path of options.writablePaths ?? []) {
    argv.push("--bind", path, path);
  }

  argv.push("--chdir", options.cwd);
  argv.push("--");
  argv.push(...buildShellArgv(options.shell ?? shell, options.command));

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
