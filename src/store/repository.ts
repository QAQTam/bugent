/**
 * SessionStore —— 会话与消息的持久化。
 *
 * 设计原则：**写入是即时且只追加的**。每追加一条消息就落盘，
 * 所以进程被 kill 掉也不会丢历史；恢复时按 msgid 顺序读回来即可。
 */

import type { Database } from "bun:sqlite";
import type { ContentPart, Role, ToolCall } from "../provider/types.ts";
import { makeMessage, type MessageOrigin, type StoredMessage } from "../core/message.ts";
import { databasePath } from "../config/toml.ts";
import { openDatabase } from "./db.ts";

export interface SessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  providerId?: string;
  systemPrompt: string;
  title?: string;
  cwd?: string;
}

export type AuditEventKind =
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "permission"
  | "error";

export interface AuditEvent {
  sessionId: string;
  at: number;
  kind: AuditEventKind;
  turn?: number;
  msgid?: number;
  payload: unknown;
}

export interface StoredAuditEvent extends AuditEvent {
  id: number;
}

interface SessionRow {
  id: string;
  created_at: number;
  updated_at: number;
  model: string;
  provider_id: string | null;
  system_prompt: string;
  title: string | null;
  cwd: string | null;
}

interface MessageRow {
  session_id: string;
  msgid: number;
  role: string;
  origin: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
  tool_calls: string | null;
}

interface EventRow {
  id: number;
  session_id: string;
  at: number;
  kind: string;
  turn: number | null;
  msgid: number | null;
  payload: string;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    systemPrompt: row.system_prompt,
    ...(row.provider_id !== null ? { providerId: row.provider_id } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
  };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return makeMessage({
    msgid: row.msgid,
    role: row.role as Role,
    origin: row.origin as MessageOrigin,
    parts: JSON.parse(row.parts) as ContentPart[],
    createdAt: row.created_at,
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_calls !== null ? { toolCalls: JSON.parse(row.tool_calls) as ToolCall[] } : {}),
  });
}

function rowToEvent(row: EventRow): StoredAuditEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    at: row.at,
    kind: row.kind as AuditEventKind,
    payload: JSON.parse(row.payload) as unknown,
    ...(row.turn !== null ? { turn: row.turn } : {}),
    ...(row.msgid !== null ? { msgid: row.msgid } : {}),
  };
}

export interface SessionStoreOptions {
  path: string;
}

export class SessionStore {
  #db: Database;

  constructor(options: SessionStoreOptions) {
    this.#db = openDatabase({ path: options.path });
  }

  /** 直接持有底层 Database（测试与高级用法）。 */
  get db(): Database {
    return this.#db;
  }

  /* --------------------------- sessions --------------------------- */

  createSession(record: SessionRecord): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO sessions
         (id, created_at, updated_at, model, provider_id, system_prompt, title, cwd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.createdAt,
        record.updatedAt,
        record.model,
        record.providerId ?? null,
        record.systemPrompt,
        record.title ?? null,
        record.cwd ?? null,
      );
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row === null ? undefined : rowToSession(row);
  }

  hasSession(id: string): boolean {
    return this.getSession(id) !== undefined;
  }

  listSessions(limit = 50): SessionRecord[] {
    const rows = this.#db
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  touchSession(id: string, at: number): void {
    this.#db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);
  }

  setTitle(id: string, title: string): void {
    this.#db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  /* --------------------------- messages --------------------------- */

  appendMessage(sessionId: string, message: StoredMessage): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO messages
         (session_id, msgid, role, origin, created_at, tool_call_id, parts, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        message.msgid,
        message.role,
        message.origin,
        message.createdAt,
        message.toolCallId ?? null,
        JSON.stringify(message.parts),
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
      );
  }

  loadMessages(sessionId: string): StoredMessage[] {
    const rows = this.#db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY msgid ASC")
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  countMessages(sessionId: string): number {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number } | null;
    return row?.n ?? 0;
  }

  /* --------------------------- events --------------------------- */

  appendEvent(event: AuditEvent): void {
    this.#db
      .query(
        `INSERT INTO events (session_id, at, kind, turn, msgid, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.at,
        event.kind,
        event.turn ?? null,
        event.msgid ?? null,
        JSON.stringify(event.payload),
      );
  }

  listEvents(sessionId: string, limit = 1000): StoredAuditEvent[] {
    const rows = this.#db
      .query("SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?")
      .all(sessionId, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.#db.close();
  }
}

/** 会话库位置：`~/.bugent/sessions.db`（与 config.toml 同目录）。 */
export function defaultDatabasePath(home?: string): string {
  return databasePath(home);
}
