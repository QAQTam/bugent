/**
 * SessionStore —— 会话与消息的持久化。
 *
 * 设计原则：**写入是即时且只追加的**。每追加一条消息就落盘，
 * 所以进程被 kill 掉也不会丢历史；恢复时按 msgid 顺序读回来即可。
 */

import type { Database } from "bun:sqlite";
import type { ContentPart, Role, ToolCall } from "../provider/types.ts";
import type { PersistedProviderConfig } from "../provider/registry.ts";
import { makeMessage, type InjectionSource, type MessageOrigin, type StoredMessage } from "../core/message.ts";
import type { WorkspaceChange } from "../core/workspace.ts";
import type { SandboxMode } from "../permission/mode.ts";
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
  activeBranchId?: string;
  /** session 级沙箱档位；省略时沿用全局默认。 */
  sandboxMode?: SandboxMode;
  /** session 级非敏感 provider 配置（endpoint/baseUrl 等，永不含 apiKey）。 */
  providerConfig?: PersistedProviderConfig;
}

export interface BranchRecord {
  id: string;
  sessionId: string;
  parentBranchId?: string;
  fromMsgid?: number;
  headMsgid?: number;
  createdAt: number;
  title?: string;
}

export type AuditEventKind =
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "permission"
  | "session_config"
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
  active_branch_id: string | null;
  sandbox_mode: string | null;
  provider_config: string | null;
}

interface MessageRow {
  session_id: string;
  msgid: number;
  parent_msgid: number | null;
  role: string;
  origin: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
  tool_calls: string | null;
  workspace: string | null;
  reasoning: string | null;
  injection_source: string | null;
}

interface BranchRow {
  id: string;
  session_id: string;
  parent_branch_id: string | null;
  from_msgid: number | null;
  head_msgid: number | null;
  created_at: number;
  title: string | null;
}

interface SessionProviderRow {
  session_id: string;
  provider_id: string;
  config: string;
  updated_at: number;
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

function parseProviderConfig(raw: string): PersistedProviderConfig {
  const parsed = JSON.parse(raw) as PersistedProviderConfig & { apiKey?: string };
  const { apiKey: _apiKey, ...safe } = parsed;
  return safe;
}

function rowToSession(row: SessionRow): SessionRecord {
  const providerConfig =
    row.provider_config === null ? undefined : parseProviderConfig(row.provider_config);

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    systemPrompt: row.system_prompt,
    ...(row.provider_id !== null ? { providerId: row.provider_id } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.active_branch_id !== null ? { activeBranchId: row.active_branch_id } : {}),
    ...(row.sandbox_mode !== null ? { sandboxMode: row.sandbox_mode as SandboxMode } : {}),
    ...(providerConfig !== undefined ? { providerConfig } : {}),
  };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return makeMessage({
    msgid: row.msgid,
    ...(row.parent_msgid !== null ? { parentMsgId: row.parent_msgid } : {}),
    role: row.role as Role,
    origin: row.origin as MessageOrigin,
    ...(row.injection_source !== null
      ? { injectionSource: row.injection_source as InjectionSource }
      : {}),
    parts: JSON.parse(row.parts) as ContentPart[],
    createdAt: row.created_at,
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_calls !== null ? { toolCalls: JSON.parse(row.tool_calls) as ToolCall[] } : {}),
    ...(row.workspace !== null
      ? { workspace: JSON.parse(row.workspace) as WorkspaceChange }
      : {}),
    ...(row.reasoning !== null ? { reasoning: row.reasoning } : {}),
  });
}

