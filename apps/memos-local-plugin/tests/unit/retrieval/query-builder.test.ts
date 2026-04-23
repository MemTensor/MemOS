import { describe, it, expect } from "vitest";

import { buildQuery, extractTags } from "../../../core/retrieval/query-builder.js";
import type { EpochMs } from "../../../core/types.js";

const NOW = 1_700_000_000_000 as EpochMs;

describe("retrieval/query-builder", () => {
  it("turn_start embeds userText + hints", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s1" as unknown as never,
      userText: "Fix this docker compose file",
      contextHints: { cwd: "/tmp/x", role: "planner" },
      ts: NOW,
    });
    expect(cq.text).toContain("Fix this docker compose file");
    expect(cq.text).toContain("cwd: /tmp/x");
    expect(cq.text).toContain("role: planner");
    expect(cq.tags).toContain("docker");
    expect(cq.truncated).toBe(false);
  });

  it("tool_driven serialises args JSON + tool name", () => {
    const cq = buildQuery({
      reason: "tool_driven",
      agent: "openclaw",
      sessionId: "s1" as unknown as never,
      tool: "memory_search",
      args: { query: "past docker bugs", limit: 5 },
      ts: NOW,
    });
    expect(cq.text).toContain("tool:memory_search");
    expect(cq.text).toContain('"query":"past docker bugs"');
    expect(cq.tags).toContain("docker");
  });

  it("skill_invoke prepends skill id when provided", () => {
    const cq = buildQuery({
      reason: "skill_invoke",
      agent: "openclaw",
      sessionId: "s1" as unknown as never,
      skillId: "sk_123" as unknown as never,
      query: "run pytest on api module",
      ts: NOW,
    });
    expect(cq.text.startsWith("skill:sk_123")).toBe(true);
    expect(cq.tags).toContain("test");
  });

  it("sub_agent merges profile + mission", () => {
    const cq = buildQuery({
      reason: "sub_agent",
      agent: "hermes",
      sessionId: "s2" as unknown as never,
      profile: "coder",
      mission: "refactor SQL queries and add typescript types",
      ts: NOW,
    });
    expect(cq.text).toContain("profile:coder");
    expect(cq.text).toContain("refactor SQL queries");
    expect(cq.tags).toContain("sql");
    expect(cq.tags).toContain("typescript");
  });

  it("decision_repair uses failing tool + error code", () => {
    const cq = buildQuery({
      reason: "decision_repair",
      agent: "openclaw",
      sessionId: "s3" as unknown as never,
      failingTool: "pip.install",
      failureCount: 3,
      lastErrorCode: "NETWORK_REFUSED",
      ts: NOW,
    });
    expect(cq.text).toContain("failing_tool:pip.install");
    expect(cq.text).toContain("failures:3");
    expect(cq.text).toContain("error:NETWORK_REFUSED");
    expect(cq.tags).toContain("pip");
    expect(cq.tags).toContain("network");
  });

  it("truncates oversize query, preserving head + tail", () => {
    const big = "x".repeat(5_000);
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s" as unknown as never,
      userText: big,
      ts: NOW,
    });
    expect(cq.truncated).toBe(true);
    expect(cq.text).toContain("[truncated]");
    expect(cq.text.startsWith("x")).toBe(true);
    expect(cq.text.endsWith("x")).toBe(true);
  });

  it("returns empty tags when no keywords match", () => {
    expect(extractTags("how are you today friend")).toEqual([]);
  });

  it("dedupes tags (case insensitive)", () => {
    expect(extractTags("Docker container DOCKER")).toEqual(["docker"]);
  });
});
