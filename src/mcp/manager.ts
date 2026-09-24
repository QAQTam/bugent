/**
 * MCP server lifecycle.
 *
 * A manager owns one sandboxed stdio client and the current tool snapshot for
 * that server. Reloads replace only the tool registry snapshot; timeline
 * injection is a separate operation and must happen at a safe message boundary.
 */

import type { ToolRegistry } from "../tools/types.ts";
import { McpStdioClient, type McpStdioServerConfig, type McpToolInfo } from "./stdio.ts";
import { mcpToolName, registerMcpTools } from "./tools.ts";

export interface McpServerHandle {
  id: string;
  client: McpStdioClient;
  tools: McpToolInfo[];
}

export interface McpToolsChanged {
  serverId: string;
  added: readonly string[];
  removed: readonly string[];
  tools: readonly McpToolInfo[];
}

export interface McpServerStatus {
  id: string;
  tools: readonly string[];
}

export interface McpStatus {
  servers: readonly McpServerStatus[];
}

export interface McpManagerOptions {
  /** Optional registry to attach immediately. */
  registry?: ToolRegistry;
  /** Called after a server's registry snapshot changed. */
  onToolsChanged?: (change: McpToolsChanged) => void;
}

interface McpAttachment {
  names: Set<string>;
  selected: Set<string> | undefined;
}

function selectionSet(serverIds: readonly string[] | undefined): Set<string> | undefined {
  return serverIds === undefined ? undefined : new Set(serverIds);
}

function isSelected(selected: Set<string> | undefined, serverId: string): boolean {
  return selected === undefined || selected.has(serverId);
}

export class McpManager {
  readonly #onToolsChanged: McpManagerOptions["onToolsChanged"];
  #servers = new Map<string, McpServerHandle>();
  #attachments = new Map<ToolRegistry, McpAttachment>();

  constructor(options: McpManagerOptions = {}) {
    this.#onToolsChanged = options.onToolsChanged;
    if (options.registry !== undefined) this.attach(options.registry);
  }

