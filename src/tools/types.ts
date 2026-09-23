/**
 * 工具协议 —— Phase 3 / 6 / 7 共用的地基。
 *
 * 设计要点：**工具本身保持纯净**（只做一件事），权限校验与沙箱包裹在
 * `ToolRegistry.execute` 外层。这样 P3 写完 bash 之后，P6 加沙箱、P7 加文件工具
 * 都不需要回头改工具实现。
 */

import type { JSONSchema, ToolCall, ToolSchema } from "../provider/types.ts";
import { denialMessage, type PermissionRequest } from "../permission/policy.ts";

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  callId: string;
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
  run(input: I, ctx: ToolCtx): Promise<O>;
  /**
   * 告诉权限系统"这次调用动的是什么资源"。
   * bash 返回整条命令，文件工具返回路径。省略时退化为 JSON 化的参数。
   */
  describe?(input: unknown): { resource: string; summary: string };
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

/** 把一次调用翻译成权限系统能理解的形式。 */
export function describeCall(tool: Tool, call: ToolCall): PermissionRequest {
  const described = tool.describe?.(call.args);
  if (described !== undefined) {
    return { tool: tool.name, resource: described.resource, summary: described.summary };
  }
  const json = safeJson(call.args);
  return { tool: tool.name, resource: json, summary: `${tool.name} ${json}` };
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
