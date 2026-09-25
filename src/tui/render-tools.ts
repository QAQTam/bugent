/**
 * 内置工具的折叠渲染。
 *
 * 设计目标：**工具输出可能极长，屏幕只给固定的几行**。
 *
 *   bash        最多 5 行：头 2 + 「已忽略 N 行」+ 尾 2
 *   read_file   头 3 + 「已忽略 N 行」+ 尾 3
 *   write/edit  同上，但内容是 diff（+/- 着色）
 *
 * 运行中的 bash 另走一条路：显示最新 6 行进度（对应
 * Transcript.TOOL_PROGRESS_LINES），让用户看到"现在跑到哪了"。
 */

import { BOLD, DIM, RESET, fg, renderPlain } from "./markdown.ts";
import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { ToolItem } from "./renderers.ts";
import type { BashPresentation, ToolOutputSegment } from "../core/presentation.ts";
import { parseDiffStat, type DiffStat } from "../tools/diff.ts";
import { highlightCode } from "./highlight.ts";

/** 折叠规格：头几行 + 尾几行。 */
export const FOLD_SPEC = {
  bash: { head: 2, tail: 2 },
  file: { head: 3, tail: 3 },
} as const;

/** diff 默认展示的最大行数（超出走"点击展开"）。 */
export const DIFF_DISPLAY_LINES = 14;

