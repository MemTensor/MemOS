import { describe, expect, it } from "vitest";

import { toPacket } from "../../../core/retrieval/injector.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type {
  EpisodeCandidate,
  SkillCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "../../../core/retrieval/types.js";

const NOW = 1_700_000_000_000 as unknown as number;

function rc<C extends { tier: string }>(c: C, relevance = 0.8, score = 0.75): RankedCandidate {
  return {
    candidate: c as unknown as RankedCandidate["candidate"],
    relevance,
    rrf: 0.01,
    score,
    normSq: null,
  };
}

function skill(id: string, opts?: { invocationGuide?: string }): SkillCandidate {
  return {
    tier: "tier1",
    refKind: "skill",
    refId: id as never,
    cosine: 0.9,
    ts: NOW as never,
    vec: null,
    skillName: `Skill ${id}`,
    eta: 0.85,
    status: "active",
    invocationGuide: opts?.invocationGuide ?? "Do the thing.",
  };
}

function trace(id: string): TraceCandidate {
  return {
    tier: "tier2",
    refKind: "trace",
    refId: id as never,
    cosine: 0.7,
    ts: NOW as never,
    vec: null,
    value: 0.6,
    priority: 0.6,
    episodeId: "ep1" as never,
    sessionId: "s1" as never,
    vecKind: "summary",
    userText: "user said x",
    agentText: "agent replied y",
    summary: null,
    reflection: "key thing happened",
    tags: ["docker"],
  };
}

function episode(id: string): EpisodeCandidate {
  return {
    tier: "tier2",
    refKind: "episode",
    refId: id as never,
    cosine: 0.5,
    ts: NOW as never,
    vec: null,
    sessionId: "s1" as never,
    summary: "episode rollup summary",
    maxValue: 0.9,
    meanPriority: 0.4,
  };
}

function world(id: string): WorldModelCandidate {
  return {
    tier: "tier3",
    refKind: "world-model",
    refId: id as never,
    cosine: 0.6,
    ts: NOW as never,
    vec: null,
    title: `wm ${id}`,
    body: "topology + rules",
    policyIds: ["p1"],
  };
}

