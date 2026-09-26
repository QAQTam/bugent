/**
 * 流式参数解码：`StringFieldStream`（增量字段解码）与 `FileStreamProgress`
 * （write_file / edit_file 的实时路径与行数）。
 *
 * 两条不变量：
 *   1. **任意分片**下结果一致 —— provider 怎么切 chunk 都不该改变最终数字；
 *   2. 解码是**增量**的 —— 每个 delta 只解新增那一段，总代价 O(长度)。
 *      第 2 条是性能防线：一次性版每个 delta 都要从字段起点重解，写一个大文件
 *      会变成分钟级 CPU。
 */

import { describe, expect, test } from "bun:test";
import { StringFieldStream } from "../src/core/partial-json.ts";
import { FileStreamProgress, isFileToolName } from "../src/tools/file-progress.ts";

/** 把 `source` 按固定长度切片，逐片喂给流（模拟 provider 的 delta）。 */
function feed(stream: { push(source: string): unknown }, source: string, size: number): void {
  for (let index = size; index <= source.length + size; index += size) {
    stream.push(source.slice(0, Math.min(index, source.length)));
  }
}

describe("StringFieldStream —— 增量字段解码", () => {
  const raw = JSON.stringify({ path: "src/a.ts", content: "line1\nline2\n中" });

  test("任意分片下解出的文本与一次性解码一致", () => {
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const stream = new StringFieldStream("path");
      feed(stream, raw, size);
      expect(stream.text, `size=${size}`).toBe("src/a.ts");
      expect(stream.complete).toBe(true);
    }
  });

  test("转义序列被切开也不丢字符", () => {
    const source = JSON.stringify({ content: "a\nb\u4e2d\\c" });
    for (const size of [1, 2, 3, 5, 8]) {
      const stream = new StringFieldStream("content");
      feed(stream, source, size);
      expect(stream.text, `size=${size}`).toBe("a\nb中\\c");
    }
  });

  test("值还没收尾时给到已经确定的前缀，且 complete 为 false", () => {
    const stream = new StringFieldStream("path");
    stream.push('{"path":"src/very');
    expect(stream.text).toBe("src/very");
    expect(stream.complete).toBe(false);
  });

  test("字段还没出现时返回空串（不抛错、不猜）", () => {
    const stream = new StringFieldStream("path");
    expect(stream.push('{"content":"x')).toBe("");
    expect(stream.push("")).toBe("");
  });

  test("收尾后不再重复解码（再 push 也是同一个结果）", () => {
    const stream = new StringFieldStream("path");
    stream.push('{"path":"a.ts","content":"x');
    expect(stream.complete).toBe(true);
    expect(stream.push('{"path":"a.ts","content":"xxxx')).toBe("a.ts");
  });

  test("大字段按小块推进是线性的（不是每个 delta 重解整段）", () => {
    const content = "x".repeat(200_000);
    const source = `{"content":"${content}`;
    const stream = new StringFieldStream("content");
    const started = Bun.nanoseconds();
    for (let index = 10; index <= source.length; index += 10) stream.push(source.slice(0, index));
    stream.push(source);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    expect(stream.text.length).toBe(content.length);
    // O(长度²) 的实现会在这里跑上几分钟；O(长度) 是毫秒级。给足余量。
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("FileStreamProgress —— write/edit 的实时路径与行数", () => {
  test("isFileToolName 只认这两个工具", () => {
    expect(isFileToolName("write_file")).toBe(true);
    expect(isFileToolName("edit_file")).toBe(true);
    expect(isFileToolName("read_file")).toBe(false);
    expect(isFileToolName("apply_patch")).toBe(false);
  });

  test("write_file：路径先到，+N 随 content 增长，-M 流式阶段不给", () => {
    const stream = new FileStreamProgress("write_file");
    const steps = [
      '{"path":"src/a.ts"',
      '{"path":"src/a.ts","content":"one',
      '{"path":"src/a.ts","content":"one\\ntwo',
      '{"path":"src/a.ts","content":"one\\ntwo\\nthree',
    ];

    expect(stream.push(steps[0]!).path).toBe("src/a.ts");
    expect(stream.push(steps[1]!)).toMatchObject({ added: 1, removed: 0 });
    expect(stream.push(steps[2]!)).toMatchObject({ added: 2, removed: 0 });
    expect(stream.push(steps[3]!)).toMatchObject({ added: 3, removed: 0 });
    expect(stream.current().complete).toBe(false);
    expect(stream.finish().complete).toBe(true);
  });

  test("edit_file：-M 来自 old_string（先到齐），+N 随 new_string 增长", () => {
    const stream = new FileStreamProgress("edit_file");
    const steps = [
      '{"path":"src/a.ts","old_string":"a\\nb\\nc"',
      '{"path":"src/a.ts","old_string":"a\\nb\\nc","new_string":"x',
      '{"path":"src/a.ts","old_string":"a\\nb\\nc","new_string":"x\\ny',
    ];

    expect(stream.push(steps[0]!)).toMatchObject({ path: "src/a.ts", added: 0, removed: 3 });
    expect(stream.push(steps[1]!)).toMatchObject({ added: 1, removed: 3 });
    expect(stream.push(steps[2]!)).toMatchObject({ added: 2, removed: 3 });
  });

  test("任意分片下最终数字一致（provider 怎么切都不影响）", () => {
    const raw = JSON.stringify({ path: "src/a.ts", content: "one\ntwo\nthree" });
    for (const size of [1, 3, 8, 64]) {
      const stream = new FileStreamProgress("write_file");
      feed(stream as unknown as { push(source: string): unknown }, raw, size);
      expect(stream.current(), `size=${size}`).toMatchObject({
        path: "src/a.ts",
        added: 3,
        removed: 0,
      });
    }
  });

  test("行数口径与工具一致：尾随换行也算一行", () => {
    const stream = new FileStreamProgress("write_file");
    stream.push(JSON.stringify({ path: "a", content: "one\ntwo\n" }));
    // "one\ntwo\n".split("\n") = 3 —— 与 write_file 的 summary 和 diffLines 同口径
    expect(stream.current().added).toBe(3);
  });

  test("没有 path / content 时给空进度，不抛错", () => {
    const stream = new FileStreamProgress("write_file");
    expect(stream.push("")).toEqual({ added: 0, removed: 0, complete: false });
    expect(stream.push('{"other":')).toEqual({ added: 0, removed: 0, complete: false });
  });
});
