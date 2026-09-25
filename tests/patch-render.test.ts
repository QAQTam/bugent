/**
 * apply_patch 卡片的宽度约束。
 *
 * 回归防线：`+N -M` 徽标曾经在长路径下被挤到行尾之外，被屏幕层硬截断 ——
 * 截掉的恰好是这行最该看见的东西。根因是 per-file 行没有任何宽度预算，
 * 徽标无条件拼在路径后面；`header()` 也有同样的隐患（间隔被 `Math.max(1, …)`
 * 钳住，左边一长整行就超宽）。
 *
 * 不变量：**任何输入、任何宽度下，返回的每一行都不超过 width。**
 */

import { describe, expect, test } from "bun:test";
import { renderToolItem, type ToolItem } from "../src/tui/renderers.ts";
import { registerBuiltinToolRenderers } from "../src/tui/renderers-builtin.ts";
import { visibleWidth } from "../src/tui/ansi.ts";

// 走真实出口 renderToolItem（应用就是这么调的）：它带一层"任何一行都不许超过
// width"的兜底，用来收住固定文案（"… 还有 N 行（点击展开）"）在极窄终端上的溢出。
registerBuiltinToolRenderers();

function item(over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    callId: "call-1",
    name: "apply_patch",
    args: { patch: "*** Begin Patch" },
    output: "",
    ok: true,
    done: false,
    progress: "",
    expanded: false,
    ...over,
  } as ToolItem;
}

const LONG_PATH = "src/very/deeply/nested/module/path/that/keeps/going/forever/Component.tsx";
const CJK_PATH = "中文目录/深层/嵌套/再深一层/更深的目录/中文文件名.ts";
const EMOJI_PATH = "src/😀emoji/路径/file.ts";
const PATHS = ["src/a.ts", LONG_PATH, CJK_PATH, EMOJI_PATH];

/** 两个文件、4 增 1 删 —— 完成态统计用例的固定输入。 */
const MULTI_FILE_PATCH = [
  "*** Begin Patch",
  "*** Add File: src/a.ts",
  "+one",
  "+two",
  "+three",
  "*** Update File: src/b.ts",
  "@@ context",
  "-old line",
  "+new line",
  "*** End Patch",
].join("\n");

const STATS = [
  { added: 7, removed: 3 },
  { added: 1234, removed: 5678 },
  { added: 123456789, removed: 987654321 },
];

function streaming(path: string, stat: { added: number; removed: number }): ToolItem {
  return item({
    done: false,
    patchProgress: {
      files: [{ path, kind: "update", added: stat.added, removed: stat.removed }],
      added: stat.added,
      removed: stat.removed,
      complete: false,
    },
  });
}

function completed(path: string): ToolItem {
  return item({
    done: true,
    output: `Success. Updated the following files:\nM ${path}\nA ${path}`,
  });
}

