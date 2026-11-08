import { useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import type { StoredMessage } from "@protocol";
import type { UiBlock } from "../state/store";
import { ToolBlockView } from "./ToolBlockView";

function MessageText({ text }: { text: string }) {
  return (
    <div className="markdown-body text-[15px] leading-7">
      <Streamdown>{text}</Streamdown>
    </div>
  );
}

function messageText(message: StoredMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function MessageBlockView({ message }: { message: StoredMessage }) {
  const text = messageText(message);
  if (message.origin === "inject") {
    return (
      <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/30 px-3 py-2 text-xs text-neutral-500">
        <details>
          <summary className="cursor-pointer">系统注入（{message.injectionSource ?? "system"}）</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
        </details>
      </div>
    );
  }
  if (message.origin === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-sky-600/25 px-4 py-2">
          <p className="whitespace-pre-wrap text-[15px] leading-7 text-neutral-100">{text}</p>
        </div>
      </div>
    );
  }
  // assistant / system / tool 落库消息都按正文渲染
  return (
    <div className="max-w-full">
      <MessageText text={text} />
    </div>
  );
}

function ReasoningBlockView({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/30 px-3 py-2 text-sm">
      <details>
        <summary className="cursor-pointer text-xs text-neutral-500">思考中…（不落库，刷新即失）</summary>
        <p className="mt-1 whitespace-pre-wrap text-neutral-400">{text}</p>
      </details>
    </div>
  );
}

export function Transcript({ blocks, turnActive }: { blocks: UiBlock[]; turnActive: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [blocks.length, turnActive]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        {blocks.map((block) => {
          switch (block.kind) {
            case "message":
              return <MessageBlockView key={block.id} message={block.message} />;
            case "text":
              return <MessageText key={block.id} text={block.text} />;
            case "reasoning":
              return <ReasoningBlockView key={block.id} text={block.text} />;
            case "tool":
              return <ToolBlockView key={block.id} block={block} />;
            case "error":
              return (
                <div key={block.id} className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                  {block.message}
                </div>
              );
            default:
              return null;
          }
        })}
        {turnActive && (
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:300ms]" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
