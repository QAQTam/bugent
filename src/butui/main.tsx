/**
 * bugent × buTUI experimental entry.
 *
 * Minimal working state:
 *   real config -> real session -> real tools -> streamed assistant text.
 *
 * The legacy `src/tui` remains the default UI. This entry only proves the
 * bridge and keeps the terminal lifecycle isolated.
 */

import { Button, Diff, Input, Modal, StreamWindow, createTextEditor } from "@butui/components";
import { createTuiApp, type TuiApp } from "@butui/runtime";
import {
  createDiffStream,
  type DiffLine,
  type DiffStream,
  type StreamWindowController,
} from "@butui/stream";
import { For, Show, createSignal, flush } from "solid-js";
import { resolve } from "node:path";
import type { CapabilityEscalation } from "../tools/types.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import { APPLY_PATCH_TOOL_NAME } from "../tools/apply-patch.ts";
import { PatchStreamProgress } from "../patch/streaming-progress.ts";
import type { Hunk } from "../patch/types.ts";
import { createBugentTranscript } from "./transcript.ts";
import {
  createBugentButuiRuntime,
  type BugentButuiInteraction,
} from "./bridge.ts";

interface ToolCard {
  id: string;
  name: string;
  status: "streaming" | "running" | "done" | "error";
  summary: string;
  output: string;
  progress?: { added: number; removed: number };
  diff?: DiffStream;
}

type PendingPrompt =
  | { kind: "permission"; request: PermissionRequest; resolve: (allow: boolean) => void }
  | {
      kind: "mode";
      request: PermissionRequest;
      needed: SandboxMode;
      resolve: (allow: boolean) => void;
    }
  | {
      kind: "capability";
      escalation: CapabilityEscalation;
      resolve: (allow: boolean) => void;
    };

const cwd = process.env.BUGENT_BUTUI_CWD ?? resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const useMock = args.includes("--mock");
const skipConfirmations = args.includes("--yes");
const experimentalRuntime = process.env.BUGENT_BUTUI_V02 !== "0";

const [toolCards, setToolCards] = createSignal<ToolCard[]>([]);
const [busy, setBusy] = createSignal(false);
const [status, setStatus] = createSignal("starting");
const [prompt, setPrompt] = createSignal<PendingPrompt>();
const promptQueue: PendingPrompt[] = [];
const patchStreams = new Map<string, PatchStreamProgress>();
let currentAbort: AbortController | undefined;
let transcriptController: StreamWindowController | undefined;
let app: TuiApp | undefined;

function enqueuePrompt(next: PendingPrompt): void {
  promptQueue.push(next);
  if (prompt() === undefined) setPrompt(promptQueue[0]);
}

function settlePrompt(allow: boolean): void {
  const current = prompt();
  if (current === undefined) return;
  current.resolve(allow);
  promptQueue.shift();
  setPrompt(promptQueue[0]);
}

const interaction: BugentButuiInteraction = {
  askPermission: request =>
    new Promise(resolve => enqueuePrompt({ kind: "permission", request, resolve })),
  confirmModeChange: (request, needed) =>
    new Promise(resolve => enqueuePrompt({ kind: "mode", request, needed, resolve })),
  requestCapability: escalation =>
    new Promise(resolve => enqueuePrompt({ kind: "capability", escalation, resolve })),
};

const agentRuntime = await createBugentButuiRuntime({
  cwd,
  mock: useMock,
  yes: skipConfirmations,
  interaction,
});
const transcript = createBugentTranscript({ sessionId: agentRuntime.session.id });
transcript.appendBlock("buTUI 实验入口：真实 bugent session / tools / 权限桥接。");
setStatus(`${agentRuntime.providerId}/${agentRuntime.model} · ready`);

function append(text: string): void {
  transcript.appendBlock(text);
  syncPaint();
}

function updateToolCard(id: string, update: Partial<ToolCard>): void {
  setToolCards(previous => {
    const index = previous.findIndex(card => card.id === id);
    if (index < 0) {
      if (update.name === undefined) return previous;
      return [
        ...previous,
        {
          id,
          name: update.name,
          status: update.status ?? "streaming",
          summary: update.summary ?? "",
          output: update.output ?? "",
          ...(update.progress !== undefined ? { progress: update.progress } : {}),
          ...(update.diff !== undefined ? { diff: update.diff } : {}),
        },
      ];
    }
    return previous.map((card, cardIndex) =>
      cardIndex === index ? { ...card, ...update } : card
    );
  });
}

