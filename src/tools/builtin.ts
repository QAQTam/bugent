/**
 * 默认工具集装配处。
 *
 * 集中在一处的好处：Phase 6 换沙箱 runner、Phase 7 加文件工具时，
 * 都只改这个文件，CLI / TUI 不需要知道细节。
 */

import { createBashTool, createShellRunner, resolveShell, type ShellRunner } from "./bash.ts";
import { sep } from "node:path";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "./files.ts";
import { createTodoWriteTool } from "./todo.ts";
import { createAskUserTool } from "./ask_user.ts";
import { createAgentTools, type AgentToolsOptions } from "./agent.ts";
import { createApplyPatchTool } from "./apply-patch.ts";
import { ToolRegistry } from "./types.ts";
import type { PermissionRule } from "../permission/policy.ts";
import type { GoalController } from "../goal/controller.ts";
import { MODES, type SandboxMode } from "../permission/mode.ts";
import { createSandboxedShellRunner, isSandboxAvailable } from "../sandbox/bwrap.ts";

export interface DefaultToolsOptions {
  /** 沙箱档位。默认 workspace-write。 */
  mode?: SandboxMode;
  /** 额外可写路径（仅沙箱档位有效）。 */
  writablePaths?: readonly string[];
  /** 额外放行给子进程的环境变量名。 */
  passEnv?: readonly string[];
  /**
   * 沙箱子进程是否允许联网。默认 false。
   *
   * 由 `--allow-network` / `config.sandbox.allowNetwork` 传入。默认的断网不是
   * "禁止联网"，而是**联网授权的触发机制**：先真跑一次失败，再拿真实报错问用户。
   */
  allowNetwork?: boolean;
  /** 直接覆盖执行层（测试用，优先级最高）。 */
  runner?: ShellRunner;
  /** 持久化 session 的 Goal controller；存在时 todo_write 进入 Goal 校验模式。 */
  goalController?: GoalController;
  /** 可选的子代理控制面；由 session runtime 注入 transport 与父身份。 */
  agentTools?: AgentToolsOptions;
}

export interface ToolsSetup {
  registry: ToolRegistry;
  /** 实际生效的档位。 */
  mode: SandboxMode;
  /** 本次注册的子代理工具名。 */
  agentTools: string[];
  sandbox: {
    enabled: boolean;
    /** 状态说明，用于在 TUI/CLI 上如实告知用户。 */
    note: string;
    /**
     * 子进程是否处于"断网沙箱"—— 决定 bash 失败后要不要走联网授权。
     *
     * 暴露出来是为了让"`--allow-network` 到底有没有接上"可被断言：
     * 这个字段曾经整条链路断过（CLI 解析了、没人消费），而单测因为直接
     * 调 `buildSandboxArgv` 而绕过了接线。
     */
    networkBlocked: boolean;
  };
  /**
   * 工具自报的默认权限规则。
   *
   * **组装权限策略时务必带上**，否则"无副作用工具自动放行"就失效了：
   *
   * ```ts
   * new PermissionPolicy(composePolicy(config.permissions, setup.defaultPermissionRules))
   * ```
   */
  defaultPermissionRules: PermissionRule[];
}

export function createDefaultTools(options: DefaultToolsOptions = {}): ToolsSetup {
  const mode = options.mode ?? "workspace-write";
  const caps = MODES[mode];

  // 进程内工具：文件工具靠路径约束 + 档位门控，todo_write 无副作用
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createWriteFileTool())
    .register(createEditFileTool())
    .register(createApplyPatchTool())
    .register(
      createTodoWriteTool(
        options.goalController !== undefined
          ? { goalController: options.goalController }
          : {},
      ),
    )
    .register(createAskUserTool());

  let runner: ShellRunner;
  let enabled: boolean;
  let note: string;
  /** 是否处于"断网沙箱"—— 决定 bash 失败后要不要走联网授权。 */
  let networkBlocked = false;
  /** 执行层没有内核隔离时，bash 需要退到"逐条询问"兜底（见 BashToolOptions）。 */
  let bashNeedsPerRunApproval = false;

  // 档位只决定"要不要问"，不决定"有没有隔离"。所以 bwrap 恒开 ——
  // no-sandbox 的语义是"默认批准一切、不再拦截"，不是"关掉沙箱"。
  const approvesAll = caps.defaultApprove === "all";
  const workspaceWrite = caps.defaultApprove !== "read";

  if (options.runner !== undefined) {
    runner = options.runner;
    enabled = false;
    note = "使用自定义执行层";
  } else if (!isSandboxAvailable()) {
    runner = createShellRunner();
    enabled = false;
    bashNeedsPerRunApproval = true;
    // 说清楚"档位还在、但只是工具层门控"：没有 bwrap 时子进程没有内核级隔离，
    // read-only 档挡得住 write_file，挡不住 bash 里的一条 `echo > file`。
    note = "未找到 bwrap：子进程没有内核级隔离，bash 每条命令都会先请求确认";
  } else {
    // 联网是**按次授权**的：默认断网跑一次，失败后再拿真实报错问用户。
    // `allowNetwork` 为 true 表示用户已经全局授权，此时不再走那条按次路径。
    const networkAllowed = options.allowNetwork === true || approvesAll;
    // defaultApprove === "all" 表示"不再拦截"，于是把整个文件系统叠加成可写。
    // 隔离层本身仍然生效（pid / session / 环境变量白名单 / no_new_privs）。
    const writablePaths = [
      ...(options.writablePaths ?? []),
      ...(approvesAll ? [sep] : []),
    ];
    runner = createSandboxedShellRunner(
      {
        workspaceWrite,
        ...(writablePaths.length > 0 ? { writablePaths } : {}),
        allowNetwork: networkAllowed,
      },
      undefined,
      { ...(options.passEnv !== undefined ? { passEnv: options.passEnv } : {}) },
    );
    enabled = true;
    networkBlocked = !networkAllowed;
    note = `bwrap 沙箱 · ${caps.label}`;
  }

  registry.register(
    createBashTool(runner, {
      networkBlocked,
      workspaceWritable: workspaceWrite,
      // `no-sandbox` 的语义就是"默认批准一切"，那一档不该再弹窗。
      authorizeBeforeRun: !approvesAll,
      // 没有内核沙箱时，"漏判≠放行"的前提消失 —— 退到逐条询问兜底。
      requireApprovalEveryRun: bashNeedsPerRunApproval,
    }),
  );

  // shell 解析的说明（缺 bash 时给出装什么、或 BUGENT_SHELL 指到哪）拼进沙箱说明，
  // 免得用户只看到每条命令都 ENOENT
  const shell = resolveShell();
  if (shell.note !== undefined) note += `；${shell.note}`;

  let agentTools: string[] = [];
  if (options.agentTools !== undefined) {
    const created = createAgentTools({
      ...options.agentTools,
      verificationRunner: options.agentTools.verificationRunner ?? runner,
    });
    for (const tool of created) registry.register(tool);
    agentTools = created.map((tool) => tool.name);
  }

  // 让 needsSandbox 真正生效：明确说出是哪些工具拿不到沙箱，
  // 而不是笼统地降级了事。
  if (!enabled) {
    const exposed = registry.requiresSandbox();
    if (exposed.length > 0) {
      note += `；以下工具将在无沙箱下运行：${exposed.join("、")}`;
    }
  }

  return {
    registry,
    mode,
    agentTools,
    sandbox: { enabled, note, networkBlocked },
    defaultPermissionRules: registry.defaultPermissionRules(),
  };
}
