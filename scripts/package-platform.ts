#!/usr/bin/env bun
/**
 * 打包时的平台决策 —— 「这个平台上有哪些能力要关掉」的唯一出处。
 *
 * 为什么单独一个文件：Windows/macOS 上既没有原生沙箱 provider（fork 的 spawn
 * 钩子是 POSIX/Linux 向的），也没有等价的 bwrap，所以 MCP 与"内核级沙箱"这两件
 * 事必须整体关掉 —— 而不是让用户装完才发现每次工具调用都失败。
 *
 * 决策是纯函数（显式传 platform），打包脚本与测试读同一份，不靠 `process.platform`
 * 在脚本里到处分叉。
 */

export const SANDBOX_LIBRARY_NAME = "libbugent-sandbox.so";

export interface PackagePlan {
  /** 归档里的可执行文件名：Windows 必须带 `.exe`。 */
  binaryName: string;
  /** 需要 `--asset` 嵌进二进制的文件（相对仓库根）。 */
  assets: readonly string[];
  /** 构建宿主是否必须是 Bugent Bun fork。 */
  requiresForkRuntime: boolean;
  /** 是否嵌入原生沙箱 provider。 */
  nativeSandbox: boolean;
  verify: {
    /** 验证阶段是否跑 MCP 探针（MCP 在非 Linux 上是被门控关闭的）。 */
    mcpSandboxProbe: boolean;
    /** 验证阶段是否检查 provider 被解包到 `~/.bugent/runtime/<version>/lib`。 */
    sandboxLibraryExtracted: boolean;
  };
  /** 这个平台上被关掉的能力；写进 manifest，事后可以核对。 */
  disabled: readonly string[];
  /** 发布说明里的一句运行时描述。 */
  runtimeNote: string;
}

const SYSTEM_PROMPT_ASSET = "src/prompts/system.md";

export function packagePlan(platform: NodeJS.Platform): PackagePlan {
  if (platform === "linux") {
    return {
      binaryName: "bugent",
      assets: [SYSTEM_PROMPT_ASSET, `native/sandbox/build/${SANDBOX_LIBRARY_NAME}`],
      requiresForkRuntime: true,
      nativeSandbox: true,
      verify: { mcpSandboxProbe: true, sandboxLibraryExtracted: true },
      disabled: [],
      runtimeNote:
        "Single-file Bun executable with embedded system prompt and Linux sandbox provider.",
    };
  }

  return {
    binaryName: platform === "win32" ? "bugent.exe" : "bugent",
    // 非 Linux 不嵌 provider：没有可加载的实现，嵌进去也没人用
    assets: [SYSTEM_PROMPT_ASSET],
    requiresForkRuntime: false,
    nativeSandbox: false,
    verify: { mcpSandboxProbe: false, sandboxLibraryExtracted: false },
    disabled: [
      "MCP：原生沙箱只支持 Linux，配置了也不会启动（启动横幅会说明原因）",
      "内核级沙箱：没有 provider 也没有 bwrap，read-only / workspace-write 只剩权限层门控",
      "系统 keyring：不接凭据管理，API key 只在当前进程内有效",
    ],
    runtimeNote:
      `Single-file Bun executable with embedded system prompt. ` +
      `Native sandbox provider is unavailable on ${platform}, so MCP and kernel-level sandboxing are disabled.`,
  };
}
