/** WebUI 服务接入测试：`bun run bugent:webui` 的装配路径（静态伺服 + 真实工厂 + mock provider）。 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebui, type WebuiServer } from "../src/entry-webui";
import type { UiEnvelope } from "../src/protocol/types";

let server: WebuiServer;

async function withServer(run: (info: WebuiServer["info"]) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), "bugent-webui-static-"));
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log('app')");
  server = await startWebui({
    mock: true,
    noPersist: true,
    quiet: true,
    staticDir,
  });
  try {
    await run(server.info);
  } finally {
    server.stop();
  }
}

describe("bugent:webui 服务", () => {
  test("静态伺服：/ 回 index.html，资源命中，SPA 回退", async () => {
    await withServer(async (info) => {
      const page = await fetch(`http://127.0.0.1:${info.port}/?token=${info.token}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="root"');

      const asset = await fetch(`http://127.0.0.1:${info.port}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("console.log");

      const fallback = await fetch(`http://127.0.0.1:${info.port}/some/spa/route`);
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toContain('id="root"');
    });
  });

  test("同端口 WS：hello → session.new → turn.send → mock provider 流式回显", async () => {
    await withServer(async (info) => {
      const ws = new WebSocket(info.url);
      const frames: UiEnvelope[] = [];
      const waiters: { match: (e: UiEnvelope) => boolean; resolve: (e: UiEnvelope) => void }[] = [];
      ws.onmessage = (ev) => {
        const e = JSON.parse(String(ev.data)) as UiEnvelope;
        frames.push(e);
        const i = waiters.findIndex((w) => w.match(e));
        if (i !== -1) waiters.splice(i, 1)[0]!.resolve(e);
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("连接失败"));
      });
      const send = (type: string, payload: Record<string, unknown>, sessionId?: string): Promise<UiEnvelope> => {
        const id = `m-${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
          waiters.push({ match: (e) => e.kind === "reply" && e.id === id, resolve });
          ws.send(JSON.stringify({ v: 1, id, kind: "cmd", type, ...(sessionId ? { sessionId } : {}), payload, ts: Date.now() }));
        });
      };
      const waitFor = (match: (e: UiEnvelope) => boolean, label: string): Promise<UiEnvelope> =>
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error(`waitFor 超时: ${label}`)), 5000);
          waiters.push({ match, resolve });
        });

      const hello = await send("hello", { token: info.token, client: "webui", protocolVersions: [1] });
      expect(hello.payload.ok).toBe(true);

      const created = await send("session.new", { cwd: process.cwd() });
      expect(created.payload.ok).toBe(true);
      const sessionId = String(created.payload.sessionId);

      await send("session.attach", { sessionId }, sessionId);
      await send("turn.send", { text: "你好 webui" }, sessionId);
      await waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === sessionId, "turn.done");

      const deltas = frames
        .filter((e) => e.kind === "evt" && e.type === "text.delta" && e.sessionId === sessionId)
        .map((e) => String((e.payload as { delta: string }).delta))
        .join("");
      expect(deltas).toContain("[mock] 你好 webui");
      ws.close();
    });
  });

  test("token 错误的页面请求不受影响，WS 仍被拒", async () => {
    await withServer(async (info) => {
      const page = await fetch(`http://127.0.0.1:${info.port}/`);
      expect(page.status).toBe(200);
      const ws = new WebSocket(info.url);
      const closed = new Promise<number>((resolve) => {
        ws.onclose = (ev) => resolve(ev.code);
      });
      ws.onopen = () => {
        ws.send(JSON.stringify({ v: 1, id: "m1", kind: "cmd", type: "hello", payload: { token: "wrong", client: "webui", protocolVersions: [1] }, ts: 0 }));
      };
      expect(await closed).toBe(4401);
    });
  });
});
