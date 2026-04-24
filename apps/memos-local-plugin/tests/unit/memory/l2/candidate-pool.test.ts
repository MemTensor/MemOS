/**
 * Unit tests for `core/memory/l2/candidate-pool`.
 *
 * Runs against a real SQLite tmp DB so we cover the SQL path for
 * bucketsReadyForInduction too.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  candidateIdFor,
  makeCandidatePool,
  signatureHash,
} from "../../../../core/memory/l2/candidate-pool.js";
import type { TraceRow } from "../../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import { ensureEpisode, toolCalls as tc, type PartialToolCall } from "./_helpers.js";

const NOW = 1_700_000_000_000;
const TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

type TraceOverrides = Omit<Partial<TraceRow>, "toolCalls"> & {
  toolCalls?: readonly PartialToolCall[];
};

function mkTrace(id: string, ep: string, partial: TraceOverrides = {}): TraceRow {
  const { toolCalls, ...rest } = partial;
  return {
    id: id as TraceRow["id"],
    episodeId: ep as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: "",
    agentText: "",
    reflection: null,
    value: 0.8,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: ["docker"],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
    ...rest,
    toolCalls: toolCalls ? tc(toolCalls) : [],
  };
}

describe("memory/l2/candidate-pool", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("candidateIdFor + signatureHash are deterministic", () => {
    const id1 = candidateIdFor("docker|pip|pip.install|_", "tr_abc");
    const id2 = candidateIdFor("docker|pip|pip.install|_", "tr_abc");
    expect(id1).toBe(id2);
    expect(signatureHash("docker|pip|pip.install|_")).toBe(
      signatureHash("docker|pip|pip.install|_"),
    );
  });

  it("inserts a new row and refreshes TTL on duplicate", () => {
    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    ensureEpisode(handle, "ep_1", "s_1");
    const trace = mkTrace("tr_a", "ep_1", {
      toolCalls: [{ name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" }],
    });
    handle.repos.traces.insert(trace);

    const first = pool.addCandidate({ trace, ttlMs: TTL_MS, now: NOW });
    expect(first.created).toBe(true);

    const second = pool.addCandidate({ trace, ttlMs: TTL_MS, now: NOW + 10 });
    expect(second.created).toBe(false);
    expect(second.candidateId).toBe(first.candidateId);

    const row = handle.repos.candidatePool.getById(first.candidateId)!;
    expect(row.evidenceTraceIds).toEqual(["tr_a"]);
    expect(row.expiresAt).toBe(NOW + 10 + TTL_MS);
  });

  it("bucketsReadyForInduction only yields buckets with ≥N distinct episodes", () => {
    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    ensureEpisode(handle, "ep_1", "s_1");
    ensureEpisode(handle, "ep_2", "s_1");

    const mk = (id: string, ep: string) => {
      const t = mkTrace(id, ep, {
        toolCalls: [{ name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" }],
      });
      handle.repos.traces.insert(t);
      pool.addCandidate({ trace: t, ttlMs: TTL_MS, now: NOW });
    };
    mk("tr_a", "ep_1");
    mk("tr_b", "ep_1"); // same episode → shouldn't count
    mk("tr_c", "ep_2");

    const buckets = pool.bucketsReadyForInduction({ minDistinctEpisodes: 2, now: NOW });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].episodeIds).toHaveLength(2);
    expect(buckets[0].evidenceTraceIds.sort()).toEqual(["tr_a", "tr_b", "tr_c"]);

    const highThreshold = pool.bucketsReadyForInduction({
      minDistinctEpisodes: 3,
      now: NOW,
    });
    expect(highThreshold).toHaveLength(0);
  });

  it("promote fills in policy_id on all bucket candidateIds", () => {
    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    ensureEpisode(handle, "ep_a", "s_1");
    ensureEpisode(handle, "ep_b", "s_1");
    const t1 = mkTrace("tr_x", "ep_a", {
      toolCalls: [{ name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" }],
    });
    const t2 = mkTrace("tr_y", "ep_b", {
      toolCalls: [{ name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" }],
    });
    handle.repos.traces.insert(t1);
    handle.repos.traces.insert(t2);
    const r1 = pool.addCandidate({ trace: t1, ttlMs: TTL_MS, now: NOW });
    const r2 = pool.addCandidate({ trace: t2, ttlMs: TTL_MS, now: NOW });

    handle.repos.policies.insert({
      id: "po_new" as unknown as Parameters<typeof handle.repos.policies.insert>[0]["id"],
      title: "placeholder",
      trigger: "trig",
      procedure: "proc",
      verification: "verif",
      boundary: "bound",
      support: 1,
      gain: 0,
      status: "candidate",
      sourceEpisodeIds: [],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: NOW as Parameters<typeof handle.repos.policies.insert>[0]["createdAt"],
      updatedAt: NOW as Parameters<typeof handle.repos.policies.insert>[0]["updatedAt"],
    });

    pool.promote([r1.candidateId, r2.candidateId], "po_new");

    const row1 = handle.repos.candidatePool.getById(r1.candidateId)!;
    const row2 = handle.repos.candidatePool.getById(r2.candidateId)!;
    expect(row1.policyId).toBe("po_new");
    expect(row2.policyId).toBe("po_new");
  });

  it("prune drops expired rows", () => {
    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    ensureEpisode(handle, "ep_exp", "s_1");
    const t = mkTrace("tr_exp", "ep_exp", {
      toolCalls: [{ name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" }],
    });
    handle.repos.traces.insert(t);
    pool.addCandidate({ trace: t, ttlMs: -1, now: NOW }); // instant expiry

    const dropped = pool.prune(NOW);
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(
      pool.bucketsReadyForInduction({ minDistinctEpisodes: 1, now: NOW }),
    ).toHaveLength(0);
  });
});
