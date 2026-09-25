import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchToWorkspace } from "../src/patch/apply.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-apply-patch-"));
  dirs.push(dir);
  return dir;
}

describe("apply_patch workspace transaction", () => {
  test("applies add, update and delete atomically", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "update.txt"), "old\nkeep\n", "utf8");
    await writeFile(join(cwd, "delete.txt"), "gone\n", "utf8");

    const result = await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Add File: nested/add.txt",
        "+hello",
        "*** Update File: update.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
        "*** End Patch",
      ].join("\n"),
      cwd,
    );

    expect(await readFile(join(cwd, "nested/add.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(cwd, "update.txt"), "utf8")).toBe("new\nkeep\n");
    await expect(readFile(join(cwd, "delete.txt"), "utf8")).rejects.toThrow();
    expect(result.added).toEqual(["nested/add.txt"]);
    expect(result.modified).toEqual(["update.txt"]);
    expect(result.deleted).toEqual(["delete.txt"]);
    expect(result.edits.map((edit) => edit.path)).toEqual([
      "nested/add.txt",
      "update.txt",
      "delete.txt",
    ]);
  });

  test("supports move without losing line endings", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "old.txt"), "a\r\nb\r\n", "utf8");

    await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Update File: old.txt",
        "*** Move to: new.txt",
        "@@",
        "-b",
        "+B",
        "*** End Patch",
      ].join("\n"),
      cwd,
      { updateFileMode: "preserve-line-endings" },
    );

    await expect(readFile(join(cwd, "old.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("a\r\nB\r\n");
  });

  test("context mismatch leaves every file untouched", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "two\n", "utf8");

    await expect(
      applyPatchToWorkspace(
        [
          "*** Begin Patch",
          "*** Add File: c.txt",
          "+three",
          "*** Update File: a.txt",
          "@@",
          "-missing",
          "+changed",
          "*** End Patch",
        ].join("\n"),
        cwd,
      ),
    ).rejects.toThrow(/Failed to find expected lines/);

    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two\n");
    await expect(readFile(join(cwd, "c.txt"), "utf8")).rejects.toThrow();
  });

  test("rejects paths outside the workspace", async () => {
    const cwd = await workspace();

    await expect(
      applyPatchToWorkspace(
        "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch",
        cwd,
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });
});
