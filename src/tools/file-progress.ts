/**
 * write_file / edit_file 的**参数流式进度**。
 *
 * 目的：模型还在吐参数时，卡片头上就能显示"要写哪个文件、改了多少行"，而不是
 * 先给用户看一坨 JSON、等执行完才变成 diff。
 *
 * 三个字段各自的来源：
 *   - `path`：`{"path":"…"}` 一收尾就有；
 *   - `added`：write_file 数 `content` 的行数，edit_file 数 `new_string` 的行数；
 *   - `removed`：edit_file 数 `old_string` 的行数（它在 `new_string` 之前到齐）。
 *
 * write_file 的 `removed` 流式阶段**不给**：那是磁盘上旧文件的行数，要读一次盘
 * 才知道。为了一个还在长的徽标去读盘不值得 —— 它会在工具跑完后由结果里的真实
 * 统计补上（`parseDiffStat`）。
 *
 * 行数口径与工具自己一致：`split("\n").length`。工具的新建文件分支和
 * `diffLines` 都按这个口径产 `+` 行，所以流式阶段涨到的数字就是最终徽标的数字，
 * 不会出现"流到 3 行、跑完变 4 行"的跳变。
 */

import { StringFieldStream } from "../core/partial-json.ts";

export type FileToolName = "write_file" | "edit_file";

/** 这两个工具的入参是"整文件内容 / 精确替换"，参数流式阶段就能估出行数。 */
export function isFileToolName(name: string): name is FileToolName {
  return name === "write_file" || name === "edit_file";
}

export interface FileArgsProgress {
  /** 目标路径（模型写的原样，可能还没收尾）。 */
  path?: string;
  added: number;
  removed: number;
  /** 参数是否已经收尾（收尾后数字就是最终值）。 */
  complete: boolean;
}

/** `"a\nb"` -> 2、`"a\nb\n"` -> 3（与工具/`diffLines` 的口径一致）。 */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export class FileStreamProgress {
  readonly tool: FileToolName;

  #path = new StringFieldStream("path");
  #addedField: StringFieldStream;
  #removedField: StringFieldStream | undefined;
  #complete = false;

  constructor(tool: FileToolName) {
    this.tool = tool;
    // write_file: content；edit_file: new_string
    this.#addedField = new StringFieldStream(tool === "write_file" ? "content" : "new_string");
    if (tool === "edit_file") this.#removedField = new StringFieldStream("old_string");
  }

  /** 推进一次（`rawArgs` 是**累积**的原始参数，只增不改）。 */
  push(rawArgs: string): FileArgsProgress {
    this.#path.push(rawArgs);
    this.#addedField.push(rawArgs);
    this.#removedField?.push(rawArgs);
    return this.current();
  }

  /** 参数收尾：数字定型。 */
  finish(): FileArgsProgress {
    this.#complete = true;
    return this.current();
  }

  current(): FileArgsProgress {
    const path = this.#path.text;
    return {
      ...(path.length > 0 ? { path } : {}),
      added: countLines(this.#addedField.text),
      removed: this.#removedField === undefined ? 0 : countLines(this.#removedField.text),
      complete: this.#complete,
    };
  }
}