describe("apply_patch 卡片 · 永不超出终端宽度", () => {
  test("流式态：宽度 1~130 全扫，每行都不超宽", () => {
    let checked = 0;
    for (const path of PATHS) {
      for (const stat of STATS) {
        for (let width = 1; width <= 130; width += 1) {
          for (const [index, line] of renderToolItem(streaming(path, stat), width).entries()) {
            checked += 1;
            expect(
              visibleWidth(line) <= width,
              `width=${width} 第${index}行 宽度=${visibleWidth(line)} path=${path}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test("完成态（含展开/折叠）：宽度 1~130 全扫，每行都不超宽", () => {
    for (const path of PATHS) {
      for (const expanded of [false, true]) {
        for (let width = 1; width <= 130; width += 1) {
          const lines = renderToolItem(item({ ...completed(path), expanded }), width);
          for (const [index, line] of lines.entries()) {
            expect(
              visibleWidth(line) <= width,
              `width=${width} expanded=${expanded} 第${index}行 宽度=${visibleWidth(line)}`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("apply_patch 卡片 · 徽标必须看得见", () => {
  test("长路径下徽标仍然完整显示（这是原来的 bug）", () => {
    const width = 80;
    const lines = renderToolItem(streaming(LONG_PATH, { added: 1234, removed: 5678 }), width);
    const plain = lines.map((line) => Bun.stripANSI(line)).join("\n");

    // 头部与文件行各有一个徽标 —— 折行后它们落在各自那一块的最后一行，
    // 所以整块里找，而不是钉死在某个行号上。
    expect(plain.match(/\+1234/g) ?? []).toHaveLength(2);
    expect(plain.match(/-5678/g) ?? []).toHaveLength(2);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("窄屏下宁可砍路径也要保住徽标", () => {
    for (const width of [80, 60, 40, 30, 24]) {
      const lines = renderToolItem(streaming(LONG_PATH, { added: 12, removed: 3 }), width);
      // 头部 + 文件行各一个 +12
      expect((Bun.stripANSI(lines.join("\n")).match(/\+12/g) ?? []).length, `width=${width}`).toBe(2);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("宽度充足时徽标右对齐在行尾", () => {
    const width = 80;
    const lines = renderToolItem(streaming("src/a.ts", { added: 12, removed: 3 }), width);
    const head = lines[0]!;
    // 可见宽度正好铺满，且以徽标结尾
    expect(visibleWidth(head)).toBe(width);
    expect(Bun.stripANSI(head).trimEnd().endsWith("+12 -3")).toBe(true);
  });

  test("徽标比整行还宽时只能砍徽标，但仍然不超宽", () => {
    const lines = renderToolItem(streaming(LONG_PATH, { added: 123456789, removed: 987654321 }), 6);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(6);
  });

  test("增删都为 0 时不出徽标，也不留多余空格", () => {
    const lines = renderToolItem(streaming("src/a.ts", { added: 0, removed: 0 }), 80);
    expect(Bun.stripANSI(lines[0]!)).not.toContain("+");
    expect(Bun.stripANSI(lines[1]!).trimEnd().endsWith("src/a.ts")).toBe(true);
  });

  test("CJK 路径按显示宽度算，不会因为双宽字符溢出", () => {
    for (const width of [40, 60, 80]) {
      const lines = renderToolItem(streaming(CJK_PATH, { added: 7, removed: 3 }), width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect((Bun.stripANSI(lines.join("\n")).match(/\+7/g) ?? []).length).toBe(2);
    }
  });

  test("move 目标路径参与预算，不会把徽标挤掉", () => {
    const moved = item({
      done: false,
      patchProgress: {
        files: [{ path: LONG_PATH, kind: "move", added: 5, removed: 2, destination: CJK_PATH }],
        added: 5,
        removed: 2,
        complete: false,
      },
    });
    for (const width of [40, 80, 120]) {
      const lines = renderToolItem(moved, width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect((Bun.stripANSI(lines.join("\n")).match(/\+5/g) ?? []).length).toBe(2);
    }
  });
  test("完成态从入参反解统计 —— 恢复会话后徽标仍在", () => {
    // 模拟 --resume：卡片从持久化消息重建，没有 patchProgress，只有 args + output。
    // 之前这里用 parseDiffStat(item.output)，而 apply_patch 的输出是
    // `A path` / `M path`，和它认的 `+行/-行` 格式对不上 —— 徽标因此永远消失。
    const restored = item({
      done: true,
      ok: true,
      args: { patch: MULTI_FILE_PATCH },
      output: "Success. Updated the following files:\nA src/a.ts\nM src/b.ts",
    });

    const head = Bun.stripANSI(renderToolItem(restored, 80)[0]!);
    expect(head).toContain("+4");
    expect(head).toContain("-1");
  });

  test("入参是裸 patch 字符串时同样能反解", () => {
    // freeform 工具的 parseInput 在 patch 以 "*** Begin Patch" 开头时直接返回字符串
    const restored = item({ done: true, ok: true, args: MULTI_FILE_PATCH, output: "Success." });
    expect(Bun.stripANSI(renderToolItem(restored, 80)[0]!)).toContain("+4");
  });

  test("入参缺失或不是合法 patch 时不抛错，只是没有徽标", () => {
    for (const args of [undefined, {}, { patch: "*** Begin Patch" }, { patch: 42 }, "not a patch"]) {
      const broken = item({ done: true, ok: true, args, output: "Success." });
      const lines = renderToolItem(broken, 80);
      expect(Bun.stripANSI(lines[0]!)).not.toContain("+");
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
    }
  });

  test("完成态但失败时不显示徽标", () => {
    const failed = item({ done: true, ok: false, args: { patch: MULTI_FILE_PATCH }, output: "boom" });
    expect(Bun.stripANSI(renderToolItem(failed, 80)[0]!)).not.toContain("+4");
  });

describe("apply_patch 卡片 · 折行与悬挂缩进", () => {
  test("长路径折行，续行对齐到路径起点（不是行首）", () => {
    const lines = renderToolItem(streaming(LONG_PATH, { added: 1, removed: 0 }), 40);
    // 第 0 行是头部；第 1 行起是文件行
    const fileLines = lines.slice(1);
    expect(fileLines.length).toBeGreaterThan(1);

    const first = Bun.stripANSI(fileLines[0]!);
    const second = Bun.stripANSI(fileLines[1]!);
    // 首行形如 `  M src/very/...`；续行必须对齐到路径起点，而不是 2 格缩进
    const contentStart = first.indexOf("src/");
    expect(contentStart).toBeGreaterThan(0);
    expect(second.slice(0, contentStart).trim()).toBe("");
    expect(second.trimStart()).toMatch(/^\S/);
    expect(second.indexOf(second.trimStart())).toBe(contentStart);
  });

  test("文件行折行后，徽标落在它自己的最后一行（不是第一行）", () => {
    const lines = renderToolItem(streaming(LONG_PATH, { added: 1234, removed: 5678 }), 60);
    const plain = lines.map((line) => Bun.stripANSI(line));
    const fileStart = plain.findIndex((line) => line.includes("M src/"));
    expect(fileStart).toBeGreaterThan(0);

    const fileBlock = plain.slice(fileStart);
    expect(fileBlock.length).toBeGreaterThan(1); // 确实折了
    expect(fileBlock[0]).not.toContain("+1234"); // 首行被路径占满
    expect(fileBlock.at(-1)).toContain("+1234"); // 徽标在末行
    expect(fileBlock.at(-1)).toContain("-5678");
  });

  test("头部徽标右对齐在头部最后一行", () => {
    const lines = renderToolItem(streaming(LONG_PATH, { added: 1234, removed: 5678 }), 60);
    const plain = lines.map((line) => Bun.stripANSI(line));
    const fileStart = plain.findIndex((line) => line.includes("M src/"));
    const headLines = plain.slice(0, fileStart);
    expect(headLines.at(-1)).toContain("+1234");
  });

  test("窄屏下路径折得更碎，但缩进关系不变", () => {
    for (const width of [30, 40, 50]) {
      const lines = renderToolItem(streaming(LONG_PATH, { added: 3, removed: 1 }), width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      const plain = lines.map((l) => Bun.stripANSI(l));
      const fileStart = plain.findIndex((l) => l.includes("M src/"));
      const contentStart = plain[fileStart]!.indexOf("src/");
      // 该块内的续行都对齐到同一个列
      for (const line of plain.slice(fileStart + 1)) {
        if (line.trim().length === 0) continue;
        expect(line.slice(0, contentStart).trim()).toBe("");
      }
    }
  });

  test("路径放得下时不折行（不为了折行而折行）", () => {
    const lines = renderToolItem(streaming("src/a.ts", { added: 1, removed: 0 }), 80);
    const plain = lines.map((l) => Bun.stripANSI(l));
    expect(plain.filter((l) => l.includes("src/a.ts"))).toHaveLength(1);
  });
});

});
