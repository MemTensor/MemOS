import { describe, it, expect } from "vitest";

import {
  buildQuery,
  buildQueryWithExtract,
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

  it("turn_start focuses IR eval prompts on the ## Question section when domain=ir", () => {
    const question =
      "- Actor A was born in the 1950s in an Asian country\n- What is actor A's debut TV series called?";
    const cq = buildQuery(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_ir" as unknown as never,
        userText:
          "new task\n\nYou are a deep research agent. Answer the question by using the search tool to find relevant documents from a local knowledge base.\n\n" +
          "## CRITICAL RULES\n- You MUST ONLY use the \"search\" tool.\n\n" +
          "## Response Format\nWhen you have the answer, respond with:\nExplanation / Exact Answer / Confidence\n\n" +
          `## Question\n\n${question}`,
        ts: NOW,
      },
      { domain: "ir" },
    );
    expect(cq.text).toBe(question);
    expect(cq.text).not.toContain("deep research agent");
    expect(cq.text).not.toContain("CRITICAL RULES");
  });

  it("turn_start keeps full prompt when domain is not ir", () => {
    const raw =
      "new task\n\nYou are a deep research agent.\n\n## Question\n\nWho won?";
    const cq = buildQuery({
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s_ir" as unknown as never,
      userText: raw,
      ts: NOW,
    });
    expect(cq.text).toBe(raw);
  });

  it("tool_driven focuses IR eval prompts on the ## Question section when domain=ir", () => {
    const question =
      "Give me the name of the school that the below actress was expelled from: - She is 163 cm tall.";
    const cq = buildQuery(
      {
        reason: "tool_driven",
        agent: "openclaw",
        sessionId: "s_ir_tool" as unknown as never,
        tool: "memos_search",
        args: {
          query:
            "new task\n\nYou are a deep research agent. Answer the question by using the search tool to find relevant documents from a local knowledge base.\n\n" +
            "## CRITICAL RULES\n- You MUST ONLY use the \"search\" tool.\n\n" +
            "## Response Format\nExplanation / Exact Answer / Confidence\n\n" +
            `## Question\n\n${question}`,
          limit: 5,
        },
        ts: NOW,
      },
      { domain: "ir" },
    );
    expect(cq.text).toContain(question);
    expect(cq.text).toContain('"limit":5');
    expect(cq.text).not.toContain("deep research agent");
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

  it("preserves software repair prompts instead of applying benchmark-specific normalization", () => {
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
    expect(cq.text).toContain("WRAPPER_PATH");
    expect(cq.text).toContain("STRICT RULES");
    expect(cq.text).toContain("cleaned_data");
    expect(cq.text).toContain("ModelForm");
    expect(isSoftwareRepairPrompt(cq.text)).toBe(true);
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
