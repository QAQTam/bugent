/**
 * MCP tool adapter.
 *
 * Every MCP tool call goes through ToolRegistry.execute(), so it inherits the
 * same permission gate, resource locks, cancellation, and result ordering as
 * native tools. The process-level capability grant is established when the MCP
 * server is started; individual calls cannot widen it.
 */

import type { JSONSchema } from "../provider/types.ts";
import type { ResourceClaim } from "../tools/locks.ts";
import type { Tool, ToolCtx } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/types.ts";
import type { McpCallToolResult, McpStdioClient, McpToolInfo } from "./stdio.ts";

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_RESULT_CHARS = 12_000;

export function sanitizeMcpNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeMcpNamePart(serverId)}__${sanitizeMcpNamePart(toolName)}`;
}

function summarize(value: unknown, max = 500): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentToText(result: McpCallToolResult): string {
  const chunks: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (typeof item === "string") {
        chunks.push(item);
        continue;
      }
      if (typeof item !== "object" || item === null) {
        chunks.push(String(item));
        continue;
      }
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        chunks.push(record.text);
      } else if (record.type === "resource") {
        chunks.push(`[MCP resource]\n${summarize(record.resource, MAX_RESULT_CHARS)}`);
      } else if (record.type === "image" || record.type === "audio") {
        const data = typeof record.data === "string" ? record.data : "";
        chunks.push(
          `[MCP ${record.type}: ${typeof record.mimeType === "string" ? record.mimeType : "unknown"}, ${data.length} base64 chars]`,
        );
      } else {
        chunks.push(summarize(record, MAX_RESULT_CHARS));
      }
    }
  }
  if (result.structuredContent !== undefined) {
    chunks.push(`[structuredContent]\n${summarize(result.structuredContent, MAX_RESULT_CHARS)}`);
  }
  if (chunks.length === 0) chunks.push("(无输出)");
  const text = chunks.join("\n\n");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

export function createMcpTool(
  client: McpStdioClient,
  serverId: string,
  info: McpToolInfo,
): Tool<Record<string, unknown>, string> {
  const exposedName = mcpToolName(serverId, info.name);
  const readOnly = info.annotations?.readOnlyHint === true;
  const description = [
    `MCP server "${serverId}" 的工具 "${info.name}"。`,
    info.description ?? "",
    readOnly ? "该工具声明为只读。" : "该工具可能修改 MCP server 被授予的资源。",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    name: exposedName,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    parameters: (info.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,
    needsSandbox: true,
    // MCP 工具是外部进程的入口：server 启动时被授予的能力（写盘/联网/exec）
    // 会随一次调用全部生效，所以默认必须逐次询问 —— 不能因为"闸门在"就默认
    // 放行。no-sandbox 档会在组装策略时把这类工具默认 ask 升级为 allow（用户
    // 预授权一切）；用户仍可用显式规则对特定 server 配 allow/deny。
    // 提示注入最现实的落点就是把模型引到这里，默认 ask 是最后一道人工闸门。
    defaultPermission: "ask",

    resources(): readonly ResourceClaim[] {
      // readOnlyHint 来自外部 server，是声明不是证明 —— 只用于展示文案，
      // 不参与资源判定：锁一律按写申请，保守串行。
      return [{ key: "workspace", access: "write" }];
    },

    describe(input: unknown): { resource: string; summary: string } {
      return {
        resource: `${serverId}/${info.name}:${summarize(input, 300)}`,
        summary: `调用 MCP 工具 ${serverId}/${info.name}，参数 ${summarize(input, 500)}`,
      };
    },

    async run(input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
      if (ctx.signal.aborted) throw new Error("MCP 工具调用已取消");
      // 取消信号传进 transport：abort 时在途请求立即失败，而不是等 server 应答。
      const result = await client.callTool(info.name, input, { signal: ctx.signal });
      const text = contentToText(result);
      return result.isError === true ? `[MCP error]\n${text}` : text;
    },
  };
}

/**
 * Register a snapshot of a server's tools.
 *
 * The caller is responsible for taking the snapshot only at a safe timeline
 * boundary. This function does not mutate session history.
 */
export function registerMcpTools(
  registry: ToolRegistry,
  client: McpStdioClient,
  serverId: string,
  tools: readonly McpToolInfo[],
): string[] {
  const names: string[] = [];
  try {
    for (const info of tools) {
      const tool = createMcpTool(client, serverId, info);
      if (registry.get(tool.name) !== undefined) {
        throw new Error(`MCP 工具名冲突：${tool.name}`);
      }
      registry.register(tool);
      names.push(tool.name);
    }
    return names;
  } catch (error) {
    for (const name of names) registry.unregister(name);
    throw error;
  }
}
