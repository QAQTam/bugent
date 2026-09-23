/**
 * 工具协议 —— Phase 3 / 6 / 7 共用的地基。
 *
 * 设计要点：**工具本身保持纯净**（只做一件事），权限校验与沙箱包裹在
 * `ToolRegistry.execute` 外层。这样 P3 写完 bash 之后，P6 加沙箱、P7 加文件工具
 * 都不需要回头改工具实现。
 */

import type { JSONSchema, ToolCall, ToolSchema } from "../provider/types.ts";
import {
  denialMessage,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRule,
} from "../permission/policy.ts";

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  callId: string;
  /** 当前会话 id，用于把工具产物按会话分目录。 */
  sessionId: string;
  /**
   * 流式进度回调：长时间运行的工具（如 bash）可以边跑边把输出推给 UI。
   * 这只是展示用，**不参与**最终回传给模型的结果。
   */
  onProgress?: (chunk: string) => void;
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

  /**
   * 执行一次工具调用；任何异常都被转成 ok:false，绝不让 loop 崩掉。
   * 权限检查发生在这里，所以绕过 registry 直接调 tool.run 才会跳过权限 —— 不要那么做。
   */
  async execute(call: ToolCall, ctx: ToolCtx): Promise<ToolExecution> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      const known = this.list().map((t) => t.name).join(", ") || "(空)";
      return { ok: false, output: `未知工具 "${call.name}"，可用：${known}` };
    }

    if (this.#gate !== undefined) {
      const request = describeCall(tool, call);
      const verdict = await this.#gate.check(request);
      if (!verdict.allowed) {
        return { ok: false, output: denialMessage(request, verdict.reason) };
      }
    }

    try {
      const value = await tool.run(call.args, ctx);
      return { ok: true, output: serializeToolOutput(value) };
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }
  }
}
