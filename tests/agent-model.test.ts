import { describe, expect, test } from "bun:test";
import {
  assertAuthorityAttenuation,
  assertCapabilityAttenuation,
  attenuateCapabilities,
  authorityAtLeast,
  capabilitiesAreSubset,
  defaultCapabilitiesForKind,
  isAgentAuthority,
  isAgentCapability,
  isAgentKind,
  validateAgentProfile,
} from "../src/agent/model.ts";

describe("P7-A · AgentKind / Authority / Capability", () => {
  test("type guards accept only the frozen domain values", () => {
    expect(isAgentKind("reviewer")).toBe(true);
    expect(isAgentKind("subagent")).toBe(false);
    expect(isAgentAuthority("workspace-write")).toBe(true);
    expect(isAgentAuthority("root")).toBe(false);
    expect(isAgentCapability("fs.read")).toBe(true);
    expect(isAgentCapability("fs.delete")).toBe(false);
  });

  test("defaults follow the profile matrix", () => {
    expect(defaultCapabilitiesForKind("main")).toEqual([
      "fs.read",
      "fs.write",
      "process.exec",
      "mcp.use",
      "agent.spawn",
      "goal.read",
      "goal.write",
    ]);
    expect(defaultCapabilitiesForKind("reviewer", "read-only", "linux")).toEqual([
      "fs.read",
      "process.exec",
    ]);
    expect(defaultCapabilitiesForKind("reviewer", "read-only", "darwin")).toEqual(["fs.read"]);
    expect(defaultCapabilitiesForKind("worker")).toEqual(["fs.read", "fs.write", "process.exec"]);
  });

  test("authority and capabilities attenuate monotonically", () => {
    expect(authorityAtLeast("full", "workspace-write")).toBe(true);
    expect(authorityAtLeast("read-only", "workspace-write")).toBe(false);
    expect(() => assertAuthorityAttenuation("read-only", "workspace-write")).not.toThrow();
    expect(() => assertAuthorityAttenuation("full", "read-only")).toThrow(/exceeds the parent/);

    expect(capabilitiesAreSubset(["fs.read"], ["fs.read", "process.exec"])).toBe(true);
    expect(capabilitiesAreSubset(["fs.write"], ["fs.read", "process.exec"])).toBe(false);
    expect(attenuateCapabilities(
      ["fs.write", "fs.read", "fs.write"],
      ["fs.read", "process.exec"],
    )).toEqual(["fs.read"]);
    expect(() =>
      assertCapabilityAttenuation(["fs.write"], ["fs.read", "process.exec"]),
    ).toThrow(/exceeds the parent/);
  });

  test("reviewer and explorer cannot be promoted into writers or network users", () => {
    expect(() => validateAgentProfile("reviewer", "read-only", ["fs.write"])).toThrow(
      /does not allow capability fs.write/,
    );
    expect(() => validateAgentProfile("explorer", "read-only", ["network"])).toThrow(
      /does not allow capability network/,
    );
    expect(() => validateAgentProfile("reviewer", "read-only", ["goal.write"])).toThrow(
      /does not allow capability goal.write/,
    );
    expect(() => validateAgentProfile("reviewer", "read-only", ["agent.spawn"])).toThrow(
      /does not allow capability agent.spawn/,
    );
  });

  test("review.write belongs to reviewer only", () => {
    expect(() =>
      validateAgentProfile("reviewer", "read-only", ["fs.read", "review.write"]),
    ).not.toThrow();
    expect(() =>
      validateAgentProfile("explorer", "read-only", ["fs.read", "review.write"]),
    ).toThrow(/does not allow capability review.write/);
  });

  test("authority none grants no capabilities", () => {
    expect(() => validateAgentProfile("main", "none", [])).not.toThrow();
    expect(() => validateAgentProfile("main", "none", ["fs.read"])).toThrow(
      /authority none cannot grant/,
    );
  });
});
