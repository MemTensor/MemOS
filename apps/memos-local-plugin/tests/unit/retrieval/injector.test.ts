import { describe, expect, it } from "vitest";

import { toPacket } from "../../../core/retrieval/injector.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type {
  EpisodeCandidate,
  ExperienceCandidate,
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

function experience(id: string): ExperienceCandidate {
  return {
    tier: "tier2",
    refKind: "experience",
    refId: id as never,
    cosine: 0.8,
    ts: NOW as never,
    vec: null,
    title: "SEC 13F extraction lesson",
    trigger: "similar SEC 13F parsing task",
    procedure: "Use holdings table columns directly.",
    verification: "Issuer/CUSIP come from the row fields.",
    boundary: "SEC 13F holdings extraction only.",
    support: 1,
    gain: 0.5,
    status: "active",
    experienceType: "failure_avoidance",
    evidencePolarity: "negative",
    salience: 0.9,
    confidence: 0.8,
    skillEligible: false,
    sourceEpisodeIds: [],
    sourceFeedbackIds: ["fb1" as never],
    sourceTraceIds: [],
    decisionGuidance: {
      preference: [],
      antiPattern: ["Do not infer issuer from filename."],
    },
    updatedAt: NOW as never,
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
  it("renders a task protocol even when no memory snippets matched", () => {
    const { packet } = toPacket({
      ranked: [],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_swe_protocol" as never,
      episodeId: "ep_swe_protocol" as never,
      taskProtocol: [
        "## Software engineering task protocol",
        "",
        "1. Treat the task repository as `/testbed`.",
        "2. Edit files with `WRAPPER_PATH write`.",
      ].join("\n"),
    });

    expect(packet.snippets).toHaveLength(0);
    expect(packet.rendered).toContain("Software engineering task protocol");
    expect(packet.rendered).toContain("WRAPPER_PATH write");
  });

  it("renders each candidate kind to snippet", () => {
    const ranked: RankedCandidate[] = [
      rc(skill("s1")),
      rc(trace("t1")),
      rc(episode("e1")),
      rc(experience("p1")),
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
    expect(packet.snippets.length).toBe(5);
    const kinds = packet.snippets.map((s) => s.refKind).sort();
    expect(kinds).toEqual([
      "episode",
      "experience",
      "skill",
      "trace",
      "world-model",
    ]);
    expect(packet.reason).toBe("turn_start");
    expect(mapping.length).toBe(packet.snippets.length);
    expect(packet.packetId).toMatch(/[a-z0-9_]+/);
  });

  it("renders experiences as a top-level section without internal metadata", () => {
    const { packet } = toPacket({
      ranked: [
        rc(trace("t_mem")),
        rc(experience("p_exp")),
        rc(world("w_env")),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_sections" as never,
      episodeId: "ep_sections" as never,
    });

    expect(packet.rendered).toContain("## Memories");
    expect(packet.rendered).toContain("### Relevant Trace Memories");
    expect(packet.rendered).toContain("## Experiences");
    expect(packet.rendered).toContain("## Environment Knowledge");
    expect(packet.rendered.indexOf("## Memories")).toBeLessThan(
      packet.rendered.indexOf("## Experiences"),
    );
    expect(packet.rendered.indexOf("## Experiences")).toBeLessThan(
      packet.rendered.indexOf("## Environment Knowledge"),
    );
    expect(packet.rendered).toContain("Trigger: similar SEC 13F parsing task");
    expect(packet.rendered).toContain("Use as guardrail before planning.");
    expect(packet.rendered).not.toContain("Do: Use holdings table columns directly.");
    expect(packet.rendered).not.toContain("Avoid: Do not infer issuer from filename.");
    expect(packet.rendered).not.toContain("Scope: SEC 13F holdings extraction only.");
    expect(packet.rendered).not.toContain(
      "Check: Issuer/CUSIP come from the row fields.",
    );
    expect(packet.rendered).toContain('memos_get(id="p_exp", kind="policy")');
    expect(packet.rendered).not.toContain('refId="p_exp"');
    expect(packet.rendered).not.toContain("Type:");
    expect(packet.rendered).not.toContain("confidence=");
    expect(packet.rendered).not.toContain("evidence=");
    expect(packet.rendered).not.toContain("support");
    expect(packet.rendered).not.toContain("gain");
    expect(packet.rendered).not.toContain("score");
  });

  it("renders LLM-actionable prose without noisy refId footers", () => {
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
    expect(packet.rendered).toContain("memos_search");
    // Row ids stay on the structured packet, but are not injected into
    // the model-facing prose unless a tool hint explicitly needs one.
    expect(packet.snippets[0]?.refId).toBe("sA");
    expect(packet.rendered).not.toContain('refId="sA"');
  });

  it("frames task protocol as current guidance instead of prior conversation memory", () => {
    const { packet } = toPacket({
      ranked: [rc(skill("s_protocol"), 0.9, 0.9)],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_protocol" as never,
      episodeId: "ep_protocol" as never,
      taskProtocol: "## Software engineering task protocol\n\nPatch first.",
    });

    expect(packet.rendered).toContain("Current task protocol and recalled memories");
    expect(packet.rendered).toContain("derived from the current user prompt");
    expect(packet.rendered).toContain("Patch first.");
    expect(packet.rendered).not.toContain("User's conversation history");
    expect(packet.rendered).not.toContain("MUST treat these as established knowledge");
    expect(packet.rendered).toContain("Candidate skills");
  });

  it("strips episode retrieval metrics from prompt-facing memory text", () => {
    const noisyEpisode = episode("e_noisy");
    noisyEpisode.summary = [
      "episode 3 steps · best V=0.82 · goal-sim=0.64",
      "step 1 (V=0.12)",
      "  user: install failed",
      "step 2 (V=0.82)",
      "  summary: install libpq-dev before retrying pip",
    ].join("\n");

    const { packet } = toPacket({
      ranked: [rc(noisyEpisode)],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_episode_metrics" as never,
      episodeId: "ep_episode_metrics" as never,
    });

    expect(packet.rendered).not.toContain("Past similar episode");
    expect(packet.rendered).toContain("install libpq-dev");
    expect(packet.rendered).toContain('memos_timeline(episodeId="e_noisy")');
    expect(packet.rendered).not.toMatch(/best V|goal-sim|V=/);
  });

  it("omits redundant Trigger line when it matches the experience title", () => {
    const exp = experience("p_dup");
    exp.title = "Use holdings columns";
    exp.trigger = "Use holdings columns";

    const { packet } = toPacket({
      ranked: [rc(exp)],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_exp_dup" as never,
      episodeId: "ep_exp_dup" as never,
    });

    expect(packet.rendered).toContain("1. Use holdings columns");
    expect(packet.rendered).toContain('memos_get(id="p_dup", kind="policy")');
    expect(packet.rendered).not.toMatch(/Trigger:\s*Use holdings columns/);
  });

  it("splits memories into past-task and trace subsections with per-item tool hints", () => {
    const { packet } = toPacket({
      ranked: [rc(episode("e1")), rc(trace("t1"))],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_mem_sections" as never,
      episodeId: "ep_mem_sections" as never,
    });

    expect(packet.rendered).toContain("## Memories");
    expect(packet.rendered).toContain("### Similar Past Tasks");
    expect(packet.rendered).toContain("### Relevant Trace Memories");
    expect(packet.rendered.indexOf("### Similar Past Tasks")).toBeLessThan(
      packet.rendered.indexOf("### Relevant Trace Memories"),
    );
    expect(packet.rendered).toContain("Past task ·");
    expect(packet.rendered).toContain("Trace ·");
    expect(packet.rendered).not.toContain("Sub-task ·");
    expect(packet.rendered).toContain('memos_timeline(episodeId="e1")');
    expect(packet.rendered).toContain("BEFORE your first tool call");
    expect(packet.rendered).toContain('memos_get(id="t1", kind="trace")');
    expect(packet.rendered).toContain("`memos_timeline(episodeId, limit?)`");
    expect(packet.rendered).toContain("call before your first tool call");
    expect(packet.rendered).toContain('`memos_get(id, kind="trace")`');
  });

  it("adds footer tool hints for experiences and world models", () => {
    const { packet } = toPacket({
      ranked: [rc(experience("p_footer")), rc(world("w_footer"))],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_footer" as never,
      episodeId: "ep_footer" as never,
    });

    expect(packet.rendered).not.toContain("## Memories");
    expect(packet.rendered).toContain('memos_get(id="p_footer", kind="policy")');
    expect(packet.rendered).toContain(
      'memos_get(id="w_footer", kind="world_model")',
    );
    expect(packet.rendered).toContain('`memos_get(id, kind="policy")`');
    expect(packet.rendered).toContain('`memos_get(id, kind="world_model")`');
    expect(packet.rendered).toContain("memos_search");
  });

  it("default skill rendering is summary mode (descriptor + memos_skill_get hint, no full guide)", () => {
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
    // Prompt-facing body carries the fields needed to identify candidate skills.
    expect(skillSnippet.title).toBe("Skill sk_summary");
    expect(skillSnippet.body).toContain("Name: Skill sk_summary");
    expect(skillSnippet.body).toContain(
      "Description: Fix Alpine container pip install failures by adding the missing -dev system library.",
    );
    // But it still omits internal skill metadata.
    expect(skillSnippet.body).not.toContain("η=0.85");
    expect(skillSnippet.body).not.toContain("status=active");
    // Procedure steps must NOT be inlined (those live behind memos_skill_get).
    expect(skillSnippet.body).not.toContain("apk add");
    expect(skillSnippet.body).not.toContain("Inspect the failing pip");
    // Body must instruct the agent how to fetch the full procedure on demand.
    expect(skillSnippet.body).toContain('memos_skill_get(id="sk_summary")');
    // Section heading + footer also advertise the call-on-demand workflow.
    expect(packet.rendered).toContain("Candidate skills");
    expect(packet.rendered).toContain("`memos_skill_get(id)`");
    expect(packet.rendered).not.toContain("`memos_skill_list");
    expect(packet.rendered).not.toContain("Name: Skill sk_summary");
  });

  it("standalone math rendering treats multiple skills as advisory methods without call hints", () => {
    const { packet } = toPacket({
      ranked: [
        rc(skill("sk_math_a", { invocationGuide: "Use parity when a grid coloring invariant is present." }), 0.9, 0.9),
        rc(skill("sk_math_b", { invocationGuide: "Use modular arithmetic when residues are explicit." }), 0.8, 0.8),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_math_multi" as never,
      episodeId: "ep_math_multi" as never,
      standaloneMathFinalAnswer: true,
    });

    expect(packet.snippets).toHaveLength(2);
    expect(packet.rendered).toContain("Retrieved prior problem-solving memories");
    expect(packet.rendered).toContain("Candidate method memories");
    expect(packet.rendered).toContain("not facts about the current problem");
    expect(packet.rendered).not.toContain("MUST treat these as established knowledge");
    expect(packet.rendered).not.toContain("memos_skill_get");
    expect(packet.rendered).toContain("MemOS memory tools remain available");
  });

  it("standalone math suppresses an isolated single solution skill but keeps advisory guidance", () => {
    const { packet } = toPacket({
      ranked: [
        rc(skill("sk_single", { invocationGuide: "Use random walk recurrence." }), 0.9, 0.9),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_math_single" as never,
      episodeId: "ep_math_single" as never,
      standaloneMathFinalAnswer: true,
      decisionGuidance: {
        preference: [{
          kind: "preference",
          text: "Prefer checking modular constraints.",
          sourcePolicyIds: ["p1"],
          sourceSkillIds: [],
        }],
        antiPattern: [{
          kind: "antiPattern",
          text: "Avoid treating a cycle as a line.",
          sourcePolicyIds: ["p2"],
          sourceSkillIds: [],
        }],
        policyIdsTouched: ["p1" as never, "p2" as never],
        skillIdsTouched: [],
      },
    });

    expect(packet.snippets).toHaveLength(0);
    expect(packet.rendered).toContain("Method guidance");
    expect(packet.rendered).toContain("Prefer checking modular constraints");
    expect(packet.rendered).toContain("Avoid treating a cycle as a line");
    expect(packet.rendered).not.toContain("Skill sk_single");
    expect(packet.rendered).not.toContain("memos_skill_get");
  });

  it("standalone math keeps isolated geometry setup skills as advisory scaffolding", () => {
    const { packet } = toPacket({
      ranked: [
        rc(skill("sk_geometry", {
          invocationGuide: [
            "Set up triangle geometry coordinates by placing a vertex at the origin and aligning a side with an axis.",
            "",
            "**Examples**",
            "- Expected: Vertex A placed at (0, 0).",
          ].join("\n"),
        }), 0.9, 0.9),
      ],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: NOW as never,
      sessionId: "sess_math_geometry" as never,
      episodeId: "ep_math_geometry" as never,
      standaloneMathFinalAnswer: true,
    });

    expect(packet.snippets).toHaveLength(1);
    expect(packet.rendered).toContain("Candidate method memories");
    expect(packet.rendered).toContain("Skill sk_geometry");
    expect(packet.rendered).toContain("not facts about the current problem");
    expect(packet.rendered).not.toContain("memos_skill_get");
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
    expect(skillSnippet.body).toContain('memos_skill_get(id="sk_clamp")');
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
    expect(skillSnippet.body).not.toContain("η=");
    expect(skillSnippet.body).not.toContain("memos_skill_get(id=");
    // The footer should not surface the skill call hints in full mode.
    expect(packet.rendered).not.toContain("`memos_skill_get(id)`");
    // Subsection headings are level-2 Markdown, nested under the packet's
    // level-1 "User's conversation history" header.
    expect(packet.rendered).toContain("## Skills");
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
    expect(packet.snippets[0]!.body.length).toBeLessThanOrEqual(720);
    expect(packet.snippets[0]!.body).toContain("[truncated]");
    expect(packet.snippets[0]!.body).toContain('memos_get(id="huge", kind="trace")');
  });
});
