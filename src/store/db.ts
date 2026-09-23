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

export const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  model            TEXT NOT NULL,
  provider_id      TEXT,
  system_prompt    TEXT NOT NULL,
  title            TEXT,
  cwd              TEXT,
  active_branch_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  session_id   TEXT NOT NULL,
  msgid        INTEGER NOT NULL,
  parent_msgid INTEGER,
  role         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  tool_call_id TEXT,
  parts        TEXT NOT NULL,
  tool_calls   TEXT,
  workspace    TEXT,
  reasoning    TEXT,
  PRIMARY KEY (session_id, msgid),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  parent_branch_id TEXT,
  from_msgid       INTEGER,
  head_msgid       INTEGER,
  created_at       INTEGER NOT NULL,
  title            TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_branch_id) REFERENCES branches(id) ON DELETE SET NULL
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
CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id, at);
`;

export interface OpenDatabaseOptions {
  /** 文件路径，或 ":memory:"。 */
  path: string;
  /** 抢锁重试总时长上限（毫秒）。 */
  lockTimeoutMs?: number;
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /locked|busy/i.test(message);
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * v1 -> v2：
 *   - messages.parent_msgid
 *   - sessions.active_branch_id
 *   - branches 表
 *   - 旧线性历史回填成 main 分支
 */
function migrate(db: Database): void {
  const version = schemaVersion(db);

  if (version < 2) {
    ensureColumn(db, "sessions", "active_branch_id", "TEXT");
    ensureColumn(db, "messages", "parent_msgid", "INTEGER");

    db.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        parent_branch_id TEXT,
        from_msgid       INTEGER,
        head_msgid       INTEGER,
        created_at       INTEGER NOT NULL,
        title            TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_branch_id) REFERENCES branches(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id, created_at);
    `);

    const sessions = db.query("SELECT id, created_at FROM sessions").all() as {
      id: string;
      created_at: number;
    }[];
    const insertBranch = db.query(
      `INSERT OR IGNORE INTO branches
       (id, session_id, parent_branch_id, from_msgid, head_msgid, created_at, title)
       VALUES (?, ?, NULL, NULL, ?, ?, 'main')`,
    );
    const headQuery = db.query(
      "SELECT MAX(msgid) AS head FROM messages WHERE session_id = ?",
    );
    const setActive = db.query(
      "UPDATE sessions SET active_branch_id = COALESCE(active_branch_id, ?) WHERE id = ?",
    );

    for (const session of sessions) {
      const branchId = `${session.id}:main`;
      const head = headQuery.get(session.id) as { head: number | null } | null;
      insertBranch.run(branchId, session.id, head?.head ?? null, session.created_at);
      setActive.run(branchId, session.id);
    }

    // 旧历史原本是线性的：按 msgid 顺序回填父指针。
    db.exec(`
      UPDATE messages
         SET parent_msgid = (
           SELECT MAX(prev.msgid)
             FROM messages AS prev
            WHERE prev.session_id = messages.session_id
              AND prev.msgid < messages.msgid
         )
       WHERE parent_msgid IS NULL
         AND msgid <> 0;
    `);
  }

  if (version < 3) {
    ensureColumn(db, "messages", "workspace", "TEXT");
  }

  if (version < 4) {
    ensureColumn(db, "messages", "reasoning", "TEXT");
  }
}

/**
 * 同步重试。
 *
 * 为什么可以阻塞：bun:sqlite 本身就是同步 API，且这里只包住"建库 + 建表"这一小段，
 * 争用窗口是毫秒级。用异步等待反而要把它改成 async，污染整条调用链。
 */
function withLockRetry<T>(fn: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  let lastError: unknown;

  for (;;) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
}

export function openDatabase(options: OpenDatabaseOptions): Database {
  const { path } = options;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });

  // 顺序很重要：busy_timeout 必须在任何可能抢锁的语句之前设好。
  // 注意 Bun 的 DatabaseOptions 里没有 timeout 字段（运行时会被静默忽略），
  // 所以不能指望构造参数，必须显式设 PRAGMA。
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // journal_mode 切换与建表都可能撞上别的进程，需要重试。
  // 多个进程同时首次建库时，这里是唯一的真实争用点。
  withLockRetry(() => {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    migrate(db);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }, lockTimeoutMs);

  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;
  return row === null ? 0 : Number.parseInt(row.value, 10);
}
