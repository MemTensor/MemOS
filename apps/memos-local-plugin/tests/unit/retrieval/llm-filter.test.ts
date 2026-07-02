import { describe, expect, it, vi } from "vitest";

import { llmFilterCandidates } from "../../../core/retrieval/llm-filter.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type {
  RetrievalConfig,
  TraceCandidate,
} from "../../../core/retrieval/types.js";

const cfg: Pick<
  RetrievalConfig,
  | "llmFilterEnabled"
  | "llmFilterMaxKeep"
  | "llmFilterMinCandidates"
  | "llmFilterCandidateBodyChars"
> = {
  llmFilterEnabled: true,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
  llmFilterCandidateBodyChars: 500,
};

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function trace(id: string, score: number): RankedCandidate {
  const cand: TraceCandidate = {
    tier: "tier2",
    refKind: "trace",
    refId: id as never,
    cosine: score,
    ts: 1_700_000_000_000 as never,
    vec: null,
    value: 0.5 as never,
    priority: 0.5 as never,
    episodeId: "e1" as never,
    sessionId: "s1" as never,
    vecKind: "summary",
    userText: `user ${id}`,
    agentText: `agent ${id}`,
    summary: `summary ${id}`,
    reflection: null,
    tags: ["sample"],
    channels: [{ channel: "vec_summary", rank: 0, score }],
  };
  return {
    candidate: cand,
    relevance: score,
    rrf: 0,
    score,
    normSq: null,
  };
}

/**
 * Build a trace candidate with no LLM-generated summary / reflection
 * and only a short acknowledgement-style `agentText` — i.e. exactly the
 * "near-duplicate question trace" shape from issue #1913 where the
 * user re-asked a stored fact across multiple sessions and the
 * assistant only acked it. The current LLM filter prompt classes these
 * as "scaffolding chatter" and is allowed to drop them all.
 */
function chatterTrace(
  id: string,
  score: number,
  overrides: { agentText?: string; userText?: string } = {},
): RankedCandidate {
  const r = trace(id, score);
  const cand = r.candidate as TraceCandidate;
  return {
    ...r,
    candidate: {
      ...cand,
      userText: overrides.userText ?? `What does HERMES_REAL_E2E_1910 mean? (${id})`,
      agentText: overrides.agentText ?? "OK",
      summary: null,
      reflection: null,
    },
  };
}

