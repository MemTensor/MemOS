/**
 * SQL-only embedding maintenance stats.
 *
 * Regression + spec pin for issue #1929: `/api/v1/embeddings/maintenance`
 * used to paginate every trace/policy/world_model/skill row through JS just
 * to inspect vector byte lengths, hydrating hundreds of MB of BLOBs into the
 * Node heap and blocking the event loop for minutes on production DBs.
 *
 * The new helper `embeddingMaintenanceCounts()` MUST count purely with SQL
 * (`COUNT(*)` + `SUM(CASE WHEN ... LENGTH(vec) ...)`), preserving the two
 * pre-fix semantic filters:
 *   - short-text traces are skipped (mirrors `shouldTraceHaveEmbeddings`)
 *   - `lightweight_memory`-tagged traces don't get counted for `vec_action`
 */

import { describe, expect, it } from "vitest";

import { encodeVector } from "../../../core/storage/vector.js";
import {
  embeddingMaintenanceCounts,
  inferStoredEmbeddingByteLen,
} from "../../../core/storage/repos/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type {
  EpisodeId,
  SessionId,
  SkillId,
  TraceId,
  WorldModelId,
} from "../../../core/types.js";

const DIM = 4;
const EXPECTED_BYTE_LEN = DIM * 4;

function fullVec(): Float32Array {
  return new Float32Array([0.1, 0.2, 0.3, 0.4]);
}

function shortVec(): Float32Array {
  return new Float32Array([9]);
}

function seedSessionAndEpisode(handle: TmpDbHandle): void {
  handle.repos.sessions.upsert({
    id: "se" as SessionId,
    agent: "openclaw",
    ownerAgentKind: "openclaw",
    ownerProfileId: "main",
    ownerWorkspaceId: null,
    startedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    meta: {},
  });
  handle.repos.episodes.insert({
    id: "ep" as EpisodeId,
    sessionId: "se" as SessionId,
    ownerAgentKind: "openclaw",
    ownerProfileId: "main",
    ownerWorkspaceId: null,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    traceIds: [],
    rTask: null,
    status: "open",
    meta: {},
  });
}

function seedTrace(
  handle: TmpDbHandle,
  id: string,
  opts: {
    userText: string;
    agentText: string;
    tags?: string[];
    vecSummary?: Float32Array | null;
    vecAction?: Float32Array | null;
  },
): void {
  handle.repos.traces.insert({
    id: id as TraceId,
    episodeId: "ep" as EpisodeId,
    sessionId: "se" as SessionId,
    ownerAgentKind: "openclaw",
    ownerProfileId: "main",
    ownerWorkspaceId: null,
    ts: 1_700_000_000_000,
    userText: opts.userText,
    agentText: opts.agentText,
    summary: "summary text",
    share: null,
    toolCalls: [],
    agentThinking: null,
    reflection: null,
    value: 0,
    alpha: 0,
    rHuman: null,
    priority: 0,
    tags: opts.tags ?? [],
    errorSignatures: [],
    vecSummary: opts.vecSummary ?? null,
    vecAction: opts.vecAction ?? null,
    turnId: 1_700_000_000_000,
    schemaVersion: 1,
  } as never);
}

function seedPolicy(handle: TmpDbHandle, id: string, vec: Float32Array | null): void {
  handle.repos.policies.upsert({
    id: id as never,
    title: id,
    trigger: "",
    procedure: "",
    verification: "",
    boundary: "",
    support: 0,
    gain: 0,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "proto",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec,
    createdAt: 1,
    updatedAt: 1,
  });
}

function seedWorldModel(
  handle: TmpDbHandle,
  id: string,
  vec: Float32Array | null,
): void {
  handle.repos.worldModel.upsert({
    id: id as WorldModelId,
    title: id,
    body: "world body text",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: [],
    confidence: 0.9,
    policyIds: [],
    sourceEpisodeIds: [],
    inducedBy: "",
    vec,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    status: "active",
  });
}

function seedSkill(handle: TmpDbHandle, id: string, vec: Float32Array | null): void {
  handle.repos.skills.insert({
    id: id as SkillId,
    name: id,
    status: "candidate",
    invocationGuide: "guide",
    procedureJson: null,
    eta: 0,
    support: 0,
    gain: 0,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  });
}

