/**
 * 工具展示元数据。
 *
 * 只服务 TUI / WebUI，不进入模型上下文。工具的真实输出仍是 ToolExecution.output；
 * 这里保存的是“这段文本属于什么语义”，避免 UI 去解析格式字符串。
 *
 * 两种用法：
 *   - `bash`：把 stdout/stderr/exit code 分开，UI 不必再认 `--- stderr ---`；
 *   - `file`：给出规范化的展示路径与增删行数 / 读取窗口，UI 不必从输出头反解。
 *
 * **不落库**：`--resume` 重建的卡片没有这份元数据，渲染层必须保留"从输出文本
 * 反解"的回退路径（`parseBashPresentation` / `parseReadHeader` / `parseDiffStat`）。
 * 有自报就用自报，没有才反解 —— 两条路必须给出同一个答案，所以行数口径共用
 * `diffStat` / `diffLines`。
 */

export type ToolPresentationKind = "bash" | "file";

export type ToolOutputSegmentKind = "stdout" | "stderr" | "meta";

export interface ToolOutputSegment {
  kind: ToolOutputSegmentKind;
  text: string;
}

export interface BashPresentation {
  kind: "bash";
  command: string;
  segments: readonly ToolOutputSegment[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

/** 文件工具的展示元数据。 */
export interface FilePresentation {
  kind: "file";
  /** 已经规范化过的展示路径：工作区内=相对路径，区外=绝对路径（`relativeTo`）。 */
  path: string;
  /** write_file / edit_file：增删行数（口径与 `diffStat` 一致）。 */
  added?: number;
  removed?: number;
  /** read_file：实际读到的行号窗口，如 `1-500`。 */
  range?: string;
}

export type ToolPresentation = BashPresentation | FilePresentation;
