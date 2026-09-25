import type { JSONSchema } from "../provider/types.ts";
import type { ResourceClaim } from "./locks.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { applyPatchSummary, applyPatchToWorkspace } from "../patch/apply.ts";
import { parsePatch } from "../patch/parser.ts";
import { relativeTo, resolveWithin } from "./paths.ts";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

const APPLY_PATCH_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description: [
        "The complete patch in apply_patch format.",
        "It must start with '*** Begin Patch' and end with '*** End Patch'.",
        "Supported hunks: '*** Add File:', '*** Delete File:', '*** Update File:'.",
        "Update hunks use '@@', '*** End of File', context lines starting with a space, removed lines starting with '-', and added lines starting with '+'.",
      ].join(" "),
    },
  },
  required: ["patch"],
};

function patchText(input: unknown): string {
  if (typeof input === "string") {
    if (input.trim().length === 0) throw new Error("patch 必须是非空字符串");
    return input;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("apply_patch input 必须是 patch 字符串或 object");
  }
  const record = input as Record<string, unknown>;
  const value = record.patch ?? (record._parseError === true ? record._raw : undefined);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("patch 必须是非空字符串");
  }
  return value;
}

function parsePatchInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("*** Begin Patch")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // 流式中的半截 JSON 交由流式进度解析器处理；最终调用会得到完整文本。
  }
  return trimmed;
}

function resourceClaims(input: unknown, ctx: ToolCtx): readonly ResourceClaim[] {
  try {
    const args = parsePatch(patchText(input));
    const claims: ResourceClaim[] = [];
    for (const hunk of args.hunks) {
      const paths = hunk.type === "update" && hunk.movePath !== undefined
        ? [hunk.path, hunk.movePath]
        : [hunk.path];
      for (const path of paths) {
        const absolute = resolveWithin(ctx.cwd, path);
        const relative = relativeTo(ctx.cwd, absolute).replaceAll("\\", "/");
        const key = `workspace/${relative}`;
        if (!claims.some((claim) => claim.key === key)) {
          claims.push({ key, access: "write" });
        }
      }
    }
    return claims.length > 0 ? claims : [{ key: "workspace", access: "write" }];
  } catch {
    return [{ key: "workspace", access: "write" }];
  }
}

export function createApplyPatchTool(): Tool<unknown, string> {
  return {
    name: APPLY_PATCH_TOOL_NAME,
    description: [
      "The `apply_patch` tool can be used to edit files.",
      "This is a Codex-compatible patch format and edits one or more files atomically.",
      "The executor accepts a FREEFORM patch string. When exposed through a JSON function interface, put that string in the `patch` field.",
      "Do not wrap the patch in a shell command.",
      "Patch grammar:",
      "*** Begin Patch",
      "*** Add File: path",
      "+line",
      "*** Delete File: path",
      "*** Update File: path",
      "*** Move to: path",
      "@@ context",
      "-old line",
      "+new line",
      " context line",
      "*** End of File",
      "*** End Patch",
      "Use context lines liberally so the anchor is unambiguous.",
    ].join("\n"),
    parameters: APPLY_PATCH_PARAMETERS,
    inputFormat: "freeform",
    parseInput: parsePatchInput,
    // 刻意不声明 defaultPermission：写工作区就是 workspace-write 档的边界，
    // 由档位负责（"档位即授权"），和 write_file / edit_file 保持一致。
    // 声明成 "ask" 会导致每次 apply_patch 都弹窗，且和同类的文件工具行为不一致。
    requires: { write: true },
    resources: resourceClaims,
    describe(input: unknown) {
      try {
        const args = parsePatch(patchText(input));
        const files = args.hunks.length;
        return {
          resource: args.hunks.map((hunk) => hunk.path).join(", "),
          summary: `应用 apply_patch（${files} 个文件操作）`,
        };
      } catch {
        return { resource: "workspace", summary: "应用 apply_patch" };
      }
    },
    async run(input: unknown, ctx: ToolCtx): Promise<string> {
      const result = await applyPatchToWorkspace(patchText(input), ctx.cwd);
      for (const edit of result.edits) ctx.onWorkspaceChange?.(edit);
      const lines = ["Success. Updated the following files:"];
      for (const path of result.added) lines.push(`A ${path}`);
      for (const path of result.modified) lines.push(`M ${path}`);
      for (const path of result.deleted) lines.push(`D ${path}`);
      if (lines.length === 1) lines.push(applyPatchSummary(result));
      return lines.join("\n");
    },
  };
}
