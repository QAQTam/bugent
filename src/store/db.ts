/**
 * SQLite 打开与 schema 迁移 —— Phase 10。
 *
 * 选 bun:sqlite 的理由：内置、同步 API（省掉一堆 await）、WAL 下读写并发够用。
 *
 * 表设计要点：
 *   messages 的主键是 (session_id, msgid) —— msgid 是会话内自增序号，
 *   天然就是"上下文顺序"，重放即可恢复完整上下文，不需要额外排序字段。
 *   events 是只追加的审计流水：工具调用、权限决策、每轮起止，全部留痕。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  model         TEXT NOT NULL,
  provider_id   TEXT,
  system_prompt TEXT NOT NULL,
  title         TEXT,
  cwd           TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  session_id   TEXT NOT NULL,
  msgid        INTEGER NOT NULL,
  role         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  tool_call_id TEXT,
  parts        TEXT NOT NULL,
  tool_calls   TEXT,
  PRIMARY KEY (session_id, msgid),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  turn       INTEGER,
  msgid      INTEGER,
  payload    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, msgid);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id, at);
`;

export interface OpenDatabaseOptions {
  /** 文件路径，或 ":memory:"。 */
  path: string;
}

export function openDatabase(options: OpenDatabaseOptions): Database {
  const { path } = options;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 多 session 并行写入时，等锁而不是立刻报 SQLITE_BUSY
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );

  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;
  return row === null ? 0 : Number.parseInt(row.value, 10);
}
