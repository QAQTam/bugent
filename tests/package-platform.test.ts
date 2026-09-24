import { describe, expect, test } from "bun:test";
import { packagePlan, SANDBOX_LIBRARY_NAME } from "../scripts/package-platform.ts";
import { sandboxLibraryAsset } from "../src/runtime/standalone.ts";

describe("打包平台决策", () => {
  test("Linux：内嵌原生 provider，要求构建宿主是 fork", () => {
    const plan = packagePlan("linux");
    expect(plan.binaryName).toBe("bugent");
    expect(plan.assets).toContain(`native/sandbox/build/${SANDBOX_LIBRARY_NAME}`);
    expect(plan.requiresForkRuntime).toBe(true);
    expect(plan.nativeSandbox).toBe(true);
    expect(plan.verify).toEqual({ mcpSandboxProbe: true, sandboxLibraryExtracted: true });
    expect(plan.disabled).toEqual([]);
  });

  test("Windows：可执行文件带 .exe，不嵌 provider，不要求 fork", () => {
    const plan = packagePlan("win32");
    expect(plan.binaryName).toBe("bugent.exe");
    expect(plan.assets.some((asset) => asset.endsWith(".so"))).toBe(false);
    expect(plan.requiresForkRuntime).toBe(false);
    expect(plan.nativeSandbox).toBe(false);
    // 关掉的验证步骤 = 关掉的能力：MCP 探针与 provider 解包检查
    expect(plan.verify).toEqual({ mcpSandboxProbe: false, sandboxLibraryExtracted: false });
    expect(plan.disabled.length).toBeGreaterThan(0);
    expect(plan.disabled.join("\n")).toContain("MCP");
    expect(plan.runtimeNote).toContain("win32");
  });

  test("macOS 与 Windows 同形态（只是文件名不带 .exe）", () => {
    const mac = packagePlan("darwin");
    expect(mac.binaryName).toBe("bugent");
    expect(mac.nativeSandbox).toBe(false);
    expect(mac.requiresForkRuntime).toBe(false);
    expect(mac.disabled).toEqual(packagePlan("win32").disabled);
  });

  test("standalone 只在 Linux 期待 provider 资产", () => {
    expect(sandboxLibraryAsset("linux")).toBe(SANDBOX_LIBRARY_NAME);
    // 非 Linux 返回 undefined：启动时不会去找一个不存在的资产、更不会抛错
    expect(sandboxLibraryAsset("win32")).toBeUndefined();
    expect(sandboxLibraryAsset("darwin")).toBeUndefined();
  });
});
