/**
 * Skill configuration bootstrap.
 *
 * Discovery is process-scoped; session timelines receive only the stable
 * manifest snapshot and the loader tools for that snapshot.
 */

import type { SkillsConfig } from "../config/schema.ts";
import { SkillManager } from "./manager.ts";

export interface StartedSkills {
  manager: SkillManager;
  manifest: string;
}

export interface StartSkillsOptions {
  config: SkillsConfig | undefined;
  cwd: string;
  home?: string;
}

export async function startConfiguredSkills(
  options: StartSkillsOptions,
): Promise<StartedSkills> {
  const manager = await SkillManager.create({
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.config?.paths !== undefined ? { paths: options.config.paths } : {}),
    ...(options.config?.disableDefaults !== undefined
      ? { disableDefaults: options.config.disableDefaults }
      : {}),
    ...(options.config?.disabled !== undefined
      ? { disabled: options.config.disabled }
      : {}),
  });
  return { manager, manifest: manager.manifest() };
}
