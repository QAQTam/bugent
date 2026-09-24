import { describe, expect, test } from "bun:test";

describe("provider 本地网络", () => {
  test("HTTP_PROXY 不可用时，127.0.0.1 endpoint 仍能直连", async () => {
    const script = `
      import { createOpenAIChatClient } from "./src/provider/adapters/openai-chat.ts";

      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      });

      try {
        const client = createOpenAIChatClient("test", {
          baseUrl: \`http://127.0.0.1:\${server.port}/v1\`,
        });
        let text = "";
        for await (const chunk of client.chat({
          model: "test",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {
          if (chunk.type === "text") text += chunk.delta;
        }
        if (text !== "ok") throw new Error(\`bad text: \${text}\`);
        console.log("OK");
      } finally {
        server.stop(true);
      }
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "",
        no_proxy: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("OK");
  });
});

describe("provider session override", () => {
  test("resolve 的 apiKey override 只影响当前 client，不修改 registry 默认值", async () => {
    const script = `
      import { ProviderRegistry } from "./src/provider/registry.ts";

      let seen = "";
      const server = Bun.serve({
        port: 0,
        fetch: (req) => {
          seen = req.headers.get("authorization") ?? "";
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });

      try {
        const registry = new ProviderRegistry().register({
          id: "local",
          endpoint: "openai-chat",
          baseUrl: \`http://127.0.0.1:\${server.port}/v1\`,
          apiKey: "base-key",
        });
        const client = registry.resolve(
          { provider: "local", model: "m" },
          { apiKey: "session-key" },
        );
        for await (const _chunk of client.chat({
          model: "m",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {}
        if (seen !== "Bearer session-key") throw new Error(\`bad override: \${seen}\`);

        const base = registry.resolve({ provider: "local", model: "m" });
        for await (const _chunk of base.chat({
          model: "m",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {}
        if (seen !== "Bearer base-key") throw new Error(\`registry mutated: \${seen}\`);
        console.log("OK");
      } finally {
        server.stop(true);
      }
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("OK");
  });
});

describe("provider session config", () => {
  test("未注册 provider 可以用完整 override 解析", async () => {
    const script = `
      import { ProviderRegistry } from "./src/provider/registry.ts";

      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      });

      try {
        const registry = new ProviderRegistry();
        const client = registry.resolve(
          { provider: "local-new", model: "m" },
          {
            endpoint: "openai-chat",
            baseUrl: \`http://127.0.0.1:\${server.port}/v1\`,
          },
        );
        let text = "";
        for await (const chunk of client.chat({
          model: "m",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {
          if (chunk.type === "text") text += chunk.delta;
        }
        if (text !== "ok") throw new Error(\`bad text: \${text}\`);
        console.log("OK");
      } finally {
        server.stop(true);
      }
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("OK");
  });
});
