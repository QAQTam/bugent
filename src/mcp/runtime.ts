/**
 * MCP configuration bootstrap.
 *
 * This layer is intentionally separate from the transport and ToolRegistry:
 * it starts configured servers once per process/session runtime and produces
 * the stable manifest used for msgid1.
 */

import type { McpConfig } from "../config/schema.ts";
import { McpManager, type McpManagerOptions } from "./manager.ts";
import { assertMcpSandboxSupported, isMcpSandboxSupported } from "./stdio.ts";

export interface StartedMcp {
  manager: McpManager | undefined;
  manifest: string | undefined;
  disabledReason?: string;
}

export interface StartMcpOptions {
  config: McpConfig | undefined;
  cwd: string;
  /** Test/daemon override; defaults to process.platform. */
  platform?: NodeJS.Platform;
  onToolsChanged?: McpManagerOptions["onToolsChanged"];
}

export async function startConfiguredMcp(options: StartMcpOptions): Promise<StartedMcp> {
  const servers = options.config?.servers ?? [];
  if (servers.length === 0) return { manager: undefined, manifest: undefined };

  if (!isMcpSandboxSupported(options.platform)) {
    const platform = options.platform ?? process.platform;
    return {
      manager: undefined,
      manifest: undefined,
      disabledReason:
        `MCP 已关闭：原生沙箱当前只支持 Linux，当前平台是 ${platform}。` +
        `Windows/macOS provider 完成前不会启动无沙箱 MCP server。`,
    };
  }

  assertMcpSandboxSupported(options.platform);
  const manager = new McpManager(
    options.onToolsChanged !== undefined ? { onToolsChanged: options.onToolsChanged } : {},
  );
  let currentId = "unknown";
  try {
    for (const server of servers) {
      currentId = server.id;
      const cwd = server.cwd ?? options.cwd;
      await manager.start({
        ...server,
        cwd,
        ...(server.stateDir !== undefined ? { stateDir: server.stateDir } : {}),
      });
    }
    return { manager, manifest: manager.manifest() };
  } catch (error) {
    await manager.close();
    throw new Error(
      `MCP server ${currentId} 启动失败（已停止其余 server）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
