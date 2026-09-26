import { describe, expect, test } from "bun:test";
import { jsonStringField } from "../src/core/partial-json.ts";
import {
  extractPatchText,
  PatchStreamProgress,
  type PatchProgress,
} from "../src/patch/streaming-progress.ts";

const PATCH = [
  "*** Begin Patch",
  "*** Add File: b.txt",
  "+one",
  "+two",
  "*** Update File: a.txt",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

describe("apply_patch streaming progress", () => {
  test("extracts raw freeform and JSON-wrapped patch text", () => {
    expect(extractPatchText(PATCH)).toBe(PATCH);
    expect(extractPatchText(JSON.stringify({ patch: PATCH }))).toBe(PATCH);
    expect(extractPatchText('{"patch":"line\\n\\u4e2d"')).toBe("line\n中");
  });

  test("keeps incremental JSON decoding stable across arbitrary chunks", () => {
    const raw = JSON.stringify({ patch: PATCH });
    const stream = new PatchStreamProgress();
    let progress: PatchProgress | undefined;
    for (let offset = 0; offset < raw.length; offset += 7) {
      progress = stream.push(raw.slice(0, offset + 7));
    }

    expect(progress?.files.map((file) => file.path)).toEqual(["b.txt", "a.txt"]);
    expect(progress?.added).toBe(3);
    expect(progress?.removed).toBe(1);
    if (progress === undefined) throw new Error("patch progress was not produced");
    expect(stream.hunks().map(hunk => hunk.type)).toEqual(["add", "update"]);
    expect(stream.finish()).toEqual({ ...progress, complete: true });
  });

  test("does not expose a patch before the JSON field appears", () => {
    const stream = new PatchStreamProgress();
    expect(stream.push('{"other":')).toBeUndefined();
    expect(stream.push('{"other":')).toBeUndefined();
  });

  test("PERF-004: 大 patch 分 2000 个增量推进仍是线性开销", () => {
    // 旧实现：每个增量都对全量 rawArgs 跑正则 + 全量 JSON 解码 + hunks()
    // 深拷贝 —— O(L²)，500KB 的 patch 会拖死 UI。
    const body = Array.from({ length: 3000 }, (_, index) => `+line ${index} content here`).join("\n");
    const raw = JSON.stringify({
      patch: `*** Begin Patch\n*** Add File: big.txt\n${body}\n*** End Patch`,
    });
    const stream = new PatchStreamProgress();

    const started = Date.now();
    let progress: PatchProgress | undefined;
    const step = Math.ceil(raw.length / 2000);
    for (let offset = 0; offset < raw.length; offset += step) {
      progress = stream.push(raw.slice(0, offset + step));
    }
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(progress?.files.map((file) => file.path)).toEqual(["big.txt"]);
    expect(stream.finish().added).toBe(3000);
  });
});

describe("jsonStringField —— 流式参数里的字符串字段", () => {
  test("半截 JSON 里也能抠出已经收尾的字段", () => {
    expect(jsonStringField('{"path":"src/a.ts","content":"line one\\nline tw', "path")).toBe(
      "src/a.ts",
    );
  });

  test("值还没收尾时给的是已经到达的部分", () => {
    expect(jsonStringField('{"path":"src/very/long', "path")).toBe("src/very/long");
  });

  test("转义按 JSON 语义解码，不是按字面量", () => {
    expect(jsonStringField('{"path":"a\\nb\\u4e2d","x', "path")).toBe("a\nb中");
  });

  test("半截转义序列不猜（返回已确定的前缀）", () => {
    expect(jsonStringField('{"path":"a\\u12', "path")).toBe("a");
    expect(jsonStringField('{"path":"a\\', "path")).toBe("a");
  });

  test("别的字段值里写着 JSON 时，只认真正的顶层键", () => {
    // content 里带一段 JSON：里面的 "path" 是**值**，不是键，不能当成路径
    expect(jsonStringField('{"content":"{\\"path\\":\\"evil.ts\\"}"}', "path")).toBeUndefined();
    // 顶层真的还有一个 path 时，要跳过 content 里的那个、取真正的这个
    const raw = '{"content":"{\\"path\\":\\"evil.ts\\"}","path":"good.ts"}';
    expect(jsonStringField(raw, "path")).toBe("good.ts");
  });

  test("没有这个字段、或值不是字符串时返回 undefined", () => {
    expect(jsonStringField('{"content":"x', "path")).toBeUndefined();
    expect(jsonStringField("", "path")).toBeUndefined();
    expect(jsonStringField('{"path":', "path")).toBeUndefined();
  });
});
