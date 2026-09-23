/**
 * 工具展示元数据。
 *
 * 只服务 TUI / WebUI，不进入模型上下文。工具的真实输出仍是 ToolExecution.output；
 * 这里保存的是“这段文本属于什么语义”，避免 UI 去解析格式字符串。
 */

export type ToolPresentationKind = "bash";
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

export type ToolPresentation = BashPresentation;