describe("retrieval/llm-filter", () => {
  it("disabled → passthrough with null sufficient", async () => {
    const result = await llmFilterCandidates(
      { query: "anything", ranked: [trace("a", 0.9), trace("b", 0.5)] },
      { llm: null, log, config: { ...cfg, llmFilterEnabled: false } },
    );
    expect(result.outcome).toBe("disabled");
    expect(result.kept.length).toBe(2);
    expect(result.sufficient).toBeNull();
  });

  it("below threshold → passthrough (minCandidates can lift the gate)", async () => {
    const result = await llmFilterCandidates(
      { query: "x", ranked: [trace("only", 0.9)] },
      { llm: null, log, config: { ...cfg, llmFilterMinCandidates: 5 } },
    );
    expect(result.outcome).toBe("below_threshold");
    expect(result.kept.length).toBe(1);
    expect(result.sufficient).toBeNull();
  });

  it("single candidate → filter still runs at minCandidates=1 default", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [1], sufficient: true },
        servedBy: "fake",
      }),
    };
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("solo", 0.9)] },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_kept_all");
    expect(result.kept.map((r) => String(r.candidate.refId))).toEqual(["solo"]);
    expect(result.sufficient).toBe(true);
  });

  it("LLM returns selected indices → filters precisely and surfaces sufficient", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [1, 3], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = [trace("a", 0.9), trace("b", 0.8), trace("c", 0.7)];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_filtered");
    expect(result.kept.map((r) => String(r.candidate.refId))).toEqual(["a", "c"]);
    expect(result.dropped.map((r) => String(r.candidate.refId))).toEqual(["b"]);
    expect(result.sufficient).toBe(false);
  });

  it("LLM returns ranked indices → code truncates by llmFilterMaxKeep", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { ranked: [3, 1, 4, 2], sufficient: true },
        servedBy: "fake",
      }),
    };
    const ranked = [
      trace("a", 0.9),
      trace("b", 0.8),
      trace("c", 0.7),
      trace("d", 0.6),
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 2 } },
    );
    expect(result.outcome).toBe("llm_filtered");
    expect(result.kept.map((r) => String(r.candidate.refId))).toEqual(["c", "a"]);
    expect(result.dropped.map((r) => String(r.candidate.refId))).toEqual(["b", "d"]);
    expect(result.sufficient).toBe(true);
  });

  it("LLM returns empty selection over non-empty ranked → rescues top-K informative candidates (#1913)", async () => {
    // Issue #1913 repro shape: 3 near-duplicate question traces from
    // previous sessions plus 1 answer-bearing trace. Previous filter
    // honoured `selected: []` and collapsed to empty injection.
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = [
      chatterTrace("q1", 0.95),
      chatterTrace("q2", 0.94),
      // Answer-bearing trace: long informative agentText, even though
      // the ranker placed it below the question duplicates.
      (() => {
        const r = trace("answer", 0.85);
        const c = r.candidate as TraceCandidate;
        return {
          ...r,
          candidate: {
            ...c,
            userText:
              "Remember this fact: HERMES_REAL_E2E_1910 means the bridge leak fix verification.",
            agentText: "Noted. HERMES_REAL_E2E_1910 → bridge leak fix verification.",
            summary:
              "HERMES_REAL_E2E_1910 marks the bridge-leak fix verification.",
            reflection: null,
          },
        };
      })(),
      chatterTrace("q3", 0.8),
    ];
    const result = await llmFilterCandidates(
      { query: "What does HERMES_REAL_E2E_1910 mean?", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_filtered_refilled");
    expect(result.kept.length).toBeGreaterThanOrEqual(1);
    expect(result.kept[0]!.candidate.refId).toBe("answer");
    expect(result.sufficient).toBe(false);
    // Strong negative assertion: the bug returned kept=[], dropped=ranked.
    expect(result.dropped.length).toBeLessThan(ranked.length);
  });

  it("rescue fires even when every ranked candidate is short-ack chatter", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = [
      chatterTrace("q1", 0.9, { agentText: "OK" }),
      chatterTrace("q2", 0.85, { agentText: "记住了" }),
      chatterTrace("q3", 0.8, { agentText: "👍" }),
    ];
    const result = await llmFilterCandidates(
      { query: "What does HERMES_REAL_E2E_1910 mean?", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_filtered_refilled");
    // No informative candidate exists — rescue still keeps top-K by
    // ranker score so the agent at least sees one memory.
    expect(result.kept.length).toBeGreaterThanOrEqual(1);
    expect(result.kept[0]!.candidate.refId).toBe("q1"); // highest score
    expect(result.sufficient).toBe(false);
  });

  it("rescue respects llmFilterMaxKeep cap", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = [
      trace("a", 0.95),
      trace("b", 0.9),
      trace("c", 0.85),
      trace("d", 0.8),
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 2 } },
    );
    expect(result.outcome).toBe("llm_filtered_refilled");
    expect(result.kept.length).toBe(2);
    expect(result.dropped.length).toBe(2);
  });

  it("llmFilterMaxKeep=0 disables rescue: honours empty selection (drop-everything override)", async () => {
    // This is the only configured way to ask the filter to truly drop
    // everything; keep it explicit so operators have an escape hatch.
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = [trace("a", 0.9), trace("b", 0.8)];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 0 } },
    );
    expect(result.outcome).toBe("llm_filtered");
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(2);
    expect(result.sufficient).toBe(false);
  });

  it("LLM returns empty selection with empty ranked list → unchanged (still llm_filtered, kept=[])", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [], sufficient: false },
        servedBy: "fake",
      }),
    };
    // ranked empty but minCandidates=0 so the filter still runs
    const result = await llmFilterCandidates(
      { query: "q", ranked: [] },
      { llm, log, config: { ...cfg, llmFilterMinCandidates: 0 } },
    );
    expect(result.outcome).toBe("below_threshold");
    expect(result.kept.length).toBe(0);
  });

  it("coerces string / number `sufficient` fields sent by lax models", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [1], sufficient: "yes" },
        servedBy: "fake",
      }),
    };
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.9)] },
      { llm, log, config: cfg },
    );
    expect(result.sufficient).toBe(true);
  });

  it("LLM throws → mechanical safe cutoff (NOT passthrough)", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("network kaboom")),
    };
    const ranked = [
      trace("strong", 0.9),
      trace("middle", 0.6),
      trace("weak", 0.05),
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
    expect(result.sufficient).toBeNull();
    const ids = result.kept.map((r) => String(r.candidate.refId));
    expect(ids).toContain("strong");
    expect(ids).not.toContain("weak");
  });

  it("safe-cutoff still keeps at least 1 candidate even if all are weak", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.5), trace("b", 0.49)] },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
    expect(result.kept.length).toBeGreaterThanOrEqual(1);
  });

  it("safe-cutoff respects llmFilterMaxKeep cap", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const ranked = [
      trace("a", 0.95),
      trace("b", 0.94),
      trace("c", 0.93),
      trace("d", 0.92),
      trace("e", 0.91),
      trace("f", 0.9),
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 2 } },
    );
    expect(result.kept.length).toBeLessThanOrEqual(2);
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
  });

  it("safe-cutoff respects a zero llmFilterMaxKeep cap", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.9), trace("b", 0.8)] },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 0 } },
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped.length).toBe(2);
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
  });

  it("no LLM at all → passthrough (not safe-cutoff, since the call never happens)", async () => {
    const result = await llmFilterCandidates(
      {
        query: "q",
        ranked: [trace("a", 0.9), trace("b", 0.8), trace("c", 0.7)],
      },
      { llm: null, log, config: cfg },
    );
    expect(result.outcome).toBe("no_llm");
    expect(result.kept.length).toBe(3);
    expect(result.sufficient).toBeNull();
  });

  it("candidate description omits retrieval metadata and keeps semantic content", async () => {
    const seen: string[] = [];
    const llm: any = {
      completeJson: vi.fn().mockImplementation(async (messages: any[]) => {
        seen.push(messages[1].content);
        return { value: { selected: [1], sufficient: true }, servedBy: "fake" };
      }),
    };
    await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.9)] },
      { llm, log, config: cfg },
    );
    expect(seen[0]).toContain("[TRACE] summary a");
    expect(seen[0]).toContain("[user] user a");
    expect(seen[0]).not.toContain("time=");
    expect(seen[0]).not.toContain("tags=[sample]");
    expect(seen[0]).not.toContain("via=vec_summary");
    expect(seen[0]).not.toContain("score=");
  });

  it("LLM output budget scales for large ranked lists", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { ranked: [1], sufficient: false },
        servedBy: "fake",
      }),
    };
    const ranked = Array.from({ length: 300 }, (_, i) =>
      trace(`candidate-${i + 1}`, 1 - i / 1000),
    );
    await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 300 } },
    );
    expect(llm.completeJson.mock.calls[0][1].maxTokens).toBeGreaterThan(512);
  });
});