function argsSummary(item: ToolItem): string {
  const args = item.args as Record<string, unknown> | null;
  if (args === null || typeof args !== "object") return "";

  const command = args.command;
  if (typeof command === "string") return command;

  const path = args.path;
  if (typeof path === "string") return path;

  const patch = args.patch;
  if (typeof patch === "string") {
    const operations = patch.match(/^\*\*\* (?:Add|Delete|Update) File: /gm)?.length ?? 0;
    return operations > 0 ? `${operations} 个文件` : "patch";
  }

  // ask_user：显示题数比显示一整坨 JSON 有意义得多
   const questions = args.questions;
  if (Array.isArray(questions)) return `${questions.length} 题`;

  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/**
 * 头部行：`⏺ 工具名 摘要`，可选在**右侧右对齐**一个徽标（如 `+12 -3`）。
 *
 * 右对齐要 ANSI 感知：徽标的可见宽度用 visibleWidth 算，
 * 而不是字符串长度 —— 否则带颜色的 `+12 -3` 会把间隔算错。
 * 窄屏时先压缩摘要，摘要压到 0 就直接不要它，保证徽标不被挤掉。
 *
 * 返回值**保证**不超过 width：宽度不够时先砍左边，实在不行才砍徽标本身。
 * 早先这里用 `Math.max(1, …)` 兜间隔，左边一长整行就超出终端宽度，
 * 被屏幕层硬截断 —— 截掉的恰好是行尾的徽标，也就是这行最该看见的东西。
 */
function header(item: ToolItem, width: number, marker: string, color: string, badge = ""): string {
  const badgeWidth = visibleWidth(badge);
  // 徽标比整行还宽：没有别的选择，只能砍徽标。
  if (badgeWidth >= width) return truncateAnsi(badge, width);

  const reserved = badgeWidth > 0 ? badgeWidth + 1 : 0; // 徽标 + 至少 1 格间隔

  const nameWidth = visibleWidth(item.name);
  const summaryBudget = Math.max(0, width - reserved - nameWidth - 4);
  const summary = argsSummary(item);

  const left =
    `${fg(color)}${marker}${RESET} ${BOLD}${item.name}${RESET}` +
    (summary.length > 0 && summaryBudget > 0
      ? ` ${DIM}${truncateAnsi(summary, summaryBudget)}${RESET}`
      : "");

  if (badgeWidth === 0) return truncateAnsi(left, width);

  const gap = width - visibleWidth(left) - badgeWidth;
  if (gap >= 1) return `${left}${" ".repeat(gap)}${badge}`;

  // 左边太长：砍左边保住徽标。徽标是这行要传达的信息，摘要不是。
  return `${truncateAnsi(left, width - badgeWidth - 1)} ${badge}`;
}

/** bash 头部单独走语法高亮：命令参数不是普通字符串，而是 shell 代码。 */
function bashHeader(item: ToolItem, width: number): string {
  const command = argsSummary(item).replace(/\s+/g, " ").trim();
  const left = `${fg(COLOR.tool)}⏺${RESET} ${BOLD}bash${RESET}`;
  if (command.length === 0) return left;

  const budget = Math.max(1, width - visibleWidth(left) - 1);
  return `${left} ${truncateAnsi(highlightCode(command, "bash"), budget)}`;
}

export type BashLineTone = "normal" | "error" | "warn" | "success" | "path" | "url" | "meta";

const ERROR_PATTERN =
  /\b(error|failed|failure|fatal|panic|exception|traceback|assertionerror)\b|失败|错误|异常|致命/i;
const WARN_PATTERN = /\b(warn(?:ing)?|deprecated|deprecation)\b|警告|弃用/i;
const SUCCESS_PATTERN = /\b(pass(?:ed)?|success(?:ful)?|ok|done|completed)\b|成功|通过|完成/i;
const URL_PATTERN = /https?:\/\/[^\s]+/i;
const PATH_PATTERN =
  /(?:^|\s)(?:\.{0,2}\/|\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s:]+(?::\d+)?(?::\d+)?/;

/**
 * 输出行的语义分类。
 *
 * 这是轻量、确定性的启发式，不是 AST：bash 输出本身没有语法保证，
 * 但 error / warning / success / path 这类信息足够稳定，能显著改善可读性。
 */
export function classifyBashLine(line: string, stream: "stdout" | "stderr" = "stdout"): BashLineTone {
  if (line.length === 0) return "normal";
  if (WARN_PATTERN.test(line)) return "warn";
  if (ERROR_PATTERN.test(line)) return "error";
  if (SUCCESS_PATTERN.test(line)) return "success";
  if (URL_PATTERN.test(line)) return "url";
  if (PATH_PATTERN.test(line)) return "path";
  return stream === "stderr" ? "error" : "normal";
}

function toneColor(tone: BashLineTone): string {
  switch (tone) {
    case "error":
      return COLOR.bashStderr;
    case "warn":
      return COLOR.bashWarn;
    case "success":
      return COLOR.bashSuccess;
    case "path":
      return COLOR.bashPath;
    case "url":
      return COLOR.bashUrl;
    case "meta":
      return COLOR.bashMeta;
    case "normal":
    default:
      return COLOR.bashStdout;
  }
}

function renderBashLine(line: string, stream: "stdout" | "stderr"): string {
  const tone = classifyBashLine(line, stream);
  return `${fg(toneColor(tone))}  ${line}${RESET}`;
}

/**
 * 从旧格式输出恢复展示信息。
 *
 * 当前运行会带 ToolPresentation；恢复历史 session 时没有这份元数据，
 * 但 bash 的 `--- stderr ---` 与 `[exit code: ...]` 是稳定格式，可以降级恢复。
 */
export function parseBashPresentation(output: string): BashPresentation {
  const segments: ToolOutputSegment[] = [];
  let stream: "stdout" | "stderr" = "stdout";
  let buffer: string[] = [];
  let exitCode: number | null = null;
  let timedOut = false;
  let aborted = false;
  let truncated = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    segments.push({ kind: stream, text: buffer.join("\n") });
    buffer = [];
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "--- stderr ---") {
      flush();
      stream = "stderr";
      continue;
    }

    const exit = /^\[exit code:\s*(.+?)\]$/.exec(trimmed);
    if (exit !== null) {
      flush();
      const raw = exit[1] ?? "";
      exitCode = /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
      continue;
    }

    if (trimmed.startsWith("[超时]")) {
      flush();
      timedOut = true;
      segments.push({ kind: "meta", text: line });
      continue;
    }
    if (trimmed.startsWith("[中断]")) {
      flush();
      aborted = true;
      segments.push({ kind: "meta", text: line });
      continue;
    }
    if (trimmed.startsWith("[输出超过")) {
      flush();
      truncated = true;
      segments.push({ kind: "meta", text: line });
      continue;
    }

    buffer.push(line);
  }
  flush();

  return {
    kind: "bash",
    command: "",
    segments,
    exitCode,
    timedOut,
    aborted,
    truncated,
  };
}

/**
 * 从**开头**截断，而不是头尾都留。
 *
 * diff 专用：头尾折叠会把改动（通常在中段）藏起来，只剩一堆没变的上下文 ——
 * 而且 `compactDiff` 已经裁过远处上下文了，这里再折一层纯属帮倒忙。
 * 所以只保留开头若干行，剩下的交给"点击展开"。
 */
