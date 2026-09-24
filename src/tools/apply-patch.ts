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
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("apply_patch input 必须是 object");
  }
  const value = (input as Record<string, unknown>).patch;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("patch 必须是非空字符串");
  }
  return value;
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
      "Do not wrap the patch in a shell command or JSON string literal.",
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
    defaultPermission: "ask",
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
