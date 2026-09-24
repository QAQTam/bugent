/**
 * Skill tool adapter.
 *
 * Skills are instructions, not capabilities. Each discovered skill exposes a
 * no-argument loader tool named `skill__<skill>__load`; loading returns the
 * skill body through a normal tool result, preserving the ToolBatch protocol.
 */

import type { JSONSchema } from "../provider/types.ts";
import type { ResourceClaim } from "../tools/locks.ts";
import type { Tool, ToolCtx, ToolRegistry } from "../tools/types.ts";
import type { SkillDefinition } from "./loader.ts";

export const SKILL_LOAD_ACTION = "load";
export const MAX_SKILL_OUTPUT_CHARS = 128 * 1024;

export function sanitizeSkillNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

export function skillToolName(skillName: string, action = SKILL_LOAD_ACTION): string {
  return `skill__${sanitizeSkillNamePart(skillName)}__${sanitizeSkillNamePart(action)}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const LOAD_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function createSkillLoadTool(skill: SkillDefinition): Tool<Record<string, never>, string> {
  const name = skillToolName(skill.name);
  return {
    name,
    description: [
      `加载 skill "${skill.name}" 的 SKILL.md 指令。`,
      skill.description,
      "只有当任务与该 description 匹配时调用。",
    ].join(" "),
    parameters: LOAD_PARAMETERS,
    defaultPermission: "allow",

    resources(): readonly ResourceClaim[] {
      return [{ key: `skill/${skill.name}`, access: "read" }];
    },

    describe(): { resource: string; summary: string } {
      return {
        resource: `skill/${skill.name}`,
        summary: `加载 skill ${skill.name}`,
      };
    },

    async run(_input: Record<string, never>, ctx: ToolCtx): Promise<string> {
      if (ctx.signal.aborted) throw new Error("skill 加载已取消");
      const body =
        skill.body.length > MAX_SKILL_OUTPUT_CHARS
          ? `${skill.body.slice(0, MAX_SKILL_OUTPUT_CHARS)}\n\n[skill 正文已截断]`
          : skill.body;
      return [
        `<activated_skill name="${escapeAttribute(skill.name)}">`,
        body,
        "</activated_skill>",
      ].join("\n");
    },
  };
}

export function registerSkillTools(
  registry: ToolRegistry,
  skills: readonly SkillDefinition[],
): string[] {
  const names: string[] = [];
  try {
    for (const skill of skills) {
      const tool = createSkillLoadTool(skill);
      if (registry.get(tool.name) !== undefined) {
        throw new Error(`skill 工具名冲突：${tool.name}`);
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
