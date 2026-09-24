import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { SkillManager } from "../src/skills/manager.ts";
import { discoverSkills, parseSkillMarkdown } from "../src/skills/loader.ts";
import { skillToolName } from "../src/skills/tools.ts";
import { ToolRegistry } from "../src/tools/types.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-skills-"));
  dirs.push(dir);
  return dir;
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("skills loader", () => {
  test("解析 YAML frontmatter，正文不进入 manifest", async () => {
    const root = await tempDir();
    await writeSkill(root, "review", "review", "Review code changes.", "# Review\nRead the diff.");

    const manager = await SkillManager.create({
      cwd: root,
      disableDefaults: true,
      paths: [root],
    });
    const manifest = manager.manifest();

    expect(manifest).toContain(`\`${skillToolName("review")}\`: Review code changes.`);
    expect(manifest).not.toContain("Read the diff.");
    expect(manager.status().skills).toEqual([
      { name: "review", tool: skillToolName("review") },
    ]);
  });

  test("项目 skill 覆盖用户 skill，disabled 最后生效", async () => {
    const user = await tempDir();
    const project = await tempDir();
    await writeSkill(user, "same", "same", "User version", "user body");
    await writeSkill(project, "same", "same", "Project version", "project body");
    await writeSkill(user, "keep", "keep", "Keep me", "keep body");

    const skills = await discoverSkills({
      cwd: project,
      disableDefaults: true,
      paths: [user, project],
      disabled: ["keep"],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["same"]);
    expect(skills[0]?.description).toBe("Project version");
    expect(skills[0]?.body).toBe("project body");
  });

  test("拒绝缺少 frontmatter 或空正文的 skill", () => {
    expect(() => parseSkillMarkdown("# nope", "/tmp/SKILL.md", "/tmp")).toThrow(
      /frontmatter/,
    );
    expect(() =>
      parseSkillMarkdown("---\nname: empty\ndescription: Empty\n---\n", "/tmp/SKILL.md", "/tmp"),
    ).toThrow(/正文/);
  });
});

describe("skills runtime", () => {
  test("load 工具通过 ToolRegistry 返回正文，且 manifest 保持前缀稳定", async () => {
    const root = await tempDir();
    await writeSkill(root, "review", "review", "Review code changes.", "# Review\nRead the diff.");
    const manager = await SkillManager.create({
      cwd: root,
      disableDefaults: true,
      paths: [root],
    });
    const registry = new ToolRegistry();
    const names = manager.attach(registry);

    expect(names).toEqual([skillToolName("review")]);
    const result = await registry.execute(
      { id: "c1", name: skillToolName("review"), args: {} },
      { cwd: root, signal: new AbortController().signal, callId: "c1", sessionId: "s1" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<activated_skill name="review">');
    expect(result.output).toContain("# Review\nRead the diff.");

    const session = new AgentSession({
      id: "s1",
      system: "SYS",
      skillsManifest: manager.manifest(),
      client: createMockClient({ script: [] }),
      model: "mock",
    });
    expect(session.messages[2]?.injectionSource).toBe("skill");
  });

  test("reload 原子更新注册表并返回 delta 所需增删", async () => {
    const root = await tempDir();
    await writeSkill(root, "one", "one", "First", "one body");
    const manager = await SkillManager.create({
      cwd: root,
      disableDefaults: true,
      paths: [root],
    });
    const registry = new ToolRegistry();
    manager.attach(registry);
    const previous = manager.manifest();

    await writeSkill(root, "two", "two", "Second", "two body");
    await rm(join(root, "one"), { recursive: true, force: true });
    const changed = await manager.reload();

    expect(changed.added).toEqual([skillToolName("two")]);
    expect(changed.removed).toEqual([skillToolName("one")]);
    expect(registry.get(skillToolName("one"))).toBeUndefined();
    expect(registry.get(skillToolName("two"))).toBeDefined();
    expect(manager.deltaFrom(previous)).toContain("# Skills manifest update");
  });
});
