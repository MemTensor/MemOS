import { describe, it, expect } from "vitest";

import {
  buildQuery,
  extractTags,
  isSoftwareRepairPrompt,
} from "../../../core/retrieval/query-builder.js";
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

  it("tool_driven uses explicit search query text when present", () => {
    const cq = buildQuery({
      reason: "tool_driven",
      agent: "openclaw",
      sessionId: "s1" as unknown as never,
      tool: "memos_search",
      args: { query: "past docker bugs", limit: 5 },
      ts: NOW,
    });
    expect(cq.text).toContain("past docker bugs");
    expect(cq.text).toContain('"limit":5');
    expect(cq.text).not.toContain("tool:memos_search");
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

  it("extracts math reasoning tags for standalone math prompts", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_math" as unknown as never,
      userText:
        "Please solve this olympiad-style combinatorics problem. Compute the number of paths in a circle modulo 42.",
      contextHints: {
        domain: "Mathematics -> Discrete Mathematics -> Combinatorics",
      },
      ts: NOW,
    });
    expect(cq.tags).toContain("math");
    expect(cq.tags).toContain("reasoning");
    expect(cq.tags).toContain("combinatorics");
    expect(cq.tags).toContain("number_theory");
  });

  it("uses the markdown problem body for keyword retrieval", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_math_problem" as unknown as never,
      userText:
        "new task\n\nPlease solve this olympiad-style problem and give the final answer.\n\n" +
        "**Problem:**\nThere are 42 stepping stones in a pond arranged along a circle. You may jump by 1 or 7 stones.\n\n" +
        "**Formatting:** Give a concise solution and finish with \\boxed{...}.",
      ts: NOW,
    });
    expect(cq.text).toContain("42 stepping stones");
    expect(cq.text).not.toContain("new task");
    expect(cq.ftsMatch).toContain('"stepping"');
    expect(cq.ftsMatch).not.toContain('"following"');
  });

  it("uses the repair bug description instead of wrapper guardrails", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_swe" as unknown as never,
      userText:
        "new task\n\n" +
        "WRAPPER_PATH: /tmp/swebench-job-example__project-00000-t1-exec\n\n" +
        "You need to fix a bug in the django/django repository. Time limit: 30 minutes.\n\n" +
        "[STRICT RULES]\n" +
        "- All commands MUST be executed via WRAPPER_PATH\n" +
        "- To write files, use WRAPPER_PATH write, NOT tmux-run + cat/heredoc\n\n" +
        "## Workflow\n1. Understand the bug from the problem statement\n\n" +
        "## Bug Description\n\n" +
        "A ModelForm cleanup path fails to apply validated cleaned_data to an instance when a submitted value is present.\n" +
        "The fix should preserve missing-data behavior while allowing explicit cleaned_data values to reach the model.\n\n" +
        "Reply TASK_COMPLETE when done.",
      ts: NOW,
    });
    expect(cq.text).toContain("software_engineering python test bug fix");
    expect(cq.text).toContain("repo: django/django");
    expect(cq.text).toContain("cleaned_data");
    expect(cq.text).toContain("ModelForm");
    expect(cq.text).not.toContain("WRAPPER_PATH");
    expect(cq.text).not.toContain("STRICT RULES");
    expect(cq.tags).toContain("python");
    expect(cq.tags).toContain("test");
    expect(isSoftwareRepairPrompt(cq.text)).toBe(false);
    expect(
      isSoftwareRepairPrompt(
        "You need to fix a bug in the django/django repository.\n\n## Bug Description\n\nBroken form default.",
      ),
    ).toBe(true);
  });

  it("does not synthesize benchmark-specific keywords for structured math prompts", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_math_cycle" as unknown as never,
      userText:
        "There are 42 stepping stones in a pond, arranged along a circle. " +
        "You jump by either 1 stone or 7 stones and visit each stone exactly once before returning.",
      ts: NOW,
    });
    expect(cq.ftsMatch).toContain('"stepping"');
    expect(cq.ftsMatch).toContain('"circle"');
    expect(cq.ftsMatch).not.toContain('"hamiltonian"');
    expect(cq.ftsMatch).not.toContain('"modular"');
  });
});
