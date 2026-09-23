/**
 * 多进程并发回归测试。
 *
 * 背景：这是真实踩到的 bug —— 4 个进程同时首次建库时全部 `database is locked`。
 * 根因有两个：
 *   1. `PRAGMA busy_timeout` 设在了 `journal_mode = WAL` **之后**，
 *      而切 WAL 本身就要抢锁；
 *   2. Bun 的 DatabaseOptions 里没有 `timeout` 字段，传了会被静默忽略，
 *      所以不能指望构造参数兜底。
 *
 * 这类问题单进程内的单测永远测不出来，必须真的起多个进程。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store/repository.ts";

const PROJECT_ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("P9 · 多进程并发写同一个库", () => {
  test(
    "多个进程同时首次建库并写入，不会 database is locked",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "bugent-mp-"));
      dirs.push(dir);

      const count = 3;
      const procs = Array.from({ length: count }, (_, index) =>
        Bun.spawn(
          ["bun", "run", "src/index.ts", "--mock", "--cwd", dir, "-p", `并发第 ${index + 1} 句`],
          { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" },
        ),
      );

      const results = await Promise.all(
        procs.map(async (proc) => ({
          code: await proc.exited,
          stderr: await new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        })),
      );

      for (const result of results) {
        expect(result.stderr).not.toContain("database is locked");
        expect(result.code).toBe(0);
      }

      const store = new SessionStore({ path: join(dir, ".bugent/bugent.db") });
      try {
        const sessions = store.listSessions();
        expect(sessions).toHaveLength(count);

        let total = 0;
        for (const session of sessions) {
          const messages = store.loadMessages(session.id);
          total += messages.length;
          // msgid 必须连续、从 0 开始，且 0 是 system —— 并发下也不能错乱
          expect(messages.map((m) => m.msgid)).toEqual([0, 1, 2]);
          expect(messages[0]?.role).toBe("system");
        }
        expect(total).toBe(count * 3);
      } finally {
        store.close();
      }
    },
    30_000,
  );
});
