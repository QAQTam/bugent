/**
 * Skill discovery.
 *
 * A skill is a directory containing `SKILL.md`. The YAML frontmatter supplies
 * the stable name and routing description; the Markdown body is loaded only
 * when the model explicitly activates the skill.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export const SKILL_FILE_NAME = "SKILL.md";
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_NAME_LENGTH = 128;
export const MAX_SKILL_DESCRIPTION_LENGTH = 2_048;

export interface SkillDefinition {
  /** Model-visible stable name from frontmatter. */
  name: string;
  /** Short routing description from frontmatter. */
  description: string;
  /** Absolute path to the skill's SKILL.md. */
  file: string;
  /** Root directory that contributed this skill. */
  root: string;
  /** Parsed Markdown body, excluding frontmatter. */
  body: string;
}

export interface DiscoverSkillsOptions {
  cwd: string;
  /** Home directory override for tests. */
  home?: string;
  /** Additional roots appended after the default roots. */
  paths?: readonly string[];
  /** Disable the built-in user/project roots and use only `paths`. */
  disableDefaults?: boolean;
  /** Skill names to omit after precedence resolution. */
  disabled?: readonly string[];
  /** Maximum directory depth below each root. */
  maxDepth?: number;
}

interface Frontmatter {
  name: string;
  description: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseFrontmatter(text: string, file: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (match === null) {
    throw new Error(`skill ${file}: 缺少 YAML frontmatter`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new Error(`skill ${file}: frontmatter YAML 解析失败：${errorMessage(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`skill ${file}: frontmatter 必须是对象`);
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new Error(`skill ${file}: frontmatter.name 必须是非空字符串`);
  }
  if (typeof record.description !== "string" || record.description.trim().length === 0) {
    throw new Error(`skill ${file}: frontmatter.description 必须是非空字符串`);
  }

  const name = record.name.trim();
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(
      `skill ${file}: name 超过 ${MAX_SKILL_NAME_LENGTH} 个字符`,
    );
  }
  if (/[\0\r\n/\\]/.test(name)) {
    throw new Error(`skill ${file}: name 不能包含 NUL、换行、斜杠或反斜杠`);
  }

  const description = normalizeDescription(record.description);
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(
      `skill ${file}: description 超过 ${MAX_SKILL_DESCRIPTION_LENGTH} 个字符`,
    );
  }

  return { name, description };
}

/** Parse one SKILL.md document. Exported for unit tests and tooling. */
export function parseSkillMarkdown(text: string, file: string, root: string): SkillDefinition {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (match === null) {
    throw new Error(`skill ${file}: 缺少 YAML frontmatter`);
  }
  const frontmatter = parseFrontmatter(text, file);
  const body = (match[2] ?? "").trim();
  if (body.length === 0) {
    throw new Error(`skill ${file}: Markdown 正文不能为空`);
  }
  return { ...frontmatter, file, root, body };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findSkillFiles(root: string, maxDepth: number): Promise<string[]> {
  if (!(await isDirectory(root))) return [];
  const files: string[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        files.push(path);
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(path, depth + 1);
      }
    }
  };

  await walk(root, 0);
  return files;
}

async function loadSkillFile(file: string, root: string): Promise<SkillDefinition> {
  const info = await stat(file);
  if (info.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `skill ${file}: 文件超过 ${MAX_SKILL_FILE_BYTES} 字节；请把详细内容拆到 references/`,
    );
  }
  return parseSkillMarkdown(await readFile(file, "utf8"), file, root);
}

function expandPath(path: string, cwd: string, home: string): string {
  const expanded =
    path === "~"
      ? home
      : path.startsWith("~/")
        ? join(home, path.slice(2))
        : path;
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

/** Default discovery order: user roots, then project roots (project wins). */
export function defaultSkillRoots(cwd: string, home = homedir()): string[] {
  return [
    join(home, ".bugent", "skills"),
    join(home, ".agents", "skills"),
    join(cwd, ".bugent", "skills"),
    join(cwd, ".agents", "skills"),
  ];
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

/**
 * Discover and validate skills from all configured roots.
 *
 * Roots are ordered from lowest to highest precedence. A later skill with the
 * same name overrides an earlier one. Invalid skill files fail discovery
 * instead of silently disappearing, because a missing tool is harder to debug.
 */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<SkillDefinition[]> {
  const home = options.home ?? homedir();
  const defaultRoots = options.disableDefaults === true ? [] : defaultSkillRoots(options.cwd, home);
  const extraRoots = (options.paths ?? []).map((path) => expandPath(path, options.cwd, home));
  const roots = dedupePaths([...defaultRoots, ...extraRoots]);
  const maxDepth = options.maxDepth ?? 8;
  const byName = new Map<string, SkillDefinition>();

  for (const root of roots) {
    const canonicalRoot = await realpath(root).catch(() => root);
    const files = await findSkillFiles(canonicalRoot, maxDepth);
    for (const file of files) {
      const canonicalFile = await realpath(file).catch(() => file);
      const skill = await loadSkillFile(canonicalFile, canonicalRoot);
      const previous = byName.get(skill.name);
      if (previous !== undefined && previous.root === canonicalRoot) {
        throw new Error(
          `skill name "${skill.name}" 在 ${canonicalRoot} 内重复：${previous.file} 与 ${skill.file}`,
        );
      }
      byName.set(skill.name, skill);
    }
  }

  const disabled = new Set(options.disabled ?? []);
  return [...byName.values()]
    .filter((skill) => !disabled.has(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Relative path from a skill root, used for diagnostics only. */
export function relativeSkillPath(skill: SkillDefinition): string {
  return relative(skill.root, skill.file).replaceAll("\\", "/");
}