  list(): McpServerHandle[] {
    return [...this.#servers.values()];
  }

  get(id: string): McpServerHandle | undefined {
    return this.#servers.get(id);
  }

  status(serverIds?: readonly string[]): McpStatus {
    const selected = selectionSet(serverIds);
    return {
      servers: [...this.#servers.values()]
        .filter((handle) => isSelected(selected, handle.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((handle) => ({
          id: handle.id,
          tools: handle.tools.map((tool) => mcpToolName(handle.id, tool.name)),
        })),
    };
  }

  /**
   * Register the current server snapshots into a runtime registry.
   *
   * `serverIds` is a session-level allowlist. Passing undefined means all
   * servers. Re-attaching the same registry replaces its selection.
   */
  attach(registry: ToolRegistry, serverIds?: readonly string[]): string[] {
    if (this.#attachments.has(registry)) this.detach(registry);
    const selected = selectionSet(serverIds);
    const names = new Set<string>();
    try {
      for (const handle of this.#servers.values()) {
        if (!isSelected(selected, handle.id)) continue;
        for (const name of registerMcpTools(registry, handle.client, handle.id, handle.tools)) {
          names.add(name);
        }
      }
    } catch (error) {
      for (const name of names) registry.unregister(name);
      throw error;
    }
    this.#attachments.set(registry, { names, selected });
    return [...names];
  }

  detach(registry: ToolRegistry): void {
    const attachment = this.#attachments.get(registry);
    if (attachment === undefined) return;
    for (const name of attachment.names) registry.unregister(name);
    this.#attachments.delete(registry);
  }

  /** Stable model-visible manifest. It contains no environment values or secrets. */
  manifest(serverIds?: readonly string[]): string {
    const selected = selectionSet(serverIds);
    const handles = [...this.#servers.values()].filter((handle) =>
      isSelected(selected, handle.id),
    );
    if (handles.length === 0) return "# MCP servers\n\n(none)";
    const lines = ["# MCP servers", ""];
    for (const handle of handles.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`## ${handle.id}`, "");
      if (handle.tools.length === 0) {
        lines.push("- (no tools)");
      } else {
        for (const tool of [...handle.tools].sort((a, b) => a.name.localeCompare(b.name))) {
          const description = tool.description?.replace(/\s+/g, " ").trim();
          lines.push(
            `- \`${mcpToolName(handle.id, tool.name)}\`${description ? `: ${description}` : ""}`,
          );
        }
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  /** Text suitable for a developer delta when the catalog changed. */
  deltaFrom(previousManifest: string, serverIds?: readonly string[]): string | undefined {
    const current = this.manifest(serverIds);
    if (current === previousManifest) return undefined;
    return [
      "# MCP manifest update",
      "",
      "The MCP tool catalog changed. Current catalog:",
      "",
      current,
    ].join("\n");
  }

  async start(config: McpStdioServerConfig): Promise<McpServerHandle> {
    if (this.#servers.has(config.id)) {
      throw new Error(`MCP server ${config.id} 已存在`);
    }
    const client = new McpStdioClient(config);
    await client.start();
    try {
      const tools = await client.listTools();
      const handle: McpServerHandle = { id: config.id, client, tools };
      this.#servers.set(config.id, handle);
      const attached: Array<{ registry: ToolRegistry; names: string[] }> = [];
      try {
        for (const registry of this.#attachments.keys()) {
          const attachment = this.#attachments.get(registry)!;
          if (!isSelected(attachment.selected, config.id)) continue;
          this.#registerHandle(registry, handle);
          attached.push({ registry, names: tools.map((tool) => mcpToolName(config.id, tool.name)) });
        }
      } catch (error) {
        for (const entry of attached) {
          for (const name of entry.names) {
            entry.registry.unregister(name);
            this.#attachments.get(entry.registry)?.names.delete(name);
          }
        }
        this.#servers.delete(config.id);
        throw error;
      }
      this.#onToolsChanged?.({
        serverId: config.id,
        added: tools.map((tool) => mcpToolName(config.id, tool.name)),
        removed: [],
        tools,
      });
      return handle;
    } catch (error) {
      this.#servers.delete(config.id);
      await client.close();
      throw error;
    }
  }

  /**
   * Refresh a server's tool list.
   *
   * This only updates attached registries. It never inserts messages into a
   * session. A caller that wants provider-visible hot registration must enqueue
   * the returned delta as a developer injection at the next safe boundary.
   */
  async reload(id: string): Promise<McpToolsChanged> {
    const handle = this.#servers.get(id);
    if (handle === undefined) throw new Error(`MCP server ${id} 未运行`);
    const tools = await handle.client.listTools();
    const nextNames = new Set(tools.map((tool) => mcpToolName(id, tool.name)));
    const previousNames = new Set(
      handle.tools.map((tool) => mcpToolName(id, tool.name)),
    );
    const removed = [...previousNames].filter((name) => !nextNames.has(name));
    const added = [...nextNames].filter((name) => !previousNames.has(name));

    for (const registry of this.#attachments.keys()) {
      const attachment = this.#attachments.get(registry)!;
      if (!isSelected(attachment.selected, id)) continue;
      this.#replaceServerTools(registry, handle, tools);
    }

    handle.tools = tools;
    const change: McpToolsChanged = { serverId: id, added, removed, tools };
    this.#onToolsChanged?.(change);
    return change;
  }

  async stop(id: string): Promise<void> {
    const handle = this.#servers.get(id);
    if (handle === undefined) return;
    this.#servers.delete(id);
    for (const registry of this.#attachments.keys()) {
      const attachment = this.#attachments.get(registry)!;
      for (const name of handle.tools.map((tool) => mcpToolName(id, tool.name))) {
        registry.unregister(name);
        attachment.names.delete(name);
      }
    }
    await handle.client.close();
    this.#onToolsChanged?.({
      serverId: id,
      added: [],
      removed: handle.tools.map((tool) => mcpToolName(id, tool.name)),
      tools: [],
    });
  }

  async close(): Promise<void> {
    const ids = [...this.#servers.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
    for (const registry of this.#attachments.keys()) {
      const attachment = this.#attachments.get(registry)!;
      for (const name of attachment.names) registry.unregister(name);
    }
    this.#attachments.clear();
  }

  #registerHandle(registry: ToolRegistry, handle: McpServerHandle): void {
    const attachment = this.#attachments.get(registry);
    if (attachment === undefined || !isSelected(attachment.selected, handle.id)) return;
    const names = attachment.names;
    const incoming = handle.tools.map((tool) => mcpToolName(handle.id, tool.name));
    for (const name of incoming) {
      if (!names.has(name) && registry.get(name) !== undefined) {
        throw new Error(`MCP 工具名冲突：${name}`);
      }
    }
    const added: string[] = [];
    try {
      for (const name of registerMcpTools(registry, handle.client, handle.id, handle.tools)) {
        added.push(name);
        names.add(name);
      }
    } catch (error) {
      for (const name of added) registry.unregister(name);
      throw error;
    }
  }

  #replaceServerTools(
    registry: ToolRegistry,
    handle: McpServerHandle,
    tools: readonly McpToolInfo[],
  ): void {
    const attachment = this.#attachments.get(registry);
    if (attachment === undefined || !isSelected(attachment.selected, handle.id)) return;
    const names = attachment.names;
    const oldNames = new Set(handle.tools.map((tool) => mcpToolName(handle.id, tool.name)));
    const nextNames = tools.map((tool) => mcpToolName(handle.id, tool.name));
    for (const name of nextNames) {
      if (!oldNames.has(name) && registry.get(name) !== undefined) {
        throw new Error(`MCP 工具名冲突：${name}`);
      }
    }
    for (const name of oldNames) {
      registry.unregister(name);
      names.delete(name);
    }
    const added: string[] = [];
    try {
      for (const name of registerMcpTools(registry, handle.client, handle.id, tools)) {
        added.push(name);
        names.add(name);
      }
    } catch (error) {
      for (const name of added) registry.unregister(name);
      for (const name of oldNames) names.delete(name);
      // Best-effort rollback of the old snapshot. The original error is more
      // useful than a rollback error, so do not mask it.
      try {
        for (const name of registerMcpTools(registry, handle.client, handle.id, handle.tools)) {
          names.add(name);
        }
      } catch {
        // Leave the registry without this server's tools rather than claiming
        // a partially updated snapshot.
      }
      throw error;
    }
  }
}