function foldTail(lines: readonly string[], max: number, color: string, expanded = false): string[] {
  if (expanded || lines.length <= max) return [...lines];

  const shown = lines.slice(0, max - 1);
  const note = `${DIM}${fg(color)}  … 还有 ${lines.length - shown.length} 行（点击展开）${RESET}`;
  return [...shown, note];
}

/** `+12 -3` 徽标，带颜色。增删为 0 的部分不显示。 */
export function formatStatBadge(stat: DiffStat): string {
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`${fg(COLOR.diffAdd)}+${stat.added}${RESET}`);
  if (stat.removed > 0) parts.push(`${fg(COLOR.diffRemove)}-${stat.removed}${RESET}`);
  return parts.join(" ");
}

/** 折叠成「头 N 行 + 已忽略 M 行 + 尾 K 行」。展开状态下原样返回。 */
export function foldLines(
  lines: readonly string[],
  head: number,
  tail: number,
  color: string,
  expanded = false,
): string[] {
  if (expanded) return [...lines];
  if (lines.length <= head + tail + 1) return [...lines];

  const omitted = lines.length - head - tail;
  const note = `${DIM}${fg(color)}  … 已忽略 ${omitted} 行 …（点击展开）${RESET}`;
  return [...lines.slice(0, head), note, ...lines.slice(lines.length - tail)];
}

function bodyLines(text: string, width: number, color: string): string[] {
  return renderPlain(text, Math.max(1, width - 2)).map(
    (line) => `${DIM}${fg(color)}  ${line}${RESET}`,
  );
}

/* ------------------------------------------------------------------ */
/* bash                                                                */
/* ------------------------------------------------------------------ */

export function renderBashTool(item: ToolItem, width: number): string[] {
  const head = bashHeader(item, width);

  // 运行中：显示最新几行进度，按当前 stream 做基础语义着色。
  if (!item.done) {
    const progress = item.progress.length > 0 ? item.progress : "…";
    const stream = item.progressStream ?? "stdout";
    const lines = renderPlain(progress, Math.max(1, width - 2));
    return [head, ...lines.map((line) => renderBashLine(line, stream))];
  }

  const presentation =
    item.presentation?.kind === "bash" ? item.presentation : parseBashPresentation(item.output);

  // 非 bash 工具异常（权限拒绝、参数错误）没有结构化段，保持原来的错误外观。
  if (!item.ok && item.presentation === undefined) {
    const body = bodyLines(item.output, width, COLOR.error);
    return [head, ...foldLines(body, FOLD_SPEC.bash.head, FOLD_SPEC.bash.tail, COLOR.error, item.expanded)];
  }

  const lines: string[] = [];
  for (const segment of presentation.segments) {
    const segmentLines = renderPlain(segment.text, Math.max(1, width - 2));
    for (const line of segmentLines) {
      if (segment.kind === "meta") {
        lines.push(`${DIM}${fg(COLOR.bashMeta)}  ${line}${RESET}`);
      } else {
        lines.push(renderBashLine(line, segment.kind));
      }
    }
  }

  const exitCode = presentation.exitCode;
  const exitTone: BashLineTone =
    exitCode === 0 ? "success" : exitCode === null ? "warn" : "error";
  const exitLabel = exitCode === null ? "unknown" : String(exitCode);
  lines.push(`${fg(toneColor(exitTone))}  [exit code: ${exitLabel}]${RESET}`);

  return [
    head,
    ...foldLines(lines, FOLD_SPEC.bash.head, FOLD_SPEC.bash.tail, COLOR.tool, item.expanded),
  ];
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

export function renderReadFileTool(item: ToolItem, width: number): string[] {
  const head = header(item, width, "⏺", COLOR.tool);
  if (!item.done) return [head, `${DIM}  读取中…${RESET}`];

  const color = item.ok ? COLOR.toolOk : COLOR.error;
  const body = bodyLines(item.output, width, color);
  return [head, ...foldLines(body, FOLD_SPEC.file.head, FOLD_SPEC.file.tail, color, item.expanded)];
}

/** write_file / edit_file：按 diff 语义着色，右侧右对齐 +N -M。 */
export function renderDiffTool(item: ToolItem, width: number): string[] {
  // 统计从工具输出里反解 —— 不需要额外字段，也不会和模型看到的内容不一致
  const stat = item.done && item.ok ? parseDiffStat(item.output) : undefined;
  const head = header(item, width, "⏺", COLOR.tool, stat === undefined ? "" : formatStatBadge(stat));

  if (!item.done) return [head, `${DIM}  写入中…${RESET}`];

  const [summary, ...rest] = item.output.split("\n");
  const lines: string[] = [`${DIM}${summary ?? ""}${RESET}`];

  const colored = rest.map((line) => {
    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === "+") return `${fg(COLOR.diffAdd)}  +${text}${RESET}`;
    if (prefix === "-") return `${fg(COLOR.diffRemove)}  -${text}${RESET}`;
    return `${DIM}  ${line}${RESET}`;
  });

  return [
    head,
    ...lines,
    ...foldTail(colored, DIFF_DISPLAY_LINES, COLOR.tool, item.expanded),
  ];
}

