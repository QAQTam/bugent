/**
 * 工具协议 —— Phase 3 / 6 / 7 共用的地基。
 *
 * 设计要点：**工具本身保持纯净**（只做一件事），权限校验与沙箱包裹在
 * `ToolRegistry.execute` 外层。这样 P3 写完 bash 之后，P6 加沙箱、P7 加文件工具
 * 都不需要回头改工具实现。
 */

import type { JSONSchema, ToolCall, ToolSchema } from "../provider/types.ts";
import type { CapabilityGrant, ModeRequirement } from "../permission/mode.ts";
import type { WorkspaceFileEdit } from "../core/workspace.ts";
import type { ToolPresentation } from "../core/presentation.ts";
import type { AskUserAnswer, AskUserQuestion } from "../tui/ask-user.ts";
import type { ResourceClaim } from "./locks.ts";
import { ResourceLockManager } from "./locks.ts";
import {
  denialMessage,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRule,
} from "../permission/policy.ts";

/**
 * 一次性能力授权申请。
 *
 * 关键是 `reason` —— 必须带**真实失败原因**。先拦后问（"是否允许联网？"）
 * 会让用户（尤其是新手）不知道自己在批准什么；先跑一次、失败了再带着
 * 具体命令与报错来问，用户才有判断依据。
 */
export interface CapabilityEscalation {
  capability: CapabilityGrant;
  /** 一句话说明为什么需要（如"这条命令因为沙箱断网失败了"）。 */
  reason: string;
  /** 展示细节：命令、错误片段等。 */
  details?: readonly string[];
}

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  callId: string;
  /** 当前会话 id，用于把工具产物按会话分目录。 */
  sessionId: string;
  /**
   * 流式进度回调：长时间运行的工具（如 bash）可以边跑边把输出推给 UI。
   * 这只是展示用，**不参与**最终回传给模型的结果。
   *
   * 第二个参数区分 stdout / stderr，供 TUI 做语义着色。
   */
  onProgress?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * 请求一次性能力授权（目前只有联网）。返回 true 表示用户批准。
   * 未提供时视为不可申请。
   */
  onRequestCapability?: (escalation: CapabilityEscalation) => Promise<boolean>;
  /**
   * 向用户提问（ask_user 工具用）。
   * 返回 undefined 表示用户中止了回答。
   * 未提供说明当前环境没有交互界面。
   */
  askUser?: (questions: readonly AskUserQuestion[]) => Promise<AskUserAnswer[] | undefined>;
  /**
   * 工具成功修改工作区时报告 before/after。
   *
   * 这不是展示信息，而是 undo 的持久化输入；文件工具必须如实调用。
   * 工具本身不负责落盘，loop 会把结果挂到对应的 tool result 消息上。
   */
  onWorkspaceChange?: (edit: WorkspaceFileEdit) => void;
  /**
   * 工具成功执行后报告结构化展示信息（例如 bash 的 stdout/stderr/exit code）。
   *
   * 这不是模型上下文；loop 只把它交给 UI。
   */
  onPresentation?: (presentation: ToolPresentation) => void;
}

/** 权限闸门接口（实现在 src/permission/gate.ts）。 */
export interface ToolGate {
  check(request: PermissionRequest): Promise<{ allowed: boolean; reason?: string }>;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** 标记为 true 时，P6 的沙箱层会强制包裹执行。 */
  needsSandbox?: boolean;
  /**
   * 工具自报的默认权限。省略则用策略的 default（通常是 ask）。
   *
   * 让工具自己声明而不是在 permission/policy.ts 里硬编码工具名 ——
   * 否则每加一个"无副作用、不该打扰用户"的工具，都要去改权限模块。
   * 声明只是建议：用户的显式规则优先级更高（见 src/index.ts 的策略组装）。
   */
  defaultPermission?: PermissionDecision;
  /**
   * 这个工具需要档位提供什么能力（写工作区 / 联网）。
   *
   * **只有进程内工具需要声明**：它们没有内核兜底，档位必须由闸门来执行。
   * 走沙箱的工具（bash）不用声明 —— read-only 档下它想写也写不动，
   * 内核会把 `sed -i`、`python -c "open(...,'w')"`、`>` 重定向一起挡住。
   */
  requires?: ModeRequirement;
  /**
   * 并发执行时需要占用的资源。
   *
   * 只读工具声明 read；会修改工作区的工具声明 write。路径型资源用
   * `workspace/<relative-path>`，无法静态判断修改目标的命令用 `workspace`。
   * 未声明时，写工具 / 沙箱工具会保守地拿整个 workspace 写锁。
   */
  resources?(input: unknown, ctx: ToolCtx): readonly ResourceClaim[];
  run(input: I, ctx: ToolCtx): Promise<O>;
  /**
   * 告诉权限系统"这次调用动的是什么资源"。
   *
   * **必填**（不是可选的）：漏了它，用户配的 `{tool, resource}` 规则就永远匹配不上，
   * 权限判断会静默退化。加工具的人必须回答"这次动的是什么"。
   * bash 返回整条命令，文件工具返回路径，todo_write 返回条目数。
   */
  describe(input: unknown): { resource: string; summary: string };
}

