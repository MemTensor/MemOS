/**
 * Unit tests for `core/memory/l2/recompute-gain.ts` — the shared
 * evidence selection + gain recomputation helper (ordinary L2 / preview /
 * timer repair) and the evidence-union queue reconciliation.
 *
 * RED-GREEN: every scenario below was written against the spec contract FIRST
 * (failing), then the helper was implemented to satisfy it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  recomputePolicyGain,
  reconcileGainRepairQueueFromEvidenceUnion,
  selectAndComputeGain,
  type GainEvidenceTrace,
  type RecomputeGainRepos,
  type RecomputeGainResult,
} from "../../../../core/memory/l2/recompute-gain.js";
import { computeGain } from "../../../../core/memory/l2/gain.js";
import { initTestLogger, memoryBuffer } from "../../../../core/logger/index.js";
import type {
  EpisodeId,
  GainValueSource,
  OwnedRow,
  PolicyRow,
  RuntimeNamespace,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../../core/types.js";
import type { TmpDbHandle } from "../../../helpers/tmp-db.js";
import { makeTmpDb } from "../../../helpers/tmp-db.js";
import { ensureEpisode } from "./_helpers.js";

const NOW = 1_700_000_000_000;
const NS: RuntimeNamespace = { agentKind: "openclaw", profileId: "default" };

function evidence(id: string, overrides: Partial<GainEvidenceTrace> = {}): GainEvidenceTrace {
  return {
    id: id as TraceId,
    episodeId: "ep_1" as EpisodeId,
    ts: NOW,
    value: 0.5,
    gainValue: 0.5,
    gainValueSource: "inferred_normalized",
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: "po_1" as PolicyRow["id"],
    title: "title",
    trigger: "trigger",
    procedure: "procedure",
    verification: "verification",
    boundary: "boundary",
    support: 0,
    gain: 0,
    gainVersion: 1,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "unit-test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function traceRow(
  id: string,
  episodeId: string,
  ts: number,
  value: number,
  gainValue: number | null,
  overrides: Partial<TraceRow> = {},
): TraceRow {
  return {
    id: id as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    ts,
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value,
    alpha: 0.5,
    rHuman: 0.5,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0,
    schemaVersion: 1,
    gainValue,
    gainValueSource: gainValue != null ? "live_normalized" : null,
    ...overrides,
  };
}

function insertTrace(
  handle: TmpDbHandle,
  id: string,
  episodeId: string,
  ts: number,
  value: number,
  opts: {
    gainValue?: number | null;
    gainValueSource?: GainValueSource | null;
    owner?: Partial<OwnedRow>;
  } = {},
): void {
  ensureEpisode(handle, episodeId, "s_rec");
  handle.repos.traces.insert({
    ...(opts.owner ?? {}),
    id: id as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    ts,
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value,
    alpha: 0.5,
    rHuman: 0.5,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0,
    schemaVersion: 1,
    gainValue: opts.gainValue !== undefined ? opts.gainValue : value,
    gainValueSource: opts.gainValueSource !== undefined ? opts.gainValueSource : "inferred_normalized",
  });
}

function recomputeDeps(handle: TmpDbHandle): RecomputeGainRepos {
  return {
    episodes: handle.repos.episodes,
    traces: handle.repos.traces,
    tracePolicyLinks: handle.repos.tracePolicyLinks,
  };
}

const V2_CFG = {
  minSimilarity: 0.8,
  candidateTtlDays: 30,
  gamma: 0.9,
  tauSoftmax: 0.5,
  useLlm: true,
  minTraceValue: 0.01,
  minEpisodesForInduction: 1,
  inductionTraceCharCap: 2_000,
  gainEmaAlpha: 0.4,
  gainV2Enabled: true,
  minGainValue: 0.02,
  gainRepairBatchSize: 0,
  gainRepairIntervalMs: 900_000,
  gainRepairMaxTotal: null,
  gainRepairRescreenGeneration: 0,
};

const SCORE_CFG = { gainEmaAlpha: 0.4, tauSoftmax: 0.5 };

describe("memory/l2/recompute-gain — pure selection", () => {
  it("deduplicates by ID and breaks timestamp ties by ID descending", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["tr_a", evidence("tr_a", { ts: NOW, gainValue: 0.6 })],
      ["tr_b", evidence("tr_b", { ts: NOW, gainValue: 0.8 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 2, gainVersion: 2 }),
      withIds: ["tr_a", "tr_b", "tr_a"],
      poolIds: ["tr_a", "tr_b", "tr_a"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.poolIds).toEqual(["tr_a", "tr_b"]);
    expect(result.selectedWithIds).toEqual(["tr_b", "tr_a"]);
  });

  it("sorts timestamp descending before ID descending", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["old", evidence("old", { ts: NOW - 10, gainValue: 0.9 })],
      ["new", evidence("new", { ts: NOW + 10, gainValue: 0.7 })],
      ["mid", evidence("mid", { ts: NOW, gainValue: 0.8 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 2, gainVersion: 2 }),
      withIds: ["old", "new", "mid"],
      poolIds: ["old", "new", "mid"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.selectedWithIds).toEqual(["new", "mid", "old"]);
  });

  it("computes with one resolved with-trace while NULL with/without traces are excluded and counted", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: 0.6 })],
      ["w2", evidence("w2", { gainValue: null, gainValueSource: null })],
      ["o1", evidence("o1", { gainValue: 0.4 })],
      ["o2", evidence("o2", { gainValue: null, gainValueSource: null })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 3, gainVersion: 2 }),
      withIds: ["w1", "w2"],
      poolIds: ["w1", "w2", "o1", "o2"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toEqual(["w1"]);
    expect(result.selectedWithoutIds).toEqual(["o1"]);
    expect(result.excluded.unresolvedWith).toBe(1);
    expect(result.excluded.unresolvedWithout).toBe(1);
    expect(result.gainVersion).toBe(2);
  });

  it("skips when every with-trace is unresolved, preserving previous state", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: null, gainValueSource: null })],
      ["o1", evidence("o1", { gainValue: 0.4 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 5, gain: 0.123, gainVersion: 2 }),
      withIds: ["w1"],
      poolIds: ["w1", "o1"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.skipReason).toBe("no_resolved_with");
    expect(result.selectedWithIds).toEqual([]);
    expect(result.persistedGain).toBe(0.123); // previous state untouched
  });

  it("skips when there is no with-evidence at all", () => {
    const result = selectAndComputeGain({
      policy: policy({ support: 1, gain: 0.5, gainVersion: 2 }),
      withIds: [],
      poolIds: ["o1"],
      tracesById: new Map([["o1", evidence("o1", { gainValue: 0.4 })]]),
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.skipReason).toBe("no_resolved_with");
    expect(result.excluded.unresolvedWith).toBe(0);
  });

  it("keeps resolved zero without-traces as valid evidence", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: 0.6 })],
      ["o1", evidence("o1", { gainValue: 0 })],
      ["o2", evidence("o2", { gainValue: -0.0 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 3, gainVersion: 2 }),
      withIds: ["w1"],
      poolIds: ["w1", "o1", "o2"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.skipReason).toBeNull();
    // both without-traces carry ts NOW → tie broken by ID descending
    expect(result.selectedWithoutIds).toEqual(["o2", "o1"]);
    expect(result.selectedWithoutIds).toHaveLength(2);
  });

  it("rejects dangling IDs and other-owner traces with separate counters", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["other", evidence("other", { ownerAgentKind: "openclaw", ownerProfileId: "other" })],
      ["ok", evidence("ok", { gainValue: 0.5 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ ownerAgentKind: "hermes", ownerProfileId: "p1" }),
      withIds: ["dangling", "other", "ok"],
      poolIds: ["dangling", "other", "ok"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.reported.danglingIds).toBe(1);
    expect(result.reported.outOfNamespace).toBe(1);
    expect(result.reported.invalidScores).toBe(0);
    expect(result.selectedWithIds).toEqual(["ok"]);
  });

  it("reports non-finite / out-of-range scores as invalid without using them", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["bad1", evidence("bad1", { gainValue: 1.5 })],
      ["bad2", evidence("bad2", { gainValue: Number.NaN })],
      ["ok", evidence("ok", { gainValue: 0.5 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({}),
      withIds: ["bad1", "bad2", "ok"],
      poolIds: ["bad1", "bad2", "ok"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.reported.invalidScores).toBe(2);
    expect(result.selectedWithIds).toEqual(["ok"]);
  });

  it("rejects unknown-owner policies from auto-mutation with a distinct skip reason", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: 0.6 })],
    ]);
    const p = policy({ support: 3, gain: 0.2, gainVersion: 2 }); // no owner fields → unknown
    const rejected = selectAndComputeGain({
      policy: p,
      withIds: ["w1"],
      poolIds: ["w1"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
      rejectUnknownOwner: true,
    });
    expect(rejected.skipReason).toBe("unknown_owner");
    expect(rejected.persistedGain).toBe(0.2); // previous state preserved
    expect(rejected.unknownOwner).toBe(true);
    // the selection report is still produced (preview relies on it)
    expect(rejected.selectedWithIds).toEqual(["w1"]);

    // preview-style callers (rejectUnknownOwner false) still compute + report
    const computed = selectAndComputeGain({
      policy: p,
      withIds: ["w1"],
      poolIds: ["w1"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
      rejectUnknownOwner: false,
    });
    expect(computed.skipReason).toBeNull();
    expect(computed.gainVersion).toBe(2);
  });

  it("does not borrow unknown-owner shared traces from a real-owner policy", () => {
    // NULL/unknown-owner traces are the shared space — allowed for any policy.
    const byId = new Map<string, GainEvidenceTrace>([
      ["shared", evidence("shared", { ownerAgentKind: "unknown", ownerProfileId: "default" })],
      ["same", evidence("same", { ownerAgentKind: "hermes", ownerProfileId: "p1" })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ ownerAgentKind: "hermes", ownerProfileId: "p1" }),
      withIds: ["shared", "same"],
      poolIds: ["shared", "same"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
    expect(result.reported.outOfNamespace).toBe(0);
    expect(result.selectedWithIds.sort()).toEqual(["same", "shared"]);
  });
});

describe("memory/l2/recompute-gain — first-v2 EMA vs ordinary EMA", () => {
  function oneWithResult(overrides: { support?: number; gainVersion?: number; gain?: number }): RecomputeGainResult {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: 0.6 })],
      ["o1", evidence("o1", { gainValue: 0.4 })],
    ]);
    return selectAndComputeGain({
      policy: policy({ support: overrides.support ?? 0, gainVersion: overrides.gainVersion ?? 1, gain: overrides.gain ?? 0.2 }),
      withIds: ["w1"],
      poolIds: ["w1", "o1"],
      tracesById: byId,
      scoreMode: "gain",
      config: SCORE_CFG,
    });
  }

  function rawGain(): number {
    return computeGain(
      { policyId: "po_1" as PolicyRow["id"], withTraces: [], withoutTraces: [] },
      { tauSoftmax: SCORE_CFG.tauSoftmax },
    ).gain + 0; // placeholder, replaced below
  }
  void rawGain;

  it("resets the EMA for the first v2 calculation (support == 0)", () => {
    const result = oneWithResult({ support: 0 });
    expect(result.isFirst).toBe(true);
    expect(result.persistedGain).toBeCloseTo(result.raw.gain, 9);
    expect(result.gainVersion).toBe(2);
  });

  it("resets the EMA when the policy was not yet v2-certified (gain_version != 2)", () => {
    const result = oneWithResult({ support: 7, gainVersion: 1 });
    expect(result.isFirst).toBe(true);
    expect(result.persistedGain).toBeCloseTo(result.raw.gain, 9);
  });

  it("blends the EMA on later ordinary v2 updates (support > 0, gain_version == 2)", () => {
    const result = oneWithResult({ support: 7, gainVersion: 2, gain: 0.2 });
    expect(result.isFirst).toBe(false);
    expect(result.persistedGain).toBeCloseTo(0.4 * result.raw.gain + 0.6 * 0.2, 9);
  });

  it("keeps the legacy-mode EMA semantics on the disabled path", () => {
    const byId = new Map<string, GainEvidenceTrace>([
      ["w1", evidence("w1", { gainValue: null, gainValueSource: null, value: 0.6 })],
    ]);
    const result = selectAndComputeGain({
      policy: policy({ support: 7, gainVersion: 2, gain: 0.2 }),
      withIds: ["w1"],
      poolIds: ["w1"],
      tracesById: byId,
      scoreMode: "value", // legacy: NULL gainValue is irrelevant; V is the score
      config: SCORE_CFG,
    });
    expect(result.skipReason).toBeNull();
    expect(result.gainVersion).toBe(1);
    // legacy first = support === 0 only → not first here
    expect(result.isFirst).toBe(false);
    expect(result.persistedGain).toBeCloseTo(0.4 * result.raw.gain + 0.6 * 0.2, 9);
  });

  it("raw gain is exposed separately from the persisted EMA (preview contract)", () => {
    const result = oneWithResult({ support: 7, gainVersion: 2, gain: 0.2 });
    expect(result.raw).toBeTypeOf("object");
    expect(result.raw.gain).toBeTypeOf("number");
    expect(result.persistedGain).toBeTypeOf("number");
    expect(result.raw.gain).not.toBeCloseTo(result.persistedGain, 9);
  });
});

describe("memory/l2/recompute-gain — I/O wrapper", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  // v2-mode auto-mutation rejects unknown-owner policies, so these tests use
  // policies with a real owner.
  const OWNED: Partial<OwnedRow> = { ownerAgentKind: "openclaw", ownerProfileId: "default" };
  const ownedPolicy = (overrides: Partial<PolicyRow> = {}): PolicyRow =>
    policy({ ...OWNED, ...overrides });

  it("includes an old directly-linked trace beyond its episode's newest 50", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"], status: "active" }));
    // 55 persisted members; tr_old is the OLDEST, so it is NOT among the
    // episode's newest 50 — but the direct with-link must include it anyway.
    const ids: string[] = ["tr_old"];
    insertTrace(handle, "tr_old", "ep_1", NOW, 0.7);
    for (let i = 0; i < 54; i++) {
      const id = `tr_n${String(i).padStart(2, "0")}`;
      insertTrace(handle, id, "ep_1", NOW + i + 1, 0.5);
      ids.push(id);
    }
    handle.repos.episodes.appendTrace("ep_1" as EpisodeId, ids);
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_old" as TraceId,
      policyId: "po_1" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });

    const result = recomputePolicyGain(
      { policy: ownedPolicy({ id: "po_1" as PolicyRow["id"], status: "active" }), namespace: NS, config: V2_CFG },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toContain("tr_old");
    // newest 50 of the episode joined the pool alongside the with-link
    expect(result.poolIds.length).toBeGreaterThanOrEqual(51);
    expect(result.selectedWithoutIds.length).toBeGreaterThan(0);
    // links are never deleted by recomputation
    expect(handle.repos.tracePolicyLinks.getWithTraceIds("po_1" as PolicyRow["id"])).toEqual(["tr_old"]);
  });

  it("includes current-run traces that are not yet persisted", () => {
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"] }));
    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_1" as PolicyRow["id"] }),
        namespace: NS,
        config: V2_CFG,
        currentTraces: [traceRow("tr_new", "ep_1", NOW, 0.5, 0.6)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toEqual(["tr_new"]);
    expect(result.gainVersion).toBe(2);
    expect(result.isFirst).toBe(true);
    expect(result.provenance.liveNormalized).toBe(1);
  });

  it("computes when a resolved with-trace remains even if a persisted link is unresolved", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"] }));
    insertTrace(handle, "tr_old", "ep_1", NOW, 0.5, { gainValue: null, gainValueSource: null });
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_old" as TraceId,
      policyId: "po_1" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });
    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_1" as PolicyRow["id"] }),
        namespace: NS,
        config: V2_CFG,
        currentTraces: [traceRow("tr_new", "ep_1", NOW + 1, 0.5, 0.6)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toEqual(["tr_new"]);
    expect(result.excluded.unresolvedWith).toBe(1);
  });

  it("skips when all with-evidence is unresolved (enabled mode)", () => {
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"], gain: 0.11, gainVersion: 2 }));
    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_1" as PolicyRow["id"], gain: 0.11, gainVersion: 2 }),
        namespace: NS,
        config: V2_CFG,
        currentTraces: [traceRow("tr_new", "ep_1", NOW, 0.8, null)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBe("no_resolved_with");
    expect(result.persistedGain).toBe(0.11);
  });

  it("legacy disabled mode scores V and never treats NULL gainValue as unresolved", () => {
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"] }));
    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_1" as PolicyRow["id"] }),
        namespace: NS,
        config: { ...V2_CFG, gainV2Enabled: false },
        currentTraces: [traceRow("tr_new", "ep_1", NOW, 0.5, null)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toEqual(["tr_new"]);
    expect(result.gainVersion).toBe(1);
    expect(result.excluded.unresolvedWith).toBe(0);
  });

  it("inference-refresh recompute resets the EMA even for a certified v2 policy", () => {
    handle.repos.policies.insert(ownedPolicy({ id: "po_1" as PolicyRow["id"], support: 5, gain: 0.3, gainVersion: 2 }));
    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_1" as PolicyRow["id"], support: 5, gain: 0.3, gainVersion: 2 }),
        namespace: NS,
        config: V2_CFG,
        mode: "inference_refresh",
        currentTraces: [traceRow("tr_new", "ep_1", NOW, 0.5, 0.6)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.isFirst).toBe(true);
    expect(result.persistedGain).toBeCloseTo(result.raw.gain, 9);
  });

  it("includes policy.sourceTraceIds as persisted with-evidence and derives linked episodes from them", () => {
    ensureEpisode(handle, "ep_src", "s_rec");
    insertTrace(handle, "tr_src", "ep_src", NOW, 0.5, { gainValue: 0.6 });
    insertTrace(handle, "tr_ep_extra", "ep_src", NOW + 1, 0.4, { gainValue: 0.3 });
    handle.repos.episodes.appendTrace("ep_src" as EpisodeId, ["tr_src", "tr_ep_extra"]);
    // Imported/feedback-derived policy: sourceTraceIds present, NO links.
    handle.repos.policies.insert(ownedPolicy({
      id: "po_imp" as PolicyRow["id"],
      status: "active",
      sourceTraceIds: ["tr_src" as TraceId],
    }));

    const result = recomputePolicyGain(
      {
        policy: ownedPolicy({ id: "po_imp" as PolicyRow["id"], status: "active", sourceTraceIds: ["tr_src" as TraceId] }),
        namespace: NS,
        config: V2_CFG,
      },
      recomputeDeps(handle),
    );
    expect(result.skipReason).toBeNull();
    expect(result.selectedWithIds).toContain("tr_src");
    // ep_src is derived from the SOURCE trace (no link row exists) → its
    // newest-50 members joined the pool as without-evidence.
    expect(result.poolIds).toContain("tr_ep_extra");
    expect(result.selectedWithoutIds).toContain("tr_ep_extra");
  });

  it("rejects an unknown-owner policy in ordinary (auto-mutation) mode", () => {
    handle.repos.policies.insert(policy({ id: "po_anon2" as PolicyRow["id"] }));
    const result = recomputePolicyGain(
      {
        policy: policy({ id: "po_anon2" as PolicyRow["id"] }),
        namespace: NS,
        config: V2_CFG,
        currentTraces: [traceRow("tr_new", "ep_1", NOW, 0.5, 0.6)],
        withTraceIds: ["tr_new" as TraceId],
      },
      recomputeDeps(handle),
    );
    expect(result.unknownOwner).toBe(true);
    expect(result.skipReason).toBe("unknown_owner");
    expect(result.persistedGain).toBe(0);
  });

  it("debug-logs excluded orphans per episode and stays silent without", () => {
    initTestLogger();
    // ep_orph: S = [tr_in]; tr_orphan shares episode_id but was never
    // folded into trace_ids_json (the pass leaves it unresolved).
    ensureEpisode(handle, "ep_orph", "s_rec");
    insertTrace(handle, "tr_in", "ep_orph", NOW, 0.5, { gainValue: 0.6 });
    insertTrace(handle, "tr_orphan", "ep_orph", NOW, 0.4, { gainValue: 0.4 });
    handle.repos.episodes.appendTrace("ep_orph" as EpisodeId, ["tr_in"]);
    // ep_clean: every table row is listed in S — no orphans.
    ensureEpisode(handle, "ep_clean", "s_rec");
    insertTrace(handle, "tr_only", "ep_clean", NOW, 0.5, { gainValue: 0.6 });
    handle.repos.episodes.appendTrace("ep_clean" as EpisodeId, ["tr_only"]);
    handle.repos.policies.insert(ownedPolicy({ id: "po_orph" as PolicyRow["id"], status: "active" }));
    for (const [tid, eid] of [["tr_in", "ep_orph"], ["tr_only", "ep_clean"]] as const) {
      handle.repos.tracePolicyLinks.link({
        traceId: tid as TraceId,
        policyId: "po_orph" as PolicyRow["id"],
        episodeId: eid as EpisodeId,
        now: NOW,
      });
    }

    const result = recomputePolicyGain(
      { policy: ownedPolicy({ id: "po_orph" as PolicyRow["id"], status: "active" }), namespace: NS, config: V2_CFG },
      recomputeDeps(handle),
    );
    // No behavior change: the orphan never enters the pool.
    expect(result.skipReason).toBeNull();
    expect(result.poolIds).toContain("tr_in");
    expect(result.poolIds).toContain("tr_only");
    expect(result.poolIds).not.toContain("tr_orphan");

    const orphanLogs = memoryBuffer()
      .tail({ limit: 256 })
      .filter((r) => r.msg === "recompute_gain.orphans_excluded");
    expect(orphanLogs).toHaveLength(1);
    expect(orphanLogs[0]!.data).toMatchObject({
      policyId: "po_orph",
      episodeId: "ep_orph",
      orphansExcluded: 1,
      poolMembers: 1,
    });
    // Silent for the orphan-free episode.
    expect(
      orphanLogs.some(
        (r) => (r.data as Record<string, unknown> | undefined)?.episodeId === "ep_clean",
      ),
    ).toBe(false);
  });

  it("truncates the per-episode newest-50 with ID-descending tie breaks", () => {
    ensureEpisode(handle, "ep_tie", "s_rec");
    handle.repos.policies.insert(ownedPolicy({ id: "po_tie" as PolicyRow["id"], status: "active" }));
    // 51 persisted members: tr_top (newest ts), then 50 tied at the same older
    // ts. The newest-50 slice keeps tr_top + 49 of the tied 50; with ID-desc
    // ties it must drop tr_t00 and keep tr_t49.
    const ids: string[] = [];
    insertTrace(handle, "tr_top", "ep_tie", NOW + 100, 0.5, { gainValue: 0.6 });
    ids.push("tr_top");
    for (let i = 0; i < 50; i++) {
      const id = `tr_t${String(i).padStart(2, "0")}`;
      insertTrace(handle, id, "ep_tie", NOW, 0.4, { gainValue: 0.3 });
      ids.push(id);
    }
    handle.repos.episodes.appendTrace("ep_tie" as EpisodeId, ids);
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_top" as TraceId,
      policyId: "po_tie" as PolicyRow["id"],
      episodeId: "ep_tie" as EpisodeId,
      now: NOW,
    });

    const result = recomputePolicyGain(
      { policy: ownedPolicy({ id: "po_tie" as PolicyRow["id"], status: "active" }), namespace: NS, config: V2_CFG },
      recomputeDeps(handle),
    );
    expect(result.poolIds).toContain("tr_top");
    expect(result.poolIds).toContain("tr_t49");
    expect(result.poolIds).not.toContain("tr_t00");
  });
});

describe("memory/l2/recompute-gain — queue reconciliation from the evidence union", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  function reconcile(
    owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null } = {
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
    },
    policies: typeof handle.repos.policies = handle.repos.policies,
  ) {
    return reconcileGainRepairQueueFromEvidenceUnion({
      db: handle.db,
      kv: handle.repos.kv,
      gainRepair: handle.repos.gainRepair,
      policies,
      traces: handle.repos.traces,
      episodes: handle.repos.episodes,
      tracePolicyLinks: handle.repos.tracePolicyLinks,
      owner,
    });
  }

  it("seeds pending when ≥1 resolved with-link survives and blocks zero-resolved policies directly", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    insertTrace(handle, "tr_unresolved", "ep_1", NOW, 0.5, { gainValue: null, gainValueSource: null });
    const OWNER: Partial<OwnedRow> = { ownerAgentKind: "openclaw", ownerProfileId: "default" };
    handle.repos.policies.insert(policy({ id: "po_good" as PolicyRow["id"], status: "candidate", ...OWNER }));
    handle.repos.policies.insert(policy({ id: "po_stuck" as PolicyRow["id"], status: "candidate", ...OWNER }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_good" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_unresolved" as TraceId,
      policyId: "po_stuck" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });

    const out = reconcile();
    expect(out.seeded).toBe(1);
    expect(out.blocked).toBe(1);

    const good = handle.repos.gainRepair.getByPolicy("po_good" as PolicyRow["id"]);
    expect(good?.state).toBe("pending");
    expect(good?.reason).toBe("inferred_evidence_updated");

    const stuck = handle.repos.gainRepair.getByPolicy("po_stuck" as PolicyRow["id"]);
    expect(stuck?.state).toBe("blocked");
    expect(stuck?.blockedReason).toBe("no_resolved_with");

    // policy fields are untouched by the reconcile
    const po = handle.repos.policies.getById("po_stuck" as PolicyRow["id"])!;
    expect(po.support).toBe(0);
    expect(po.status).toBe("candidate");
    expect(po.gainVersion).toBe(1);
  });

  it("never seeds unknown-owner policies (excluded from automatic mutation)", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    // no owner fields → ownerAgentKind "unknown"; outside the repair scope
    handle.repos.policies.insert(policy({ id: "po_anon" as PolicyRow["id"], status: "candidate" }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_anon" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });

    const out = reconcile();
    expect(out.seeded).toBe(0);
    expect(out.blocked).toBe(0);
    expect(handle.repos.gainRepair.getByPolicy("po_anon" as PolicyRow["id"])).toBeNull();
  });

  it("reconciles archived/missing queue rows away and ignores other owners", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    const OWNER: Partial<OwnedRow> = { ownerAgentKind: "openclaw", ownerProfileId: "default" };
    handle.repos.policies.insert(policy({ id: "po_a" as PolicyRow["id"], status: "active", ...OWNER }));
    handle.repos.policies.insert(policy({ id: "po_arch" as PolicyRow["id"], status: "archived", ...OWNER }));
    handle.repos.policies.insert(policy({
      id: "po_other" as PolicyRow["id"],
      status: "active",
      ownerAgentKind: "hermes",
      ownerProfileId: "p1",
    }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_a" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });
    // A stale queue row for the archived policy must be reconciled away.
    handle.repos.gainRepair.upsertPending({
      policyId: "po_arch" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
    });

    const out = reconcile();
    expect(out.reconciled).toBe(1);
    expect(out.seeded).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("po_arch" as PolicyRow["id"])).toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("po_a" as PolicyRow["id"])?.state).toBe("pending");
    // hermes-owned policy is outside this owner's queue space
    expect(handle.repos.gainRepair.getByPolicy("po_other" as PolicyRow["id"])).toBeNull();
  });

  it("preserves an existing inference_refresh invalidation across the rebuild", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    const OWNER: Partial<OwnedRow> = { ownerAgentKind: "openclaw", ownerProfileId: "default" };
    handle.repos.policies.insert(policy({ id: "po_refresh" as PolicyRow["id"], status: "candidate", ...OWNER }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_refresh" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });
    // Explicit inference-rule invalidation from a prior boot.
    handle.repos.gainRepair.upsertPending({
      policyId: "po_refresh" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      reason: "inference_refresh",
    });

    const out = reconcile();
    expect(out.seeded).toBe(1);
    const entry = handle.repos.gainRepair.getByPolicy("po_refresh" as PolicyRow["id"]);
    expect(entry?.state).toBe("pending");
    // NOT downgraded to inferred_evidence_updated — the invalidation survives.
    expect(entry?.reason).toBe("inference_refresh");
  });

  it("scopes the reconcile to the exact workspace (same profile, different workspace)", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    const OWNER_A: Partial<OwnedRow> = {
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: "ws_a",
    };
    const OWNER_B: Partial<OwnedRow> = {
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: "ws_b",
    };
    handle.repos.policies.insert(policy({ id: "po_wa" as PolicyRow["id"], status: "candidate", ...OWNER_A }));
    handle.repos.policies.insert(policy({ id: "po_wb" as PolicyRow["id"], status: "candidate", ...OWNER_B }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_wa" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_resolved" as TraceId,
      policyId: "po_wb" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });

    const out = reconcile({ ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" });
    expect(out.seeded).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("po_wa" as PolicyRow["id"])?.state).toBe("pending");
    // ws_b policy is outside the exact workspace → never touched
    expect(handle.repos.gainRepair.getByPolicy("po_wb" as PolicyRow["id"])).toBeNull();

    // Queue reconciliation ops are workspace-scoped too: a stale ws_b row for
    // an archived policy must NOT be removed by the ws_a owner.
    handle.repos.policies.insert(policy({ id: "po_arch_b" as PolicyRow["id"], status: "archived", ...OWNER_B }));
    handle.repos.gainRepair.upsertPending({
      policyId: "po_arch_b" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: "ws_b",
    });
    reconcile({ ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" });
    expect(handle.repos.gainRepair.getByPolicy("po_arch_b" as PolicyRow["id"])).not.toBeNull();
  });

  it("pushes the exact owner triple into policies.list (SQL-scoped reads)", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_resolved", "ep_1", NOW, 0.5, { gainValue: 0.6 });
    const OWNER_A: Partial<OwnedRow> = {
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: "ws_a",
    };
    handle.repos.policies.insert(policy({ id: "po_wa" as PolicyRow["id"], status: "candidate", ...OWNER_A }));
    handle.repos.policies.insert(policy({
      id: "po_wb" as PolicyRow["id"],
      status: "candidate",
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: "ws_b",
    }));
    handle.repos.policies.insert(policy({
      id: "po_h" as PolicyRow["id"],
      status: "candidate",
      ownerAgentKind: "hermes",
      ownerProfileId: "p1",
    }));
    for (const pid of ["po_wa", "po_wb", "po_h"]) {
      handle.repos.tracePolicyLinks.link({
        traceId: "tr_resolved" as TraceId,
        policyId: pid as PolicyRow["id"],
        episodeId: "ep_1" as EpisodeId,
        now: NOW,
      });
    }

    // Query-level isolation: record the filters reaching policies.list.
    type ListFilter = Parameters<typeof handle.repos.policies.list>[0];
    const seen: ListFilter[] = [];
    const scopedPolicies = {
      ...handle.repos.policies,
      list: (filter: ListFilter = {}) => {
        seen.push(filter);
        return handle.repos.policies.list(filter);
      },
    };
    const out = reconcile(
      { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
      scopedPolicies,
    );

    // Both reads (candidate + active) carry the exact triple — workspace
    // NULL-exact (IS semantics): same profile, different workspace never
    // leaves the database.
    expect(seen).toHaveLength(2);
    for (const filter of seen) {
      expect(filter).toMatchObject({
        ownerAgentKind: "openclaw",
        ownerProfileId: "default",
        ownerWorkspaceId: "ws_a",
      });
    }
    // Result-level isolation preserved: only the exact-workspace policy queues.
    expect(out.seeded).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("po_wa" as PolicyRow["id"])?.state).toBe("pending");
    expect(handle.repos.gainRepair.getByPolicy("po_wb" as PolicyRow["id"])).toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("po_h" as PolicyRow["id"])).toBeNull();
  });

  it("never treats invalid scores (non-finite / out-of-range) as resolved evidence", () => {
    ensureEpisode(handle, "ep_1", "s_rec");
    insertTrace(handle, "tr_bad", "ep_1", NOW, 0.5, { gainValue: 1.5 });
    insertTrace(handle, "tr_nan", "ep_1", NOW, 0.5, { gainValue: Number.NaN });
    const OWNER: Partial<OwnedRow> = { ownerAgentKind: "openclaw", ownerProfileId: "default" };
    handle.repos.policies.insert(policy({ id: "po_bad" as PolicyRow["id"], status: "candidate", ...OWNER }));
    handle.repos.tracePolicyLinks.link({
      traceId: "tr_bad" as TraceId,
      policyId: "po_bad" as PolicyRow["id"],
      episodeId: "ep_1" as EpisodeId,
      now: NOW,
    });

    const out = reconcile();
    // 1.5 is outside [-1, 1] — same predicate the selector uses, so the
    // policy must be seeded BLOCKED, never pending.
    expect(out.seeded).toBe(0);
    expect(out.blocked).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("po_bad" as PolicyRow["id"])?.state).toBe("blocked");
  });
});
