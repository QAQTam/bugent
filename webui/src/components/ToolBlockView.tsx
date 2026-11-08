import type { UiBlock } from "../state/store";

const STATUS_BADGE = {
  running: { label: "运行中", className: "bg-sky-500/15 text-sky-300 animate-pulse" },
  done: { label: "完成", className: "bg-emerald-500/15 text-emerald-300" },
  error: { label: "失败", className: "bg-rose-500/15 text-rose-300" },
} as const;

export function ToolBlockView({ block }: { block: Extract<UiBlock, { kind: "tool" }> }) {
  const badge = STATUS_BADGE[block.status];
  const presentation = block.presentation;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-neutral-300">{block.name || "tool"}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${badge.className}`}>{badge.label}</span>
        {presentation?.kind === "bash" && presentation.exitCode !== null && (
          <span className="text-xs text-neutral-500">exit {presentation.exitCode}</span>
        )}
        {presentation?.kind === "file" && (
          <span className="font-mono text-xs text-neutral-500">{presentation.path}</span>
        )}
        {presentation?.kind === "file" && presentation.added !== undefined && (
          <span className="text-xs">
            <span className="text-emerald-400">+{presentation.added}</span>{" "}
            <span className="text-rose-400">-{presentation.removed ?? 0}</span>
          </span>
        )}
        {presentation?.kind === "file" && presentation.range !== undefined && (
          <span className="text-xs text-neutral-500">行 {presentation.range}</span>
        )}
      </div>

      {block.argsText.length > 0 && (
        <details className="border-t border-neutral-800 px-3 py-1.5">
          <summary className="cursor-pointer text-xs text-neutral-500">参数</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs text-neutral-400">
            {block.argsText}
          </pre>
        </details>
      )}

      {presentation?.kind === "bash" && presentation.segments.length > 0 && (
        <div className="border-t border-neutral-800 px-3 py-2 font-mono text-xs">
          {presentation.segments.map((segment, index) => (
            <pre
              key={index}
              className={`overflow-x-auto whitespace-pre-wrap break-all ${
                segment.kind === "stderr" ? "text-rose-300" : segment.kind === "meta" ? "text-neutral-500" : "text-neutral-300"
              }`}
            >
              {segment.text}
            </pre>
          ))}
        </div>
      )}

      {presentation === undefined && (block.output ?? block.progress) !== undefined && (
        <pre className="max-h-60 overflow-auto border-t border-neutral-800 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-neutral-300">
          {block.output ?? block.progress}
        </pre>
      )}
    </div>
  );
}
