#!/usr/bin/env bun
/**
 * 把当前仓库的 system prompt 与全部工具 schema 冻结成 snapshot，供 prompt-lab 对照用。
 *
 * 用法：
 *   bun run scripts/dump-tools.ts <名字>          # .prompt-lab/snapshots/tools-<名字>.json
 *   bun run scripts/dump-tools.ts en-short --system   # 同时冻结 system.md
 *
 * 为什么要冻结：改完提示词再想跟改动前对比时，仓库里只剩新版了。实验必须对着
 * 快照跑，"改前 / 改后"才是同一把尺子。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultTools } from "../src/tools/builtin.ts";
import { createGoalTools } from "../src/tools/goal.ts";
import type { GoalController } from "../src/goal/controller.ts";

const name = Bun.argv[2];
if (name === undefined || name.length === 0) {
  throw new Error("用法：bun run scripts/dump-tools.ts <名字> [--system]");
}

const setup = createDefaultTools({
  mode: "workspace-write",
  agentTools: {
    transport: {} as never,
    parent: {
      agentId: "snapshot",
      rootId: "snapshot",
      sessionId: "snapshot",
      authority: "workspace-write",
      capabilities: ["agent.spawn"],
    },
    cwd: process.cwd(),
  },
});
for (const tool of createGoalTools({} as unknown as GoalController)) {
  setup.registry.register(tool);
}

const dir = join(process.cwd(), ".prompt-lab", "snapshots");
const schemas = setup.registry.schemas();
const toolsFile = join(dir, `tools-${name}.json`);
writeFileSync(toolsFile, JSON.stringify(schemas, null, 2));

const total = JSON.stringify(schemas).length;
console.log(`${toolsFile}：${schemas.length} 个工具，${total} chars`);

if (Bun.argv.includes("--system")) {
  const source = join(import.meta.dir, "..", "src", "prompts", "system.md");
  const text = (await Bun.file(source).text()).trimEnd();
  const systemFile = join(dir, `system-${name}.md`);
  writeFileSync(systemFile, `${text}\n`);
  console.log(`${systemFile}：${text.length} chars`);
}
