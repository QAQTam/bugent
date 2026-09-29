/**
 * 项目级 bugent.config.ts 执行确认门（BUG-014）。
 *
 * 项目配置是任意代码 —— 注入 confirmProjectConfig 后：
 *   - 首次执行必须先问；拒绝 → 抛错且不 import；
 *   - 同意 → 写入信任记录（路径 → 哈希），同哈希再次加载不再询问；
 *   - 文件内容变化 → 哈希失配，重新询问；
 *   - 未注入钩子（测试 / 嵌入调用）保持旧行为。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-cfg-gate-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "bugent.config.ts"),
    `export default { model: "mock/m", providers: [] };\n`,
    "utf8",
  );
  return dir;
}

describe("项目配置确认门（BUG-014）", () => {
  test("首次拒绝 → 抛错且不 import", async () => {
    const dir = await project();
    const home = await mkdtemp(join(tmpdir(), "bugent-cfg-home-"));
    dirs.push(home);

    await expect(
      loadConfig({
        cwd: dir,
        home,
        // 不生成用户级 config.toml —— 否则它优先，项目配置根本不会被读
        noCreate: true,
        confirmProjectConfig: async () => false,
      }),
    ).rejects.toThrow(/拒绝执行/);
  });

  test("同意 → 写信任记录；同哈希免询问；内容变化重新询问", async () => {
    const dir = await project();
    const home = await mkdtemp(join(tmpdir(), "bugent-cfg-home-"));
    dirs.push(home);

    let asks = 0;
    const confirm = async (): Promise<boolean> => {
      asks += 1;
      return true;
    };

    const first = await loadConfig({ cwd: dir, home, noCreate: true, confirmProjectConfig: confirm });
    expect(first.source).toContain("bugent.config");
    expect(asks).toBe(1);

    // 同哈希：不再问
    const second = await loadConfig({ cwd: dir, home, noCreate: true, confirmProjectConfig: confirm });
    expect(second.source).toContain("bugent.config");
    expect(asks).toBe(1);

    // 内容变化：哈希失配，重新确认
    await writeFile(
      join(dir, "bugent.config.ts"),
      `export default { model: "mock/m2", providers: [] };\n`,
      "utf8",
    );
    const third = await loadConfig({ cwd: dir, home, noCreate: true, confirmProjectConfig: confirm });
    expect(third.config.model).toBe("mock/m2");
    expect(asks).toBe(2);
  });

  test("未注入确认钩子时保持旧行为（测试 / 嵌入路径）", async () => {
    const dir = await project();
    const home = await mkdtemp(join(tmpdir(), "bugent-cfg-home-"));
    dirs.push(home);

    const loaded = await loadConfig({ cwd: dir, home, noCreate: true });
    expect(loaded.source).toContain("bugent.config");
  });
});
