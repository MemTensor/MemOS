import { describe, it, expect } from "vitest";

import {
  buildQuery,
  buildQueryWithExtract,
  extractTags,
  isRepositoryRepairPrompt,
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

  it("preserves markdown problem prompts instead of applying format-specific normalization", () => {
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
    expect(cq.text).toContain("new task");
    expect(cq.text).toContain("**Problem:**");
    expect(cq.ftsMatch).toContain('("new" "task" "Please")');
    expect(cq.ftsMatch).toContain('("Please" "solve" "olympiad-style")');
  });

  it("uses the repair issue description instead of wrapper guardrails", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_repair" as unknown as never,
      userText:
        "new task\n\n" +
        "COMMAND_WRAPPER: /tmp/repair-job-example-exec\n\n" +
        "You need to fix a bug in the example-org/service-toolkit repository. Time limit: 30 minutes.\n\n" +
        "[STRICT RULES]\n" +
        "- All commands MUST be executed via COMMAND_WRAPPER\n" +
        "- To write files, use COMMAND_WRAPPER write, NOT run + cat/heredoc\n\n" +
        "## Workflow\n1. Understand the bug from the problem statement\n\n" +
        "## Bug Description\n\n" +
        "A request normalization path returns the internal path when the public route prefix is configured.\n" +
        "The fix should preserve internal validation while returning the externally visible route.\n\n" +
        "Reply DONE when done.",
      ts: NOW,
    });
    expect(cq.text).toContain("repository repair source fix");
    expect(cq.text).toContain("repo: example-org/service-toolkit");
    expect(cq.text).toContain("request normalization");
    expect(cq.text).toContain("public route prefix");
    expect(cq.text).not.toContain("COMMAND_WRAPPER");
    expect(cq.text).not.toContain("STRICT RULES");
    expect(isRepositoryRepairPrompt(cq.text)).toBe(false);
    expect(
      isRepositoryRepairPrompt(
        "You need to fix a bug in the example-org/service-toolkit repository.\n\n## Bug Description\n\nBroken request routing.",
      ),
    ).toBe(true);
  });

  it("normalizes repository repair prompts to visible issue and hints", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_repair" as unknown as never,
      userText: [
        "new task",
        "",
        "RUNNER_HANDLE: /tmp/repair-exec",
        "You need to fix a bug in the example-org/service-toolkit repository. Time limit: 30 minutes.",
        "",
        "[STRICT RULES]",
        "All commands must use the wrapper.",
        "",
        "## Bug Description",
        "A request handler returns an internal path when a public route prefix is configured.",
        "",
        "Reply TASK_COMPLETE when done.",
        "",
        "## Hints",
        "Check the route normalization helper and the response builder.",
      ].join("\n"),
      ts: NOW,
    });

    expect(cq.text).toContain("repository repair source fix");
    expect(cq.text).toContain("repo: example-org/service-toolkit");
    expect(cq.text).toContain("public route prefix");
    expect(cq.text).toContain("route normalization helper");
    expect(cq.text).not.toContain("RUNNER_HANDLE");
    expect(cq.text).not.toContain("STRICT RULES");
    expect(cq.text).not.toContain("Time limit");
    expect(cq.text).not.toContain("TASK_COMPLETE");
  });

  it("does not synthesize unrelated keywords for structured math prompts", () => {
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
    expect(cq.ftsMatch).not.toContain('"hamiltonian"');
    expect(cq.ftsMatch).not.toContain('"modular"');
  });

  it("uses the first five keyword tokens from the complete input without scoring", () => {
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_lifestyle_pdf" as unknown as never,
      userText:
        "You are given an occupational task to complete. Read the description carefully and produce the requested artifact.\n\n" +
        "General instructions: use appropriate tools, inspect files when needed, and reply when complete.\n\n" +
        "Create a two-page PDF itinerary for a seven-day Bahamas yacht trip. Include royalty-free photos for each destination, family snorkeling activities, and waterfront dining recommendations.",
      ts: NOW,
    });

    expect(cq.text).toContain("occupational task");
    expect(cq.text).toContain("Bahamas yacht trip");
    expect(cq.ftsMatch).toContain('("given" "occupational" "task")');
    expect(cq.ftsMatch).toContain('("task" "complete" "Read")');
  });

  it("falls back to raw query text when extracted queryVecText is not usable", () => {
    const cq = buildQueryWithExtract(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_bad_extract" as unknown as never,
        userText: "Investigate memos_search policy recall for po_7x7aq1k9q4ba",
        ts: NOW,
      },
      { queryVecText: ".", keywords: ["policy", "recall"] },
    );

    expect(cq.text).toContain("memos_search policy recall");
    expect(cq.text).not.toBe(".");
  });

  it("falls back to query text for pattern terms when extracted keywords miss short terms", () => {
    const cq = buildQueryWithExtract(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_pattern_fallback" as unknown as never,
        userText: "检查向量召回和po策略",
        ts: NOW,
      },
      { queryVecText: "检查向量召回和po策略", keywords: ["retrieval"] },
    );

    expect(cq.patternTerms).toContain("向量");
    expect(cq.patternTerms).toContain("po");
  });
});