function rowToBranch(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    ...(row.parent_branch_id !== null ? { parentBranchId: row.parent_branch_id } : {}),
    ...(row.from_msgid !== null ? { fromMsgid: row.from_msgid } : {}),
    ...(row.head_msgid !== null ? { headMsgid: row.head_msgid } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
  };
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

export function mainBranchId(sessionId: string): string {
  return `${sessionId}:main`;
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
    const branchId = record.activeBranchId ?? mainBranchId(record.id);
    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT OR REPLACE INTO sessions
           (id, created_at, updated_at, model, provider_id, system_prompt, title, cwd, active_branch_id, sandbox_mode, provider_config)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          branchId,
          record.sandboxMode ?? null,
          record.providerConfig === undefined ? null : JSON.stringify(record.providerConfig),
        );

      this.#db
        .query(
          `INSERT OR IGNORE INTO branches
           (id, session_id, parent_branch_id, from_msgid, head_msgid, created_at, title)
           VALUES (?, ?, NULL, NULL, NULL, ?, 'main')`,
        )
        .run(branchId, record.id, record.createdAt);
    });
    tx.immediate();
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    if (row === null) return undefined;
    const record = rowToSession(row);
    if (record.providerId !== undefined) {
      const config = this.getProviderConfig(id, record.providerId);
      if (config !== undefined) record.providerConfig = config;
    }
    return record;
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

  /** 更新 session 级 provider/model；后续 runtime 重建以它为准。 */
  setModelProvider(id: string, model: string, providerId: string): void {
    this.#db
      .query("UPDATE sessions SET model = ?, provider_id = ? WHERE id = ?")
      .run(model, providerId, id);
  }

  /** 保存 session 级非敏感 provider 配置；apiKey 会被强制剔除。 */
  setProviderConfig(sessionId: string, config: PersistedProviderConfig): void {
    const { apiKey: _apiKey, ...safe } = config as PersistedProviderConfig & { apiKey?: string };
    this.#db
      .query(
        `INSERT INTO session_providers (session_id, provider_id, config, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, provider_id)
         DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(sessionId, config.id, JSON.stringify(safe), Date.now());
  }

  getProviderConfig(sessionId: string, providerId: string): PersistedProviderConfig | undefined {
    const row = this.#db
      .query("SELECT * FROM session_providers WHERE session_id = ? AND provider_id = ?")
      .get(sessionId, providerId) as SessionProviderRow | null;
    return row === null ? undefined : parseProviderConfig(row.config);
  }

  listProviderConfigs(sessionId: string): PersistedProviderConfig[] {
    const rows = this.#db
      .query("SELECT * FROM session_providers WHERE session_id = ? ORDER BY provider_id ASC")
      .all(sessionId) as SessionProviderRow[];
    return rows.map((row) => parseProviderConfig(row.config));
  }

  deleteProviderConfig(sessionId: string, providerId: string): void {
    this.#db
      .query("DELETE FROM session_providers WHERE session_id = ? AND provider_id = ?")
      .run(sessionId, providerId);
  }

  /** 更新 session 级沙箱档位；后续 runtime 重建/恢复都以它为准。 */
  setSandboxMode(id: string, mode: SandboxMode): void {
    this.#db.query("UPDATE sessions SET sandbox_mode = ? WHERE id = ?").run(mode, id);
  }

  /* --------------------------- branches --------------------------- */

  getActiveBranchId(sessionId: string): string | undefined {
    const row = this.#db
      .query("SELECT active_branch_id FROM sessions WHERE id = ?")
      .get(sessionId) as { active_branch_id: string | null } | null;
    return row?.active_branch_id ?? undefined;
  }

  getBranch(sessionId: string, branchId: string): BranchRecord | undefined {
    const row = this.#db
      .query("SELECT * FROM branches WHERE session_id = ? AND id = ?")
      .get(sessionId, branchId) as BranchRow | null;
    return row === null ? undefined : rowToBranch(row);
  }

  listBranches(sessionId: string): BranchRecord[] {
    const rows = this.#db
      .query("SELECT * FROM branches WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as BranchRow[];
    return rows.map(rowToBranch);
  }

  createBranch(
    sessionId: string,
    fromMsgid?: number,
    options: { parentBranchId?: string; title?: string; id?: string } = {},
  ): string {
    const id = options.id ?? crypto.randomUUID();
    const createdAt = Date.now();
    this.#db
      .query(
        `INSERT INTO branches
         (id, session_id, parent_branch_id, from_msgid, head_msgid, created_at, title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        options.parentBranchId ?? null,
        fromMsgid ?? null,
        fromMsgid ?? null,
        createdAt,
        options.title ?? null,
      );
    return id;
  }

  setActiveBranch(sessionId: string, branchId: string): void {
    const branch = this.getBranch(sessionId, branchId);
    if (branch === undefined) throw new Error(`未知分支：${branchId}`);
    this.#db
      .query("UPDATE sessions SET active_branch_id = ? WHERE id = ?")
      .run(branchId, sessionId);
  }

  nextMsgId(sessionId: string): number {
    const row = this.#db
      .query("SELECT COALESCE(MAX(msgid) + 1, 0) AS next FROM messages WHERE session_id = ?")
      .get(sessionId) as { next: number } | null;
    return row?.next ?? 0;
  }

  /* --------------------------- messages --------------------------- */

  #insertMessage(sessionId: string, message: StoredMessage): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO messages
         (session_id, msgid, parent_msgid, role, origin, created_at, tool_call_id, parts, tool_calls, workspace, reasoning, injection_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        message.msgid,
        message.parentMsgId ?? null,
        message.role,
        message.origin,
        message.createdAt,
        message.toolCallId ?? null,
        JSON.stringify(message.parts),
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
        message.workspace === undefined ? null : JSON.stringify(message.workspace),
        message.reasoning ?? null,
        message.injectionSource ?? null,
      );
  }

  appendMessage(sessionId: string, message: StoredMessage): void {
    this.#insertMessage(sessionId, message);
  }

  /**
   * 向指定分支追加消息。
   *
   * msgid 仍然是 session 全局递增；分支只通过 parent_msgid/head_msgid 表达路径。
   */
  appendMessageToBranch(
    sessionId: string,
    branchId: string,
    message: StoredMessage,
    at: number,
  ): void {
    const tx = this.#db.transaction(() => {
      this.#insertMessage(sessionId, message);
      this.touchSession(sessionId, at);
      this.#db
        .query(
          `UPDATE branches
              SET head_msgid = ?
            WHERE id = ?
              AND session_id = ?
              AND (head_msgid IS NULL OR head_msgid < ?)`,
        )
        .run(message.msgid, branchId, sessionId, message.msgid);
    });
    tx.immediate();
  }

  /**
   * 追加消息并更新当前 active branch 与会话时间戳。
   *
   * 三条写必须原子提交：否则进程在中间挂掉会留下“消息已落盘但分支仍显示旧 head”
   * 的不一致状态，也会让每条消息多付一次 WAL fsync。
   */
  appendMessageAndTouch(sessionId: string, message: StoredMessage, at: number): void {
    const branchId = this.getActiveBranchId(sessionId);
    if (branchId !== undefined) {
      this.appendMessageToBranch(sessionId, branchId, message, at);
      return;
    }

    const tx = this.#db.transaction(() => {
      this.#insertMessage(sessionId, message);
      this.touchSession(sessionId, at);
    });
    tx.immediate();
  }

  loadMessages(sessionId: string): StoredMessage[] {
    const rows = this.#db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY msgid ASC")
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * 只加载某个分支的路径：从 head_msgid 沿 parent_msgid 回溯。
   *
   * 注意返回顺序仍是 msgid ASC；分支只改变“哪些消息属于当前路径”，
   * 不改变 msgid 的全局单调性。
   */
  loadBranchPath(sessionId: string, branchId: string): StoredMessage[] {
    const branch = this.getBranch(sessionId, branchId);
    if (branch === undefined) throw new Error(`未知分支：${branchId}`);
    if (branch.headMsgid === undefined) return [];

    const rows = this.#db
      .query(
        `WITH RECURSIVE path(msgid) AS (
           SELECT msgid
             FROM messages
            WHERE session_id = ? AND msgid = ?
           UNION ALL
           SELECT m.parent_msgid
             FROM messages AS m
             JOIN path AS p ON m.msgid = p.msgid
            WHERE m.session_id = ?
              AND m.parent_msgid IS NOT NULL
         )
         SELECT m.*
           FROM messages AS m
           JOIN path AS p ON m.msgid = p.msgid
          WHERE m.session_id = ?
          ORDER BY m.msgid ASC`,
      )
      .all(sessionId, branch.headMsgid, sessionId, sessionId) as MessageRow[];
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