function patchKindMarker(kind: "add" | "delete" | "update" | "move"): string {
  switch (kind) {
    case "add":
      return "A";
    case "delete":
      return "D";
    case "move":
      return "R";
    case "update":
    default:
      return "M";
  }
}

function patchKindColor(kind: "add" | "delete" | "update" | "move"): string {
  if (kind === "add") return COLOR.diffAdd;
  if (kind === "delete") return COLOR.diffRemove;
  return COLOR.tool;
}

/** apply_patch：参数流式阶段即显示文件与 +N -M，执行后显示操作清单。 */
export function renderApplyPatchTool(item: ToolItem, width: number): string[] {
  const progress = item.patchProgress;
  const stat =
    progress === undefined
      ? item.done && item.ok
        ? parseDiffStat(item.output)
        : undefined
      : { added: progress.added, removed: progress.removed };
  const head = header(item, width, "⏺", COLOR.tool, stat === undefined ? "" : formatStatBadge(stat));

  if (!item.done) {
    const lines = [head];
    if (progress === undefined || progress.files.length === 0) {
      lines.push(`${DIM}  构建补丁…${RESET}`);
      return lines;
    }
    for (const file of progress.files.slice(0, 4)) {
      const marker = patchKindMarker(file.kind);
      const rawPath =
        file.kind === "move" && file.destination !== undefined
          ? `${file.path} → ${file.destination}`
          : file.path;
      const badge = file.added > 0 || file.removed > 0 ? formatStatBadge(file) : "";
      const badgeWidth = visibleWidth(badge);
      // 前缀 = 两格缩进 + 标记 + 空格。路径按剩余预算截断，保证整行（含徽标）
      // 不超过 width —— 否则徽标会被屏幕层截掉，而这行最该看见的就是它。
      const pathBudget = Math.max(0, width - (2 + visibleWidth(marker) + 1) - (badgeWidth > 0 ? badgeWidth + 1 : 0));
      const path = truncateAnsi(rawPath, pathBudget);
      // 极窄终端（连前缀+徽标都放不下）兜底：宁可砍掉整行，也不返回超宽字符串。
      lines.push(
        truncateAnsi(
        `${fg(patchKindColor(file.kind))}  ${marker} ${path}${RESET}` +
            (badgeWidth > 0 ? ` ${DIM}${badge}${RESET}` : ""),
          width,
        ),
      );
    }
    if (progress.files.length > 4) {
      lines.push(`${DIM}  … 还有 ${progress.files.length - 4} 个文件${RESET}`);
    }
    return lines;
  }

  if (!item.ok) {
    const body = item.output.split("\n");
    return [head, ...foldLines(body, FOLD_SPEC.file.head, FOLD_SPEC.file.tail, COLOR.error, item.expanded)];
  }

  const [summary, ...operations] = item.output.split("\n");
  const colored = operations
    .filter((line) => line.length > 0)
    .map((line) => {
      const marker = line[0] ?? "?";
      const color = marker === "A" ? COLOR.diffAdd : marker === "D" ? COLOR.diffRemove : COLOR.tool;
      // 先拼成纯文本再按整行预算截断，最后上色 —— 否则 2 格缩进会顶破极窄终端
      return `${fg(color)}${truncateAnsi(`  ${line}`, width)}${RESET}`;
    });
  return [
    head,
    `${DIM}${truncateAnsi(summary ?? "", width)}${RESET}`,
    ...foldTail(colored, DIFF_DISPLAY_LINES, COLOR.tool, item.expanded),
  ];
}
