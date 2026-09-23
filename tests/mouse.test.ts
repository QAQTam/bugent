import { describe, expect, test } from "bun:test";
import { KeyDecoder, type Key } from "../src/tui/keys.ts";
import { Transcript } from "../src/tui/transcript.ts";
import { foldLines } from "../src/tui/render-tools.ts";

function mouse(decoder: KeyDecoder, sequence: string): Key[] {
  return decoder.push(sequence);
}

describe("鼠标事件解析（SGR 扩展）", () => {
  test("左键按下", () => {
    const keys = mouse(new KeyDecoder(), "\x1b[<0;12;7M");
    expect(keys).toEqual([{ type: "mouse", button: "left", x: 12, y: 7, pressed: true }]);
  });

  test("左键抬起用 m 结尾", () => {
    const keys = mouse(new KeyDecoder(), "\x1b[<0;12;7m");
    expect(keys).toEqual([{ type: "mouse", button: "left", x: 12, y: 7, pressed: false }]);
  });

  test("滚轮上/下（按键码 64/65）", () => {
    expect(mouse(new KeyDecoder(), "\x1b[<64;5;5M")[0]).toMatchObject({
      type: "mouse",
      button: "wheelUp",
    });
    expect(mouse(new KeyDecoder(), "\x1b[<65;5;5M")[0]).toMatchObject({
      type: "mouse",
      button: "wheelDown",
    });
  });

  test("右键", () => {
    expect(mouse(new KeyDecoder(), "\x1b[<2;1;1M")[0]).toMatchObject({ button: "right" });
  });

  test("跨 chunk 切断的鼠标序列能拼回", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[<0;12")).toEqual([]);
    expect(decoder.push(";7M")).toEqual([
      { type: "mouse", button: "left", x: 12, y: 7, pressed: true },
    ]);
  });

  test("鼠标序列不会污染普通按键解析", () => {
    const decoder = new KeyDecoder();
    const keys = decoder.push("\x1b[<0;1;1Mabc");
    expect(keys).toHaveLength(2);
    expect(keys[0]?.type).toBe("mouse");
    expect(keys[1]).toEqual({ type: "text", value: "abc" });
  });
});

describe("折叠展开", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);

  test("折叠时保留头尾并提示可展开", () => {
    const folded = foldLines(lines, 2, 2, "#fff");
    expect(folded).toHaveLength(5);
    expect(folded[0]).toContain("line0");
    expect(folded[1]).toContain("line1");
    expect(folded[2]).toContain("已忽略 16 行");
    expect(folded[2]).toContain("点击展开");
    expect(folded[3]).toContain("line18");
    expect(folded[4]).toContain("line19");
  });

  test("展开后原样返回全部行", () => {
    const expanded = foldLines(lines, 2, 2, "#fff", true);
    expect(expanded).toHaveLength(20);
    expect(expanded.join("\n")).toContain("line10");
  });

  test("行数不足时不折叠", () => {
    expect(foldLines(["a", "b"], 3, 3, "#fff")).toEqual(["a", "b"]);
  });
});

describe("Transcript 展开切换", () => {
  test("按 callId 切换，未命中返回 false", () => {
    const transcript = new Transcript();
    transcript.startTool({ id: "c1", name: "bash", args: {} });

    const item = transcript.items[0];
    expect(item?.kind === "tool" && item.expanded).toBe(false);

    expect(transcript.toggleToolExpanded("c1")).toBe(true);
    const after = transcript.items[0];
    expect(after?.kind === "tool" && after.expanded).toBe(true);

    expect(transcript.toggleToolExpanded("nope")).toBe(false);
  });

  test("新工具默认是折叠的", () => {
    const transcript = new Transcript();
    transcript.startTool({ id: "c1", name: "bash", args: {} });
    const item = transcript.items[0];
    expect(item?.kind === "tool" && item.expanded).toBe(false);
  });
});