export interface ToolExecution {
  ok: boolean;
  output: string;
  /** 本次调用成功修改的工作区文件；只用于 undo，不喂给模型。 */
  workspace?: readonly WorkspaceFileEdit[];
  /** 本次调用的结构化展示信息；只用于 UI，不喂给模型。 */
  presentation?: ToolPresentation;
}

export function toToolSchema(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** 工具返回值 -> 喂回模型的字符串。 */
export function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把一次调用翻译成权限系统能理解的形式。 */
export function describeCall(tool: Tool, call: ToolCall): PermissionRequest {
  const described = tool.describe(call.args);
  return { tool: tool.name, resource: described.resource, summary: described.summary };
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();
  #gate: ToolGate | undefined;
  #locks = new ResourceLockManager();

  constructor(gate?: ToolGate) {
    this.#gate = gate;
  }

  setGate(gate: ToolGate | undefined): this {
    this.#gate = gate;
    return this;
  }

  register(tool: Tool): this {
    this.#tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map(toToolSchema);
  }

  /**
   * 声明需要沙箱的工具名。
   *
   * 存在的意义：让 `needsSandbox` 不再是一句空话 —— 组装时如果发现
   * 这些工具拿不到沙箱，就能明确告诉用户"是哪些工具在裸奔"。
   */
  requiresSandbox(): string[] {
    return this.list()
      .filter((tool) => tool.needsSandbox === true)
      .map((tool) => tool.name);
  }

  /** 收集工具自报的默认权限规则。 */
  defaultPermissionRules(): PermissionRule[] {
    return this.list().flatMap((tool) =>
      tool.defaultPermission === undefined
        ? []
        : [{ tool: tool.name, decision: tool.defaultPermission }],
    );
  }

  /** 工具未声明资源时的保守兜底：写工具 / 沙箱工具独占整个 workspace。 */
  #resourceClaims(tool: Tool, input: unknown, ctx: ToolCtx): readonly ResourceClaim[] {
    const declared = tool.resources?.(input, ctx);
    if (declared !== undefined && declared.length > 0) return declared;
    if (tool.requires?.write === true || tool.needsSandbox === true) {
      return [{ key: "workspace", access: "write" }];
    }
    return [];
  }

  /**
   * 执行一次工具调用；任何异常都被转成 ok:false，绝不让 loop 崩掉。
   * 权限检查发生在这里，所以绕过 registry 直接调 tool.run 才会跳过权限 —— 不要那么做。
   *
   * 资源锁覆盖 `tool.run`：权限确认不占文件锁，避免一个等待用户确认的弹窗
   * 卡住所有同文件工具。
   */
  async execute(call: ToolCall, ctx: ToolCtx): Promise<ToolExecution> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      const known = this.list().map((t) => t.name).join(", ") || "(空)";
      return { ok: false, output: `未知工具 "${call.name}"，可用：${known}` };
    }

    let claims: readonly ResourceClaim[];
    try {
      claims = this.#resourceClaims(tool, call.args, ctx);
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }

    // 锁必须在权限确认前、且按调用顺序申请：
    //   1. 同一文件的工具即使弹窗耗时不同，也保持确定的执行顺序；
    //   2. 后续 undo 按 call 顺序回滚时，与实际写入顺序一致。
    let release: () => void;
    try {
      release = await this.#locks.acquire(claims, ctx.signal);
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }

    try {
      if (this.#gate !== undefined) {
        const request = describeCall(tool, call);
        const verdict = await this.#gate.check(request);
        if (!verdict.allowed) {
          return { ok: false, output: denialMessage(request, verdict.reason) };
        }
      }

      if (ctx.signal.aborted) {
        return { ok: false, output: "工具执行已取消" };
      }
      const workspace: WorkspaceFileEdit[] = [];
      let presentation: ToolPresentation | undefined;
      const previousWorkspaceChange = ctx.onWorkspaceChange;
      const previousPresentation = ctx.onPresentation;
      const executionCtx: ToolCtx = {
        ...ctx,
        onWorkspaceChange: (edit) => {
          workspace.push(edit);
          previousWorkspaceChange?.(edit);
        },
        onPresentation: (value) => {
          presentation = value;
          previousPresentation?.(value);
        },
      };
      const value = await tool.run(call.args, executionCtx);
      return {
        ok: true,
        output: serializeToolOutput(value),
        ...(workspace.length > 0 ? { workspace } : {}),
        ...(presentation !== undefined ? { presentation } : {}),
      };
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    } finally {
      release();
    }
  }
}
