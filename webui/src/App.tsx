import { useState } from "react";
import { useUiStore } from "./state/store";
import { actions, connectBridge } from "./bridge";
import { PermissionCard } from "./components/PermissionCard";
import { Transcript } from "./components/Transcript";

const TOKEN_KEY = "bugent.webui.token";

const CONN_LABEL: Record<string, { text: string; className: string }> = {
  idle: { text: "未连接", className: "bg-neutral-700" },
  connecting: { text: "连接中", className: "bg-amber-500 animate-pulse" },
  reconnecting: { text: "重连中", className: "bg-amber-500 animate-pulse" },
  live: { text: "已连接", className: "bg-emerald-500" },
  offline: { text: "离线", className: "bg-rose-500" },
};

function TokenGate({ onConnect }: { onConnect: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length === 0) return;
          onConnect(value.trim());
        }}
        className="w-90 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-6"
      >
        <h1 className="text-lg font-semibold text-neutral-100">连接 bugent bridge</h1>
        <p className="mt-1 text-sm text-neutral-500">
          token 在 bridge 启动时的 stdout / <code className="text-neutral-400">~/.bugent/webui/&lt;port&gt;.token</code>
        </p>
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="bridge token"
          autoFocus
          className="mt-4 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-lg bg-sky-600 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          连接
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const conn = useUiStore((s) => s.conn);
  const connNote = useUiStore((s) => s.connNote);
  const activeId = useUiStore((s) => s.activeId);
  const session = useUiStore((s) => (s.activeId === undefined ? undefined : s.sessions[s.activeId]));
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  if (token === null) {
    return (
      <TokenGate
        onConnect={(value) => {
          localStorage.setItem(TOKEN_KEY, value);
          setToken(value);
          connectBridge(value);
        }}
      />
    );
  }

  const badge = CONN_LABEL[conn] ?? CONN_LABEL.idle!;
  const goal = session?.goal ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2.5">
        <span className="font-semibold text-neutral-100">bugent</span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-400">
          <span className={`size-2 rounded-full ${badge.className}`} />
          {badge.text}
          {connNote !== undefined && <span className="text-rose-400">· {connNote}</span>}
        </span>
        {session?.mode !== undefined && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-400">{session.mode}</span>
        )}
        {goal !== null && (
          <span className="text-xs text-neutral-500">
            goal · {goal.status} · {Math.round(goal.tokensUsed / 1000)}K / {Math.round(goal.tokenBudget / 1000)}K
          </span>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken(null);
              location.reload();
            }}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            换 token
          </button>
        </div>
      </header>

      {activeId === undefined || session === undefined ? (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
          {conn === "live" ? "正在进入会话…" : "等待连接…"}
        </div>
      ) : (
        <>
          <Transcript blocks={session.blocks} turnActive={session.turnActive} />
          {session.pending.length > 0 && (
            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="flex flex-col gap-2">
                {session.pending.map((pending) => (
                  <PermissionCard key={pending.requestId} pending={pending} />
                ))}
              </div>
            </div>
          )}
          <footer className="border-t border-neutral-800 px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (draft.trim().length === 0 || session.turnActive) return;
                    actions.send(draft);
                    setDraft("");
                  }
                }}
                rows={Math.min(4, Math.max(1, draft.split("\n").length))}
                placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                className="flex-1 resize-none rounded-xl border border-neutral-700 bg-neutral-900 px-3.5 py-2.5 text-[15px] outline-none focus:border-sky-500"
              />
              {session.turnActive ? (
                <button
                  type="button"
                  onClick={() => actions.cancel()}
                  className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-rose-500"
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (draft.trim().length === 0) return;
                    actions.send(draft);
                    setDraft("");
                  }}
                  className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500"
                >
                  发送
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