function appendDiffLines(
  diff: DiffStream,
  hunks: readonly Hunk[],
  stable: boolean,
): void {
  const lines: DiffLine[] = [];
  let sequence = 0;
  const nextId = (): string => `patch-${sequence++}`;

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      lines.push({ id: nextId(), kind: "file", text: `A ${hunk.path}`, stable });
      for (const text of hunk.contents.replace(/\n$/, "").split("\n")) {
        if (text.length > 0) lines.push({ id: nextId(), kind: "add", text, stable });
      }
      continue;
    }
    if (hunk.type === "delete") {
      lines.push({ id: nextId(), kind: "file", text: `D ${hunk.path}`, stable });
      continue;
    }

    lines.push({
      id: nextId(),
      kind: "file",
      text: `${hunk.movePath === undefined ? "M" : "R"} ${hunk.path}${
        hunk.movePath === undefined ? "" : ` → ${hunk.movePath}`
      }`,
      stable,
    });
    for (const chunk of hunk.chunks) {
      lines.push({
        id: nextId(),
        kind: "hunk",
        text: chunk.changeContext === undefined ? "@@" : `@@ ${chunk.changeContext}`,
        stable,
      });
      let prefix = 0;
      while (
        prefix < chunk.oldLines.length &&
        prefix < chunk.newLines.length &&
        chunk.oldLines[prefix] === chunk.newLines[prefix]
      ) {
        prefix += 1;
      }
      let suffix = 0;
      while (
        suffix < chunk.oldLines.length - prefix &&
        suffix < chunk.newLines.length - prefix &&
        chunk.oldLines[chunk.oldLines.length - 1 - suffix] ===
          chunk.newLines[chunk.newLines.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      for (const text of chunk.oldLines.slice(0, prefix)) {
        lines.push({ id: nextId(), kind: "context", text, stable });
      }
      for (const text of chunk.oldLines.slice(prefix, chunk.oldLines.length - suffix)) {
        lines.push({ id: nextId(), kind: "remove", text, stable });
      }
      for (const text of chunk.newLines.slice(prefix, chunk.newLines.length - suffix)) {
        lines.push({ id: nextId(), kind: "add", text, stable });
      }
      if (suffix > 0) {
        for (const text of chunk.oldLines.slice(chunk.oldLines.length - suffix)) {
          lines.push({ id: nextId(), kind: "context", text, stable });
        }
      }
      if (chunk.isEndOfFile) {
        lines.push({ id: nextId(), kind: "meta", text: "*** End of File", stable });
      }
    }
  }
  diff.upsert(lines);
  if (stable) diff.flush();
}

function syncPaint(): void {
  flush();
  app?.requestPaint();
}

function formatArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function formatOutput(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

async function submit(value: string): Promise<void> {
  const text = value.trim();
  if (text.length === 0) return;
  if (busy()) {
    append("当前 turn 还在运行；按 Esc 可取消。");
    return;
  }

  append(`› ${text}`);
  setToolCards([]);
  setBusy(true);
  setStatus("thinking…");

  const controller = new AbortController();
  currentAbort = controller;
  try {
    await agentRuntime.run(
      text,
      {
        onText: delta => {
          transcript.appendDelta(delta);
          syncPaint();
        },
        onReasoning: () => {
          setStatus("thinking…");
          syncPaint();
        },
        onToolCallDelta: delta => {
          if (delta.reset === true) {
            patchStreams.clear();
            setToolCards([]);
            return;
          }
          if (delta.name !== APPLY_PATCH_TOOL_NAME) return;
          let stream = patchStreams.get(delta.id);
          if (stream === undefined) {
            stream = new PatchStreamProgress();
            patchStreams.set(delta.id, stream);
          }
          const progress = stream.push(delta.rawArgs);
          if (progress === undefined) return;
          let diff = toolCards().find(card => card.id === delta.id)?.diff;
          if (diff === undefined) {
            diff = createDiffStream({ id: `patch-${delta.id}`, language: "diff" });
          }
          appendDiffLines(diff, stream.hunks(), false);
          updateToolCard(delta.id, {
            name: APPLY_PATCH_TOOL_NAME,
            status: "streaming",
            summary: `${progress.files.length} files`,
            progress: { added: progress.added, removed: progress.removed },
            diff,
          });
          syncPaint();
        },
        onToolCall: call => {
          if (call.name !== APPLY_PATCH_TOOL_NAME) {
            append(`⚙ ${call.name} ${formatArgs(call.args)}`);
            return;
          }
          const stream = patchStreams.get(call.id);
          let diff = toolCards().find(card => card.id === call.id)?.diff;
          if (diff === undefined) {
            diff = createDiffStream({ id: `patch-${call.id}`, language: "diff" });
          }
          if (stream !== undefined) {
            try {
              const progress = stream.finish();
              appendDiffLines(diff, stream.hunks(), true);
              updateToolCard(call.id, {
                name: call.name,
                status: "running",
                summary: `${progress.files.length} files`,
                progress: { added: progress.added, removed: progress.removed },
                diff,
              });
            } catch {
              updateToolCard(call.id, {
                name: call.name,
                status: "running",
                summary: "invalid patch",
                diff,
              });
            }
            patchStreams.delete(call.id);
          } else {
            updateToolCard(call.id, {
              name: call.name,
              status: "running",
              summary: formatArgs(call.args),
              diff,
            });
          }
          syncPaint();
        },
        onToolResult: (call, result) => {
          if (call.name === APPLY_PATCH_TOOL_NAME) {
            updateToolCard(call.id, {
              status: result.ok ? "done" : "error",
              output: formatOutput(result.output),
            });
          } else {
            append(`${result.ok ? "✓" : "✗"} ${formatOutput(result.output)}`);
          }
          syncPaint();
        },
        onUsage: usage => {
          setStatus(
            `tokens in=${usage.input} out=${usage.output}${
              usage.cached !== undefined ? ` cached=${usage.cached}` : ""
            }`,
          );
          syncPaint();
        },
      },
      controller.signal,
    );
    append("turn complete");
    setStatus("ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(message);
    setStatus("error");
  } finally {
    currentAbort = undefined;
    setBusy(false);
    await transcript.flush().catch(() => {});
    syncPaint();
    await app?.waitUntilFrameFlushed(undefined, "accepted").catch(() => {});
  }
}

const editor = createTextEditor({
  onSubmit: value => {
    void submit(value);
  },
});

function promptTitle(current: PendingPrompt): string {
  if (current.kind === "permission") return "权限确认";
  if (current.kind === "mode") return "需要临时升档";
  return "网络授权";
}

function promptBody(current: PendingPrompt): string {
  if (current.kind === "permission") return current.request.summary;
  if (current.kind === "mode") {
    return `${current.request.summary}\n需要：${current.needed}`;
  }
  return `${current.escalation.reason}${
    current.escalation.details !== undefined ? `\n${current.escalation.details.join("\n")}` : ""
  }`;
}

function promptTone(current: PendingPrompt): "warning" | "danger" | "accent" {
  if (current.kind === "permission") return "warning";
  if (current.kind === "mode") return "danger";
  return "accent";
}

function allowTone(current: PendingPrompt): "success" | "warning" | "danger" {
  if (current.kind === "mode") return "danger";
  return "success";
}

const createdApp = createTuiApp({
  view: tui => {
    const width = Math.max(24, tui.size().columns);
    return (
      <>
        <box width={width}>
        <box border padding={1} width={width} gap={1}>
          <row justify="between" width={Math.max(20, width - 4)}>
            <text color="accent" bold>
              bugent · buTUI experiment
            </text>
            <text color="muted">
              {tui.size().columns}×{tui.size().rows}
            </text>
          </row>
          <text color="muted">
            {runtimeProviderLabel()} · {runtimeTuningLabel()} · {status()}
          </text>
        </box>

        <box border padding={1} width={width} gap={1}>
          <StreamWindow
            ledger={transcript.ledger}
            streamId={transcript.streamId}
            height={Math.max(5, tui.size().rows - 15 - Math.min(2, toolCards().length) * 7)}
            width={Math.max(20, width - 4)}
            follow
            revision={transcript.revision}
            scrollbar
            onController={controller => {
              transcriptController = controller;
            }}
          />
          <Show when={toolCards().length > 0}>
            <box gap={1}>
              <For each={toolCards().slice(-2)}>
                {card => (
                  <box
                    border
                    borderColor={
                      card.status === "error"
                        ? "danger"
                        : card.status === "done"
                          ? "success"
                          : "warning"
                    }
                    padding={[0, 1]}
                    width={Math.max(20, width - 4)}
                    gap={0}
                  >
                    <row justify="between" width={Math.max(16, width - 8)}>
                      <text color="accent" bold>
                        ⚙ {card.name} · {card.status}
                      </text>
                      <text color="muted">
                        {card.progress === undefined
                          ? ""
                          : `+${card.progress.added} -${card.progress.removed}`}
                      </text>
                    </row>
                    <Show
                      when={card.diff}
                      fallback={<text color="muted">{card.summary}</text>}
                    >
                      {diff => (
                        <Diff
                          source={diff()}
                          height={6}
                          follow
                          scrollbar
                          semantic={`tool-diff:${card.id}`}
                        />
                      )}
                    </Show>
                    <Show when={card.output.length > 0}>
                      <text color={card.status === "error" ? "danger" : "muted"}>
                        {card.output}
                      </text>
                    </Show>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </box>

        <box
          border
          padding={[0, 1]}
          width={width}
          borderColor={prompt() === undefined ? "focus" : "muted"}
        >
          <row gap={1}>
            <text color="accent" bold>
              ›
            </text>
            <Input
              editor={editor}
              width={Math.max(16, width - 8)}
              placeholder={busy() ? "运行中，Esc 取消" : "输入一句，Enter 发送"}
              autoFocus
            />
          </row>
        </box>

        <text color="muted">
          {" "}
          {busy() ? "running" : "ready"} · ctrl+c 退出 · {agentRuntime.mode}
        </text>
      </box>
      <Show when={prompt()}>
        {current => (
          <Modal
            open
            title={promptTitle(current())}
            width={Math.min(72, Math.max(36, width - 6))}
            tone={promptTone(current())}
            onDismiss={() => settlePrompt(false)}
            semantic="bugent-prompt"
          >
            <box gap={1}>
              <text>{promptBody(current())}</text>
              <text color="muted">键盘 y / n 同样可用</text>
              <row gap={2} justify="end">
                <Button
                  tone={allowTone(current())}
                  autoFocus
                  semantic="bugent-prompt:allow"
                  onPress={() => settlePrompt(true)}
                >
                  同意（y）
                </Button>
                <Button
                  tone="danger"
                  semantic="bugent-prompt:deny"
                  onPress={() => settlePrompt(false)}
                >
                  拒绝（n / Esc）
                </Button>
              </row>
            </box>
          </Modal>
        )}
      </Show>
      </>
    );
  },
  stickyBottom: 4,
  ...(experimentalRuntime
    ? {
        render: { mode: "frame" as const, fps: 120, adaptiveQuality: true },
        inputRouting: "presented" as const,
      }
    : {}),
  mouseMotion: "drag",
  mousePointer: true,
  selection: true,
  quitOnCtrlC: true,
  onKey: event => {
    const current = prompt();
    if (current !== undefined) {
      if (event.name === "y") {
        settlePrompt(true);
        return true;
      }
      if (event.name === "n" || event.name === "escape") {
        settlePrompt(false);
        return true;
      }
      return true;
    }
    if (event.name === "escape" && busy()) {
      currentAbort?.abort();
      return true;
    }
    if (event.name === "pageup" || event.name === "pagedown") {
      if (transcriptController === undefined) return false;
      void transcriptController
        .pageBy(event.name === "pageup" ? -1 : 1)
        .catch(() => {});
      return true;
    }
    return false;
  },
});

function runtimeProviderLabel(): string {
  return `${agentRuntime.providerId}/${agentRuntime.model}`;
}

function runtimeTuningLabel(): string {
  return experimentalRuntime ? "v0.2 frame+presented" : "v0.1 microtask+logical";
}

app = createdApp;
