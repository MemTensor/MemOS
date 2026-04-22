/**
 * Unit tests for `core/memory/l2/associate`.
 *
 * Uses the real SQLite tmp DB so searchByVector actually runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { associateTraces } from "../../../../core/memory/l2/associate.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type { EmbeddingVector, PolicyRow, TraceRow } from "../../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import { ensureEpisode } from "./_helpers.js";

const NOW = 1_700_000_000_000;
const log = rootLogger.child({ channel: "core.memory.l2.associate" });

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

function mkTrace(id: string, v: EmbeddingVector | null, partial: Partial<TraceRow> = {}): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: "ep" as TraceRow["episodeId"],
    sessionId: "s" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value: 0.8,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: ["docker", "pip"],
    vecSummary: v,
    vecAction: null,
    schemaVersion: 1,
    ...partial,
  };
}

function mkPolicy(id: string, v: EmbeddingVector, status: PolicyRow["status"] = "active"): PolicyRow {
  return {
    id: id as PolicyRow["id"],
    title: "system-libs",
    trigger: "pip fails in container",
    procedure: "install dev libs",
    verification: "pip install succeeds",
    boundary: "native linux",
    support: 3,
    gain: 0.3,
    status,
    sourceEpisodeIds: [],
    inducedBy: "unit-test",
    vec: v,
    createdAt: 0 as PolicyRow["createdAt"],
    updatedAt: 0 as PolicyRow["updatedAt"],
  };
}

describe("memory/l2/associate", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
    ensureEpisode(handle, "ep", "s");
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("matches aligned trace → policy above minSimilarity", () => {
    handle.repos.policies.insert(mkPolicy("po_match", vec([1, 0, 0])));
    const tr = mkTrace("tr_a", vec([1, 0, 0]));
    handle.repos.traces.insert(tr);

    const out = associateTraces([tr], {
      repos: handle.repos,
      log,
      config: { minSimilarity: 0.6, poolFactor: 4 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].matchedPolicyId).toBe("po_match");
    expect(out[0].matchSimilarity).toBeGreaterThan(0.9);
  });

  it("no match when cosine is too low", () => {
    handle.repos.policies.insert(mkPolicy("po_orth", vec([0, 1, 0])));
    const tr = mkTrace("tr_b", vec([1, 0, 0]));
    handle.repos.traces.insert(tr);

    const out = associateTraces([tr], {
      repos: handle.repos,
      log,
      config: { minSimilarity: 0.6, poolFactor: 4 },
    });
    expect(out[0].matchedPolicyId).toBeNull();
  });

  it("returns empty-match for traces without any embedding", () => {
    handle.repos.policies.insert(mkPolicy("po_any", vec([1, 0, 0])));
    const tr = mkTrace("tr_c", null);
    const out = associateTraces([tr], {
      repos: handle.repos,
      log,
      config: { minSimilarity: 0.6, poolFactor: 4 },
    });
    expect(out[0].matchedPolicyId).toBeNull();
  });

  it("archived policies are ignored", () => {
    handle.repos.policies.insert(mkPolicy("po_archived", vec([1, 0, 0]), "archived"));
    const tr = mkTrace("tr_d", vec([1, 0, 0]));
    const out = associateTraces([tr], {
      repos: handle.repos,
      log,
      config: { minSimilarity: 0.6, poolFactor: 4 },
    });
    expect(out[0].matchedPolicyId).toBeNull();
  });
});