describe("retrieval/injector", () => {
  it("renders each candidate kind to snippet", () => {
    const ranked: RankedCandidate[] = [
      rc(skill("s1")),
      rc(trace("t1")),
      rc(episode("e1")),
      rc(world("w1")),
    ];
    const { packet, mapping } = toPacket({
      ranked,
      reason: "turn_start",
      tierLatencyMs: { tier1: 1, tier2: 2, tier3: 3 },
      now: NOW as never,
      sessionId: "sess_t1" as never,
      episodeId: "ep_t1" as never,
    });
    expect(packet.snippets.length).toBe(4);
    const kinds = packet.snippets.map((s) => s.refKind).sort();
    expect(kinds).toEqual(["episode", "skill", "trace", "world-model"]);
    expect(packet.reason).toBe("turn_start");
    expect(mapping.length).toBe(packet.snippets.length);
    expect(packet.packetId).toMatch(/[a-z0-9_]+/);
  });

  it("renders LLM-actionable prose (header, MUST-treat instructions, refId footer)", () => {
    const { packet } = toPacket({
      ranked: [rc(skill("sA"), 0.9, 0.9)],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_t2" as never,
      episodeId: "ep_t2" as never,
    });
    // Matches the legacy `memos-local-openclaw` adapter format.
    expect(packet.rendered).toContain("User's conversation history");
    expect(packet.rendered).toContain("MUST treat");
    // Trailing tool reminder so the model knows how to re-query.
    expect(packet.rendered).toContain("memory_search");
    // Every snippet must carry its `refId` so downstream tool calls
    // (memory_get / memory_timeline) can round-trip to the row.
    expect(packet.rendered).toContain('refId="sA"');
  });

  it("default skill rendering is summary mode (descriptor + skill_get hint, no full guide)", () => {
    // Multi-section guide: blank-line-separated paragraphs. Summary
    // mode must keep only the first paragraph and drop the procedure.
    const guide = [
      "Fix Alpine container pip install failures by adding the missing -dev system library.",
      "## Procedure",
      "1. Inspect the failing pip install error.",
      "2. Identify the missing system library (e.g. xmlsec1, libpq-dev).",
      "3. Run `apk add <name>-dev` then rerun pip install.",
    ].join("\n\n");
    const { packet } = toPacket({
      ranked: [rc(skill("sk_summary", { invocationGuide: guide }), 0.9, 0.9)],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_summary" as never,
      episodeId: "ep_summary" as never,
    });
    const skillSnippet = packet.snippets.find((s) => s.refKind === "skill")!;
    // Descriptor line carries name + η + status — short metadata, not a guide.
    expect(skillSnippet.body).toContain("Skill sk_summary");
    expect(skillSnippet.body).toContain("η=0.85");
    // First paragraph survives as the summary line.
    expect(skillSnippet.body).toContain("Fix Alpine container pip install");
    // Procedure steps must NOT be inlined (those live behind skill_get).
    expect(skillSnippet.body).not.toContain("apk add");
    expect(skillSnippet.body).not.toContain("Inspect the failing pip");
    // Body must instruct the agent how to fetch the full procedure on demand.
    expect(skillSnippet.body).toContain('skill_get(id="sk_summary")');
    // Section heading + footer also advertise the call-on-demand workflow.
    expect(packet.rendered).toContain("Candidate skills");
    expect(packet.rendered).toContain("`skill_get(id)`");
    expect(packet.rendered).toContain("`skill_list");
  });

  it("summary mode clamps long first paragraphs to skillSummaryChars", () => {
    const longFirstPara = "x".repeat(800);
    const { packet } = toPacket({
      ranked: [
        rc(skill("sk_clamp", { invocationGuide: longFirstPara }), 0.9, 0.9),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_clamp" as never,
      episodeId: "ep_clamp" as never,
      skillSummaryChars: 80,
    });
    const skillSnippet = packet.snippets.find((s) => s.refKind === "skill")!;
    // Descriptor + summary + call hint, none of which exceed the cap by much.
    expect(skillSnippet.body).toMatch(/x{60,80}…/);
    expect(skillSnippet.body).toContain('skill_get(id="sk_clamp")');
  });

  it("full mode inlines the invocation guide (legacy behaviour)", () => {
    const { packet } = toPacket({
      ranked: [
        rc(skill("sk_full", { invocationGuide: "RUN docker compose up -d" }), 0.9, 0.9),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_full" as never,
      episodeId: "ep_full" as never,
      skillInjectionMode: "full",
    });
    const skillSnippet = packet.snippets.find((s) => s.refKind === "skill")!;
    expect(skillSnippet.body).toContain("RUN docker compose up -d");
    expect(skillSnippet.body).not.toContain("skill_get(id=");
    // The footer should not surface the skill call hints in full mode.
    expect(packet.rendered).not.toContain("`skill_get(id)`");
    expect(packet.rendered).toContain("# Skills");
  });

  it("empty ranked list produces empty rendered string", () => {
    const { packet } = toPacket({
      ranked: [],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_t3" as never,
      episodeId: "ep_t3" as never,
    });
    expect(packet.rendered).toBe("");
    expect(packet.snippets.length).toBe(0);
  });

  it("truncates oversized trace bodies", () => {
    const big = trace("huge");
    big.agentText = "x".repeat(10_000);
    const { packet } = toPacket({
      ranked: [rc(big)],
      reason: "tool_driven",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_t4" as never,
      episodeId: "ep_t4" as never,
    });
    expect(packet.snippets[0]!.body.length).toBeLessThanOrEqual(700);
    expect(packet.snippets[0]!.body).toContain("[truncated]");
  });
});
