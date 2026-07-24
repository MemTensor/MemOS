import { describe, expect, it } from "vitest";

import {
  IncompatibleOpenClawRuntimeError,
  OPENCLAW_RUNTIME_PROTOCOL,
  assertCompatibleOpenClawRuntime,
  isReplaySafeOpenClawRuntimeMethod,
} from "../../../adapters/openclaw/runtime-protocol.js";

function health(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    agent: "openclaw",
    paths: { db: "/tmp/memos.db" },
    runtime: {
      protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
      protocolMinor: OPENCLAW_RUNTIME_PROTOCOL.minor,
      pluginVersion: "test",
      capabilities: [...OPENCLAW_RUNTIME_PROTOCOL.requiredCapabilities],
    },
    ...overrides,
  };
}

describe("OpenClaw runtime protocol", () => {
  it("accepts the same major and every required capability", () => {
    expect(() => assertCompatibleOpenClawRuntime(health())).not.toThrow();
  });

  it("rejects legacy daemons without a protocol handshake", () => {
    expect(() =>
      assertCompatibleOpenClawRuntime(health({ runtime: undefined })),
    ).toThrow(IncompatibleOpenClawRuntimeError);
  });

  it("rejects a different major or a missing required capability", () => {
    expect(() =>
      assertCompatibleOpenClawRuntime(
        health({
          runtime: {
            protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major + 1,
            protocolMinor: 0,
            pluginVersion: "future",
            capabilities: [...OPENCLAW_RUNTIME_PROTOCOL.requiredCapabilities],
          },
        }),
      ),
    ).toThrow(/protocol major/i);

    expect(() =>
      assertCompatibleOpenClawRuntime(
        health({
          runtime: {
            protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
            protocolMinor: OPENCLAW_RUNTIME_PROTOCOL.minor,
            pluginVersion: "incomplete",
            capabilities: [],
          },
        }),
      ),
    ).toThrow(/capabilit/i);
  });

  it("only permits automatic replay for read-only requests", () => {
    expect(isReplaySafeOpenClawRuntimeMethod("core.health")).toBe(true);
    expect(isReplaySafeOpenClawRuntimeMethod("memory.get_trace")).toBe(true);
    expect(isReplaySafeOpenClawRuntimeMethod("memory.search")).toBe(true);

    expect(isReplaySafeOpenClawRuntimeMethod("turn.start")).toBe(false);
    expect(isReplaySafeOpenClawRuntimeMethod("turn.end")).toBe(false);
    expect(isReplaySafeOpenClawRuntimeMethod("feedback.submit")).toBe(false);
    expect(isReplaySafeOpenClawRuntimeMethod("tool_outcome.record")).toBe(false);
    expect(isReplaySafeOpenClawRuntimeMethod("subagent.record")).toBe(false);
    expect(isReplaySafeOpenClawRuntimeMethod("skill.get")).toBe(false);
  });
});
