import { describe, expect, it } from "vitest";

import {
  assessCompatibility,
  buildIntegrationPlan,
  getAgentProfile,
  listAgentProfiles,
  listCompatibilityCapabilities,
  supportMatrixFor,
} from "../../../agent-contract/compatibility.js";

describe("agent-contract/compatibility", () => {
  it("exposes the standard capability points", () => {
    expect(listCompatibilityCapabilities()).toContain("turn.prepare");
    expect(listCompatibilityCapabilities()).toContain("history.mine");
  });

  it("ships profiles for common agents", () => {
    expect(listAgentProfiles().map((p) => p.agentKind)).toEqual(
      expect.arrayContaining(["openclaw", "claude-code", "cursor", "aider", "claude-desktop"]),
    );
    expect(getAgentProfile("Cursor")?.recommendedMode).toBe("mcp");
  });

  it("assesses native integration as level L5", () => {
    const result = assessCompatibility({
      agentKind: "openclaw",
      signals: {
        hasAgentLoop: true,
        hasMemoryProvider: true,
      },
    });

    expect(result.compatible).toBe(true);
    expect(result.level).toBe("l5");
    expect(result.mode).toBe("native-integration");
    expect(result.coverage["turn.prepare"]).toBe("strong");
    expect(result.canAutoInject).toBe(true);
    expect(result.canAutoCapture).toBe(true);
  });

  it("falls back to historical connector when only history is available", () => {
    const result = assessCompatibility({
      agentKind: "private-agent",
      signals: {
        hasHistoryExport: true,
        canReadLogs: true,
      },
    });

    expect(result.compatible).toBe(true);
    expect(result.level).toBe("l0");
    expect(result.mode).toBe("historical-connector");
    expect(result.canMineHistory).toBe(true);
    expect(result.coverage["turn.prepare"]).toBe("n/a");
  });

  it("builds an integration plan with hooks and rollout order", () => {
    const plan = buildIntegrationPlan({
      agentKind: "Claude Code",
      signals: {
        hasLifecycleHooks: true,
        hasMcp: true,
      },
    });

    expect(plan.mode).toBe("hook-plugin");
    expect(plan.recommendedHooks).toContain("before_prompt_build");
    expect(plan.rolloutOrder.length).toBeGreaterThan(0);
    expect(plan.profile?.displayName).toBe("Claude Code");
  });

  it("returns a support matrix for MCP mode", () => {
    const matrix = supportMatrixFor("mcp");
    expect(matrix["memory.promote"]).toBe("weak");
    expect(matrix["feedback.record"]).toBe("medium");
  });
});
