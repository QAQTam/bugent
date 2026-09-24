/**
 * bugent → buTUI StreamLedger transcript adapter.
 *
 * Structured session state remains in AgentSession; this adapter only projects
 * long text into a retention-aware stream so the experimental UI can exercise
 * StreamLedger / StreamWindow instead of retaining the full transcript in a
 * Solid signal.
 */
import { MemoryLedger } from "@butui/core";
import {
  DEFAULT_RETENTION_POLICY,
  FileSpillStore,
  StreamLedger,
  type StreamId,
} from "@butui/stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSignal } from "solid-js";

export interface BugentTranscript {
  readonly ledger: StreamLedger;
  readonly streamId: StreamId;
  readonly revision: () => number;
  appendBlock(text: string): void;
  appendDelta(text: string): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface BugentTranscriptOptions {
  sessionId: string;
  streamId?: StreamId;
  /** Keep spill/index sidecars for crash recovery instead of deleting them. */
  keepSidecars?: boolean;
}

export function createBugentTranscript(
  options: BugentTranscriptOptions,
): BugentTranscript {
  const streamId = options.streamId ?? "bugent-transcript";
  const root = join(homedir(), ".bugent", "butui", options.sessionId);
  const spillPath = join(root, "transcript.ndjson");
  const indexPath = join(root, "transcript-index");
  const appliedPath = join(root, "applied.bin");
  const memory = new MemoryLedger({ totalBytes: 8 * 1024 * 1024 });
  const ledger = new StreamLedger({
    memory,
    memoryOwner: "bugent-butui-transcript",
    spill: {
      store: new FileSpillStore(spillPath, {
        indexPath,
        indexCacheChunks: DEFAULT_RETENTION_POLICY.indexCacheChunks,
      }),
      policy: {
        maxBytes: DEFAULT_RETENTION_POLICY.hotBytes,
        keepTailLines: DEFAULT_RETENTION_POLICY.keepTailLines,
      },
    },
    appliedStorePath: appliedPath,
    appliedCacheChunks: DEFAULT_RETENTION_POLICY.appliedCacheChunks,
    cleanupSidecars: options.keepSidecars !== true,
  });
  ledger.open({ streamId, kind: "text", priority: 1, createdAt: Date.now() });

  const [revision, setRevision] = createSignal(0);
  let seq = 1;
  let closed = false;
  let atLineStart = true;
  let chain = Promise.resolve();

  const enqueue = (delta: string): void => {
    if (delta.length === 0 || closed) return;
    const last = delta[delta.length - 1];
    atLineStart = last === "\n";
    chain = chain
      .catch(() => {
        // Keep later appends alive after one rejected envelope; the UI still
        // has the error path, and the ledger remains the authority.
      })
      .then(async () => {
        const current = ledger.project(streamId).revision;
        const result = await ledger.applyWithSpill({
          sessionId: options.sessionId,
          streamId,
          seq: seq++,
          baseRevision: current,
          kind: "text",
          priority: 1,
          op: { type: "append", delta },
          createdAt: Date.now(),
        });
        if (result.status !== "applied") {
          throw new Error(`[bugent-butui] transcript append ${result.status}`);
        }
        setRevision(result.revision);
      });
  };

  return {
    ledger,
    streamId,
    revision,
    appendBlock(text) {
      if (text.length === 0) return;
      if (!atLineStart) enqueue("\n");
      enqueue(text.endsWith("\n") ? text : `${text}\n`);
    },
    appendDelta(text) {
      enqueue(text);
    },
    flush() {
      return chain;
    },
    dispose() {
      if (closed) return;
      closed = true;
      chain = chain
        .catch(() => {})
        .then(async () => {
          const current = ledger.project(streamId).revision;
          await ledger.applyWithSpill({
            sessionId: options.sessionId,
            streamId,
            seq: seq++,
            baseRevision: current,
            kind: "text",
            priority: 1,
            op: { type: "finish" },
            createdAt: Date.now(),
          });
        })
        .finally(() => ledger.dispose());
    },
  };
}
