import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedHome } from "../../../core/config/index.js";
import {
  OPENCLAW_RUNTIME_PROTOCOL,
  assertCompatibleSharedRuntime,
  sharedRuntimeHealth,
} from "../../../adapters/openclaw/runtime-protocol.js";
import { sharedRuntimeSocketPath } from "../../../adapters/openclaw/runtime-paths.js";

function home(root: string): ResolvedHome {
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    dataDir: path.join(root, "data"),
    dbFile: path.join(root, "data", "memos.db"),
    skillsDir: path.join(root, "skills"),
    logsDir: path.join(root, "logs"),
    daemonDir: path.join(root, "daemon"),
  };
}

describe("agent-neutral shared runtime contract", () => {
  it("advertises multi-process Hermes support", () => {
    const runtime = sharedRuntimeHealth("hermes", "2.0.11-eval.1");
    expect(runtime).toMatchObject({
      protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
      pluginVersion: "2.0.11-eval.1",
      runtimeMode: "shared-ipc",
      multiProcess: true,
      agent: "hermes",
    });
    expect(runtime.capabilities).toContain("hermes.shared-runtime.v1");
  });

  it("accepts the expected agent and rejects a different owner", () => {
    const health = {
      agent: "hermes",
      runtime: sharedRuntimeHealth("hermes", "test"),
    };
    expect(() =>
      assertCompatibleSharedRuntime(health, {
        expectedAgent: "hermes",
        expectedPluginVersion: "test",
      }),
    ).not.toThrow();
    expect(() =>
      assertCompatibleSharedRuntime(health, { expectedAgent: "openclaw" }),
    ).toThrow(/agent/i);
  });

  it("uses one database-scoped endpoint namespace with agent identity", () => {
    const hermes = sharedRuntimeSocketPath(home("/tmp/shared-home"), "hermes", "linux");
    const openclaw = sharedRuntimeSocketPath(home("/tmp/shared-home"), "openclaw", "linux");
    expect(hermes).not.toBe(openclaw);
    expect(hermes).toContain("memos-hermes-");
    expect(hermes.length).toBeLessThan(100);
  });
});
