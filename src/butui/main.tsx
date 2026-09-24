/**
 * bugent × buTUI experimental entry.
 *
 * Minimal working state:
 *   real config -> real session -> real tools -> streamed assistant text.
 *
 * The legacy `src/tui` remains the default UI. This entry only proves the
 * bridge and keeps the terminal lifecycle isolated.
 */

import { createTextEditor, Input } from "@butui/components";
import { createTuiApp, type TuiApp } from "@butui/runtime";
import { StreamText, createTextStream } from "@butui/stream";
import { For, Show, createSignal, flush } from "solid-js";
import { resolve } from "node:path";
import type { CapabilityEscalation } from "../tools/types.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import {
  createBugentButuiRuntime,
  type BugentButuiInteraction,
} from "./bridge.ts";

interface UiMessage {
  kind: "user" | "tool" | "notice" | "error";
  text: string;
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

const [messages, setMessages] = createSignal<UiMessage[]>([
  { kind: "notice", text: "buTUI 实验入口：真实 bugent session / tools / 权限桥接。" },
]);
const stream = createTextStream({ width: 80 });
const [busy, setBusy] = createSignal(false);
const [status, setStatus] = createSignal("starting");
const [prompt, setPrompt] = createSignal<PendingPrompt>();
const promptQueue: PendingPrompt[] = [];
let currentAbort: AbortController | undefined;
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
setStatus(`${agentRuntime.providerId}/${agentRuntime.model} · ready`);

function append(message: UiMessage): void {
  setMessages(previous => [...previous, message]);
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
    append({ kind: "notice", text: "当前 turn 还在运行；按 Esc 可取消。" });
    return;
  }

  append({ kind: "user", text: `› ${text}` });
  setBusy(true);
  setStatus("thinking…");

  const controller = new AbortController();
  currentAbort = controller;
  try {
    await agentRuntime.run(
      text,
      {
        onText: delta => {
          stream.push(delta);
          syncPaint();
        },
        onReasoning: () => {
          setStatus("thinking…");
          syncPaint();
        },
        onToolCall: call => {
          append({ kind: "tool", text: `⚙ ${call.name} ${formatArgs(call.args)}` });
          syncPaint();
        },
        onToolResult: (_call, result) => {
          append({
            kind: "tool",
            text: `${result.ok ? "✓" : "✗"} ${formatOutput(result.output)}`,
          });
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
    append({ kind: "notice", text: "turn complete" });
    syncPaint();
    setStatus("ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append({ kind: "error", text: message });
    setStatus("error");
    syncPaint();
  } finally {
    currentAbort = undefined;
    setBusy(false);
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

const createdApp = createTuiApp({
  view: tui => {
    const width = Math.max(24, tui.size().columns);
    return (
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
          <For each={messages()}>
            {message => (
              <text
                color={
                  message.kind === "error"
                    ? "danger"
                    : message.kind === "tool"
                      ? "muted"
                      : message.kind === "notice"
                        ? "warning"
                        : "fg"
                }
              >
                {message.text}
              </text>
            )}
          </For>
          <StreamText source={stream} />
        </box>

        <box
          border
          padding={[0, 1]}
          width={width}
          borderColor={prompt() !== undefined ? "warning" : "focus"}
        >
          <Show
            when={prompt()}
            fallback={
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
            }
          >
            {current => (
              <box gap={1}>
                <text color="warning" bold>
                  {promptTitle(current())}
                </text>
                <text>{promptBody(current())}</text>
                <text color="muted">y 同意 · n / Esc 拒绝</text>
              </box>
            )}
          </Show>
        </box>

        <text color="muted">
          {" "}
          {busy() ? "running" : "ready"} · ctrl+c 退出 · {agentRuntime.mode}
        </text>
      </box>
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
