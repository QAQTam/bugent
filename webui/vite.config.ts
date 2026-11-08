import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, resolve } from "node:url";
import { fileURLToPath as toPath } from "node:url";

const repoRoot = toPath(new URL("..", import.meta.url));

// bugent WebUI v2 —— dev：Vite 承载页面并把 /ws 代理到本机 bridge
// （`bun run src/entry-webui.ts --mock --port 8787`）；prod：`vite build`
// 产出 dist/，由 bridge 的 Bun.serve 同源托管（spec §2）。
export default defineConfig({
  plugins: [
    // plugin-react v6（oxc 转换器）：React Compiler 一开关接入
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // 协议类型单一来源：后端 src/protocol/types.ts（仅 import type，构建期擦除）
      "@protocol": fileURLToPath(new URL("../src/protocol/types.ts", import.meta.url)),
    },
  },
  server: {
    port: 5199,
    fs: {
      // alias 指向仓库根的 src/，dev server 需要允许读取
      allow: [repoRoot],
    },
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        // 代理故障时留一行诊断（握手失败在浏览器端只表现为连不上）
        configure: (proxy) => {
          proxy.on("error", (error) => {
            console.error("[ws-proxy]", error.message);
          });
        },
      },
    },
  },
});
