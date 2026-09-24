/**
 * Skill registry and lifecycle.
 *
 * The manager owns one immutable discovery snapshot. Reloads atomically
 * replace attached registries; timeline injection remains a separate caller
 * concern and must happen at a safe message boundary.
 */

import type { ToolRegistry } from "../tools/types.ts";
import {
  discoverSkills,
  type DiscoverSkillsOptions,
  type SkillDefinition,
} from "./loader.ts";
import { createSkillLoadTool, registerSkillTools, skillToolName } from "./tools.ts";

export interface SkillServerStatus {
  name: string;
  tool: string;
}

export interface SkillStatus {
  skills: readonly SkillServerStatus[];
}

export interface SkillCatalogChanged {
  added: readonly string[];
  removed: readonly string[];
  skills: readonly SkillDefinition[];
}

export interface SkillManagerOptions extends DiscoverSkillsOptions {}

interface SkillAttachment {
  names: Set<string>;
}

function assertUniqueToolNames(skills: readonly SkillDefinition[]): void {
  const names = new Set<string>();
  for (const skill of skills) {
    const name = createSkillLoadTool(skill).name;
    if (names.has(name)) throw new Error(`skill 工具名冲突：${name}`);
    names.add(name);
  }
}

function replaceRegistryTools(
  registry: ToolRegistry,
  attachment: SkillAttachment,
  skills: readonly SkillDefinition[],
): void {
  for (const name of attachment.names) registry.unregister(name);
  attachment.names.clear();
  const added: string[] = [];
  try {
    for (const name of registerSkillTools(registry, skills)) {
      attachment.names.add(name);
      added.push(name);
    }
  } catch (error) {
    for (const name of added) {
      registry.unregister(name);
      attachment.names.delete(name);
    }
    throw error;
  }
}

export class SkillManager {
  readonly #options: DiscoverSkillsOptions;
  #skills: readonly SkillDefinition[] = [];
  #attachments = new Map<ToolRegistry, SkillAttachment>();

  private constructor(options: DiscoverSkillsOptions, skills: readonly SkillDefinition[]) {
    assertUniqueToolNames(skills);
    this.#options = options;
    this.#skills = skills;
  }

  static async create(options: SkillManagerOptions): Promise<SkillManager> {
    return new SkillManager(options, await discoverSkills(options));
  }

  list(): readonly SkillDefinition[] {
    return this.#skills;
  }

  get(name: string): SkillDefinition | undefined {
    return this.#skills.find((skill) => skill.name === name);
  }

  status(): SkillStatus {
    return {
      skills: this.#skills.map((skill) => ({
        name: skill.name,
        tool: skillToolName(skill.name),
      })),
    };
  }

  /** Register the current snapshot into one runtime registry. */
  attach(registry: ToolRegistry): string[] {
    if (this.#attachments.has(registry)) this.detach(registry);
    const attachment: SkillAttachment = { names: new Set() };
    try {
      for (const name of registerSkillTools(registry, this.#skills)) {
        attachment.names.add(name);
      }
    } catch (error) {
      for (const name of attachment.names) registry.unregister(name);
      throw error;
    }
    this.#attachments.set(registry, attachment);
    return [...attachment.names];
  }

  detach(registry: ToolRegistry): void {
    const attachment = this.#attachments.get(registry);
    if (attachment === undefined) return;
    for (const name of attachment.names) registry.unregister(name);
    this.#attachments.delete(registry);
  }

  /** Stable model-visible skill catalog used for msgid2. */
  manifest(): string {
    if (this.#skills.length === 0) return "# Skills\n\n(none)";
    const lines = [
      "# Skills",
      "",
      "Load a skill's SKILL.md instructions with its `skill__<name>__load` tool when the task matches the description.",
      "",
    ];
    for (const skill of this.#skills) {
      lines.push(`- \`${skillToolName(skill.name)}\`: ${skill.description}`);
    }
    return lines.join("\n").trimEnd();
  }

  deltaFrom(previousManifest: string): string | undefined {
    const current = this.manifest();
    if (current === previousManifest) return undefined;
    return [
      "# Skills manifest update",
      "",
      "The available skill catalog changed. Current catalog:",
      "",
      current,
    ].join("\n");
  }

  /** Re-scan roots and update every attached registry. */
  async reload(): Promise<SkillCatalogChanged> {
    const next = await discoverSkills(this.#options);
    assertUniqueToolNames(next);

    // Preflight external collisions before changing any registry.
    const nextNames = new Set(next.map((skill) => createSkillLoadTool(skill).name));
    for (const [registry, attachment] of this.#attachments) {
      for (const name of nextNames) {
        if (!attachment.names.has(name) && registry.get(name) !== undefined) {
          throw new Error(`skill 工具名冲突：${name}`);
        }
      }
    }

    const previousNames = new Set(this.#skills.map((skill) => skillToolName(skill.name)));
    const added = [...nextNames].filter((name) => !previousNames.has(name));
    const removed = [...previousNames].filter((name) => !nextNames.has(name));
    for (const [registry, attachment] of this.#attachments) {
      replaceRegistryTools(registry, attachment, next);
    }
    this.#skills = next;
    return { added, removed, skills: next };
  }
}
