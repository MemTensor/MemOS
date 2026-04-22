/**
 * Unit tests for `core/memory/l2/induce`:
 *   - happy path: LLM returns a well-formed draft → buildPolicyRow succeeds
 *   - malformed LLM output → tagged-union failure, no throw
 *   - LLM missing → llm_disabled
 */

import { describe, expect, it } from "vitest";

import {
  buildPolicyRow,
  induceDraft,
} from "../../../../core/memory/l2/induce.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type { EmbeddingVector, EpisodeId, TraceRow } from "../../../../core/types.js";
import { fakeLlm, throwingLlm } from "../../../helpers/fake-llm.js";

function mkTrace(id: string, ep: string, vec: EmbeddingVector | null): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: ep as TraceRow["episodeId"],
    sessionId: "s" as TraceRow["sessionId"],
    ts: 0 as TraceRow["ts"],
    userText: "user said stuff",
    agentText: "agent did stuff",
    toolCalls: [{ name: "pip.install", input: { pkg: "lxml" }, output: "MODULE_NOT_FOUND", startedAt: 0, endedAt: 0 }],
    reflection: "looks like missing system lib",
    value: 0.8,
    alpha: 0.6 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: ["docker", "pip"],
    vecSummary: vec,
    vecAction: null,
    schemaVersion: 1,
  };
}

const vec = (n: readonly number[]): EmbeddingVector => new Float32Array(n) as unknown as EmbeddingVector;
const log = rootLogger.child({ channel: "core.memory.l2.induce" });

describe("memory/l2/induce", () => {
  it("returns {ok:true, draft} and fills support_trace_ids when the LLM omits them", async () => {
    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": {
          title: "install system libs first",
          trigger: "pip install fails in container with missing system library",
          procedure: "1. detect missing lib 2. apk/apt-get install 3. retry pip",
          verification: "pip install finishes without errors",
          boundary: "native systems with dev libs already present",
          rationale: "container images ship only python wheels",
          caveats: ["musl-based distros (alpine) may still mismatch"],
          confidence: 0.72,
        },
      },
    });
    const res = await induceDraft(
      {
        evidenceTraces: [mkTrace("tr_a", "ep_1", vec([1, 0])), mkTrace("tr_b", "ep_2", vec([0.9, 0.1]))],
        episodeIds: ["ep_1", "ep_2"] as EpisodeId[],
        signatureLabel: "docker|pip|pip.install|MODULE_NOT_FOUND",
        charCap: 2000,
      },
      { llm, log },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.title).toContain("system libs");
    expect(res.draft.supportTraceIds.length).toBe(2);
    expect(res.draft.confidence).toBeGreaterThan(0);
  });

  it("reason=llm_disabled when llm is null", async () => {
    const res = await induceDraft(
      {
        evidenceTraces: [mkTrace("tr_a", "ep_1", vec([1, 0]))],
        episodeIds: ["ep_1"] as EpisodeId[],
        signatureLabel: "x",
        charCap: 1000,
      },
      { llm: null, log },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_disabled");
  });

  it("reason=llm_failed when the LLM throws", async () => {
    const llm = throwingLlm(new Error("boom"));
    const res = await induceDraft(
      {
        evidenceTraces: [mkTrace("tr_a", "ep_1", vec([1, 0]))],
        episodeIds: ["ep_1"] as EpisodeId[],
        signatureLabel: "x",
        charCap: 1000,
      },
      { llm, log },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_failed");
  });

  it("reason=llm_failed when the LLM draft is malformed (missing title)", async () => {
    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": { trigger: "no title", procedure: "..." },
      },
    });
    const res = await induceDraft(
      {
        evidenceTraces: [mkTrace("tr_a", "ep_1", vec([1, 0]))],
        episodeIds: ["ep_1"] as EpisodeId[],
        signatureLabel: "x",
        charCap: 1000,
      },
      { llm, log },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_failed");
  });

  it("buildPolicyRow centroids trace vectors and copies draft fields", () => {
    const row = buildPolicyRow({
      draft: {
        title: "t",
        trigger: "tr",
        procedure: "pr",
        verification: "ve",
        boundary: "bo",
        rationale: "why",
        caveats: [],
        confidence: 0.5,
        supportTraceIds: ["tr_a", "tr_b"] as TraceRow["id"][],
      },
      episodeIds: ["ep_1", "ep_2"] as EpisodeId[],
      evidenceTraces: [mkTrace("tr_a", "ep_1", vec([1, 0])), mkTrace("tr_b", "ep_2", vec([0, 1]))],
      inducedBy: "l2.l2.induction.v1",
      now: 42,
    });
    expect(row.status).toBe("candidate");
    expect(row.support).toBe(0);
    expect(row.gain).toBe(0);
    expect(row.sourceEpisodeIds.sort()).toEqual(["ep_1", "ep_2"]);
    expect(row.vec).not.toBeNull();
    expect(row.createdAt).toBe(42);
    expect(row.title).toBe("t");
  });
});
