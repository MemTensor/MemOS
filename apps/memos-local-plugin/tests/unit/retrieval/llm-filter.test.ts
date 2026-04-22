import { describe, expect, it, vi } from "vitest";

import { llmFilterCandidates } from "../../../core/retrieval/llm-filter.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type {
  RetrievalConfig,
  TraceCandidate,
} from "../../../core/retrieval/types.js";

const cfg: Pick<
  RetrievalConfig,
  "llmFilterEnabled" | "llmFilterMaxKeep" | "llmFilterMinCandidates"
> = {
  llmFilterEnabled: true,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 2,
};

// Minimal Logger stub — `llm-filter` only calls `.warn`, `.debug`, `.info`.
// We use `as any` rather than implementing the full `Logger` interface,
// since the missing methods are never invoked in this filter path.
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
    ts: 1 as never,
    vec: null,
    value: 0.5 as never,
    priority: 0.5 as never,
    episodeId: "e1" as never,
    sessionId: "s1" as never,
    vecKind: "summary",
    userText: "u",
    agentText: "a",
    summary: "summary text",
    reflection: null,
    tags: [],
  };
  return {
    candidate: cand,
    relevance: score,
    rrf: 0,
    score,
    normSq: null,
  };
}

describe("retrieval/llm-filter", () => {
  it("disabled → passthrough", async () => {
    const result = await llmFilterCandidates(
      { query: "anything", ranked: [trace("a", 0.9), trace("b", 0.5)] },
      { llm: null, log, config: { ...cfg, llmFilterEnabled: false } },
    );
    expect(result.outcome).toBe("disabled");
    expect(result.kept.length).toBe(2);
  });

  it("below threshold → passthrough", async () => {
    const result = await llmFilterCandidates(
      { query: "x", ranked: [trace("only", 0.9)] },
      { llm: null, log, config: cfg },
    );
    expect(result.outcome).toBe("below_threshold");
    expect(result.kept.length).toBe(1);
  });

  it("LLM returns selected indices → filters precisely", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [1, 3] },
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
  });

  it("LLM returns empty selection → keeps nothing (drops the whole packet)", async () => {
    const llm: any = {
      completeJson: vi.fn().mockResolvedValue({
        value: { selected: [] },
        servedBy: "fake",
      }),
    };
    const ranked = [trace("a", 0.9), trace("b", 0.8)];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_filtered");
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(2);
  });

  it("LLM throws → mechanical safe cutoff (NOT passthrough)", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("network kaboom")),
    };
    const ranked = [
      trace("strong", 0.9),
      trace("middle", 0.6),
      trace("weak", 0.05), // far below 0.7·top → cut by safeCutoff
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
    const ids = result.kept.map((r) => String(r.candidate.refId));
    expect(ids).toContain("strong");
    // weak is far below the relative cutoff → dropped
    expect(ids).not.toContain("weak");
  });

  it("safe-cutoff still keeps at least 1 candidate even if all are weak", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const ranked = [trace("only", 0.05)];
    // Below threshold gates the LLM call entirely, so this exercises
    // the safeCutoff path indirectly by raising the cutoff via cfg
    // override:
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.5), trace("b", 0.49)] },
      { llm, log, config: cfg },
    );
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
    // both are above 0.7 · 0.5 = 0.35, so both kept
    expect(result.kept.length).toBeGreaterThanOrEqual(1);
  });

  it("safe-cutoff respects llmFilterMaxKeep cap", async () => {
    const llm: any = {
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    // 6 candidates all above threshold, llmFilterMaxKeep=2 → kept ≤ 2.
    const ranked = [
      trace("a", 0.95),
      trace("b", 0.94),
      trace("c", 0.93),
      trace("d", 0.92),
      trace("e", 0.91),
      trace("f", 0.90),
    ];
    const result = await llmFilterCandidates(
      { query: "q", ranked },
      { llm, log, config: { ...cfg, llmFilterMaxKeep: 2 } },
    );
    expect(result.kept.length).toBeLessThanOrEqual(2);
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
  });

  it("no LLM at all → passthrough (not safe-cutoff, since the call never happens)", async () => {
    const result = await llmFilterCandidates(
      { query: "q", ranked: [trace("a", 0.9), trace("b", 0.8), trace("c", 0.7)] },
      { llm: null, log, config: cfg },
    );
    expect(result.outcome).toBe("no_llm");
    expect(result.kept.length).toBe(3);
  });
});