describe("storage/repos — embeddingMaintenanceCounts (issue #1929)", () => {
  it("counts ready / missing / dimMismatch per kind without decoding BLOBs", () => {
    const handle = makeTmpDb();
    try {
      seedSessionAndEpisode(handle);

      // traces
      // - tr_ready: qualifying, has both summary+action vectors at correct dim
      seedTrace(handle, "tr_ready", {
        userText: "hello world what is up",
        agentText: "here is the answer",
        vecSummary: fullVec(),
        vecAction: fullVec(),
      });
      // - tr_missing: qualifying, no vectors at all
      seedTrace(handle, "tr_missing", {
        userText: "hello world what is up",
        agentText: "another answer here",
        vecSummary: null,
        vecAction: null,
      });
      // - tr_dim_mismatch: qualifying, but vec dims wrong
      seedTrace(handle, "tr_dim_mismatch", {
        userText: "hello world what is up",
        agentText: "yet another answer",
        vecSummary: shortVec(),
        vecAction: shortVec(),
      });
      // - tr_short: NOT qualifying (both texts <10, sum <20) — should be excluded
      seedTrace(handle, "tr_short", {
        userText: "hi",
        agentText: "ok",
        vecSummary: null,
        vecAction: null,
      });
      // - tr_lightweight: qualifying for vec_summary but NOT vec_action
      seedTrace(handle, "tr_lightweight", {
        userText: "hello world what is up",
        agentText: "the lightweight answer",
        tags: ["lightweight_memory"],
        vecSummary: fullVec(),
        vecAction: null,
      });

      // policies
      seedPolicy(handle, "po_ready", fullVec());
      seedPolicy(handle, "po_missing", null);
      seedPolicy(handle, "po_dim", shortVec());

      // world_model
      seedWorldModel(handle, "wm_ready", fullVec());
      seedWorldModel(handle, "wm_missing", null);

      // skills
      seedSkill(handle, "sk_ready", fullVec());
      seedSkill(handle, "sk_dim", shortVec());

      const counts = embeddingMaintenanceCounts(handle.db, {
        expectedByteLen: EXPECTED_BYTE_LEN,
      });

      // trace bucket:
      //   summary qualifying rows: tr_ready, tr_missing, tr_dim_mismatch, tr_lightweight  = 4
      //   action  qualifying rows: tr_ready, tr_missing, tr_dim_mismatch                  = 3
      //   totalSlots = 4 + 3                                                              = 7
      //   ready       = tr_ready(summary+action) + tr_lightweight(summary)                = 3
      //   missing     = tr_missing(summary+action)                                        = 2
      //   dimMismatch = tr_dim_mismatch(summary+action)                                   = 2
      expect(counts.trace).toEqual({
        totalSlots: 7,
        ready: 3,
        missing: 2,
        dimMismatch: 2,
      });

      expect(counts.policy).toEqual({
        totalSlots: 3,
        ready: 1,
        missing: 1,
        dimMismatch: 1,
      });

      expect(counts.world_model).toEqual({
        totalSlots: 2,
        ready: 1,
        missing: 1,
        dimMismatch: 0,
      });

      expect(counts.skill).toEqual({
        totalSlots: 2,
        ready: 1,
        missing: 0,
        dimMismatch: 1,
      });
    } finally {
      handle.cleanup();
    }
  });

  it("falls back to 'any non-null = ready' when expectedByteLen is 0", () => {
    const handle = makeTmpDb();
    try {
      seedSessionAndEpisode(handle);
      // A brand-new install with no embedder probe yet: dimension unknown.
      // Any stored BLOB (short or full) should count as ready.
      seedTrace(handle, "tr_full", {
        userText: "hello world what is up",
        agentText: "here is the answer",
        vecSummary: fullVec(),
        vecAction: shortVec(),
      });
      seedTrace(handle, "tr_missing", {
        userText: "hello world what is up",
        agentText: "another answer here",
        vecSummary: null,
        vecAction: null,
      });

      const counts = embeddingMaintenanceCounts(handle.db, { expectedByteLen: 0 });

      // Both slots for tr_full count as ready regardless of BLOB length.
      expect(counts.trace.ready).toBe(2);
      expect(counts.trace.dimMismatch).toBe(0);
      expect(counts.trace.missing).toBe(2);
      expect(counts.trace.totalSlots).toBe(4);
    } finally {
      handle.cleanup();
    }
  });

  it("returns zero counts for an empty database", () => {
    const handle = makeTmpDb();
    try {
      const counts = embeddingMaintenanceCounts(handle.db, {
        expectedByteLen: EXPECTED_BYTE_LEN,
      });
      expect(counts.trace).toEqual({
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
      });
      expect(counts.policy).toEqual({
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
      });
      expect(counts.world_model).toEqual({
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
      });
      expect(counts.skill).toEqual({
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
      });
    } finally {
      handle.cleanup();
    }
  });

  it("infers stored byte length from the mode of trace vec_summary BLOBs", () => {
    const handle = makeTmpDb();
    try {
      seedSessionAndEpisode(handle);
      // Three rows at 4-dim, one at 1-dim → mode = 16 bytes.
      seedTrace(handle, "tr_a", {
        userText: "hello world what is up",
        agentText: "here is the answer",
        vecSummary: fullVec(),
      });
      seedTrace(handle, "tr_b", {
        userText: "hello world what is up",
        agentText: "another answer here",
        vecSummary: fullVec(),
      });
      seedTrace(handle, "tr_c", {
        userText: "hello world what is up",
        agentText: "yet another answer",
        vecSummary: fullVec(),
      });
      seedTrace(handle, "tr_odd", {
        userText: "hello world what is up",
        agentText: "the outlier answer",
        vecSummary: shortVec(),
      });

      expect(inferStoredEmbeddingByteLen(handle.db)).toBe(EXPECTED_BYTE_LEN);
    } finally {
      handle.cleanup();
    }
  });

  it("uses BLOB byte length for dimension comparison", () => {
    expect(encodeVector(fullVec()).byteLength).toBe(EXPECTED_BYTE_LEN);
  });
});
