/**
 * Unit tests for the SQL-only embedding-maintenance count helper.
 *
 * Issue #1929 — `GET /api/v1/embeddings/maintenance` used to load every
 * vector BLOB into JS just to count nulls and dimension mismatches.
 * `embeddingMaintenanceCounts` replaces that with pure SQL `COUNT(*)`
 * queries; these tests pin the bucket semantics + filter rules.
 */
import { describe, expect, it } from "vitest";

import { encodeVector } from "../../../core/storage/vector.js";
import { embeddingMaintenanceCounts } from "../../../core/storage/repos/index.js";
import { makeTmpDb } from "../../helpers/tmp-db.js";
import type { PolicyRow, SkillRow, TraceRow, WorldModelRow } from "../../../core/types.js";

const DIM = 4;
const EXPECTED_BYTE_LEN = DIM * 4; // Float32 = 4 bytes per element

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

function vecBlob(values: number[]): Float32Array {
  // Same as `vec` — kept as a named alias so the test reads like
  // "this is the BLOB shape we expect the SQL helper to see".
  return new Float32Array(values);
}

function ensureTraceParents(repos: ReturnType<typeof makeTmpDb>["repos"]): void {
  // traces FK → episodes / sessions; seed those once per test to keep the
  // per-trace seed helper noise-free.
  if (!repos.sessions.getById("s0")) {
    repos.sessions.upsert({
      id: "s0",
      agent: "openclaw",
      startedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
      meta: {},
    });
  }
  if (!repos.episodes.getById("e0" as never)) {
    repos.episodes.insert({
      id: "e0" as never,
      sessionId: "s0" as never,
      startedAt: 1_700_000_000_000,
      endedAt: null,
      traceIds: [],
      rTask: null,
      status: "open",
    });
  }
}

function seedTrace(
  repos: ReturnType<typeof makeTmpDb>["repos"],
  id: string,
  overrides: Partial<TraceRow>,
): void {
  ensureTraceParents(repos);
  const base: TraceRow = {
    id,
    episodeId: "e0",
    sessionId: "s0",
    ts: 1_700_000_000_000,
    userText: "user message that is comfortably longer than ten chars",
    agentText: "agent reply that is also comfortably long",
    toolCalls: [],
    reflection: null,
    value: 0,
    alpha: 0,
    rHuman: null,
    priority: 0,
    tags: [],
    errorSignatures: [],
    vecSummary: vec([0, 0, 0, 0]),
    vecAction: vec([0, 0, 0, 0]),
    turnId: 1_700_000_000_000 as never,
    schemaVersion: 1,
    ...overrides,
  } as TraceRow;
  repos.traces.insert(base);
}

function seedPolicy(
  repos: ReturnType<typeof makeTmpDb>["repos"],
  id: string,
  vector: Float32Array | null,
): void {
  const row: PolicyRow = {
    id,
    title: id,
    trigger: "",
    procedure: "",
    verification: "",
    boundary: "",
    support: 1,
    gain: 0,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: vector,
    createdAt: 1_700_000_000_000 as never,
    updatedAt: 1_700_000_000_000 as never,
  } as PolicyRow;
  repos.policies.upsert(row);
}

function seedWorldModel(
  repos: ReturnType<typeof makeTmpDb>["repos"],
  id: string,
  vector: Float32Array | null,
): void {
  const row: WorldModelRow = {
    id,
    title: id,
    body: "world model",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: [],
    confidence: 0.5,
    policyIds: [],
    sourceEpisodeIds: [],
    inducedBy: "test",
    vec: vector,
    createdAt: 1_700_000_000_000 as never,
    updatedAt: 1_700_000_000_000 as never,
    version: 1,
    status: "active",
  } as WorldModelRow;
  repos.worldModel.upsert(row);
}

function seedSkill(
  repos: ReturnType<typeof makeTmpDb>["repos"],
  id: string,
  vector: Float32Array | null,
): void {
  const row: SkillRow = {
    id,
    name: id,
    status: "active",
    invocationGuide: "",
    procedureJson: null,
    eta: 0.5,
    support: 1,
    gain: 0,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vector,
    createdAt: 1_700_000_000_000 as never,
    updatedAt: 1_700_000_000_000 as never,
    version: 1,
  } as SkillRow;
  repos.skills.upsert(row);
}

describe("storage/repos — embeddingMaintenanceCounts", () => {
  it("counts ready / missing / dimMismatch per kind without decoding BLOBs", () => {
    const { db, repos, cleanup } = makeTmpDb();
    try {
      // ── Traces ────────────────────────────────────────────────────
      // Two ready summary/action slots.
      seedTrace(repos, "tr_ready", {
        vecSummary: vec([1, 1, 1, 1]),
        vecAction: vec([2, 2, 2, 2]),
      });
      // Missing summary + missing action.
      seedTrace(repos, "tr_missing", {
        vecSummary: null,
        vecAction: null,
      });
      // Dimension mismatch on summary, correct on action.
      seedTrace(repos, "tr_dim_mismatch", {
        vecSummary: vec([1, 2]),
        vecAction: vec([3, 3, 3, 3]),
      });

      // ── Short-text trace (should be filtered out — matches
      //   shouldTraceHaveEmbeddings) ─────────────────────────────────
      seedTrace(repos, "tr_short", {
        userText: "hi",
        agentText: "ok",
        vecSummary: null,
        vecAction: null,
      });

      // ── Lightweight-memory trace (vec_action slot excluded) ───────
      seedTrace(repos, "tr_lightweight", {
        tags: ["lightweight_memory"],
        vecSummary: vec([1, 1, 1, 1]),
        vecAction: null,
      });

      // ── Policies / world_model / skills ──────────────────────────
      seedPolicy(repos, "p_ready", vec([1, 1, 1, 1]));
      seedPolicy(repos, "p_missing", null);
      seedPolicy(repos, "p_dim", vec([1, 2, 3])); // dimension mismatch

      seedWorldModel(repos, "wm_ready", vec([2, 2, 2, 2]));
      seedWorldModel(repos, "wm_missing", null);

      seedSkill(repos, "sk_ready", vec([3, 3, 3, 3]));

      const counts = embeddingMaintenanceCounts(db, {
        expectedByteLen: EXPECTED_BYTE_LEN,
      });

      // Trace bucket:
      //   summary slots qualifying: tr_ready, tr_missing, tr_dim_mismatch, tr_lightweight = 4
      //   action slots qualifying:  tr_ready, tr_missing, tr_dim_mismatch  = 3 (lightweight excluded)
      //   short-text trace excluded from BOTH slot counts.
      //   ready summary: tr_ready, tr_lightweight = 2
      //   ready action:  tr_ready, tr_dim_mismatch = 2
      //   missing summary: tr_missing = 1
      //   missing action:  tr_missing = 1 (lightweight excluded)
      //   dimMismatch summary: tr_dim_mismatch = 1
      expect(counts.trace.totalSlots).toBe(7);
      expect(counts.trace.ready).toBe(4);
      expect(counts.trace.missing).toBe(2);
      expect(counts.trace.dimMismatch).toBe(1);

      // Policy bucket: 1 ready, 1 missing, 1 dim mismatch
      expect(counts.policy.totalSlots).toBe(3);
      expect(counts.policy.ready).toBe(1);
      expect(counts.policy.missing).toBe(1);
      expect(counts.policy.dimMismatch).toBe(1);

      // World model: 1 ready, 1 missing
      expect(counts.world_model.totalSlots).toBe(2);
      expect(counts.world_model.ready).toBe(1);
      expect(counts.world_model.missing).toBe(1);

      // Skill: 1 ready, 0 missing
      expect(counts.skill.totalSlots).toBe(1);
      expect(counts.skill.ready).toBe(1);
      expect(counts.skill.missing).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("falls back to 'any non-null = ready' when expectedByteLen is 0", () => {
    const { db, repos, cleanup } = makeTmpDb();
    try {
      seedTrace(repos, "tr_a", { vecSummary: vec([1, 2]), vecAction: null });
      seedTrace(repos, "tr_b", { vecSummary: vec([1, 2, 3, 4]), vecAction: vec([5, 6, 7, 8]) });

      const counts = embeddingMaintenanceCounts(db, { expectedByteLen: 0 });
      // No expected length → every non-null vector counts as ready
      // and dimMismatch is always zero.
      expect(counts.trace.ready).toBe(3); // tr_a.summary + tr_b.summary + tr_b.action
      expect(counts.trace.missing).toBe(1); // tr_a.action
      expect(counts.trace.dimMismatch).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("returns zero counts for an empty database", () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const counts = embeddingMaintenanceCounts(db, {
        expectedByteLen: EXPECTED_BYTE_LEN,
      });
      expect(counts.trace.totalSlots).toBe(0);
      expect(counts.policy.totalSlots).toBe(0);
      expect(counts.world_model.totalSlots).toBe(0);
      expect(counts.skill.totalSlots).toBe(0);
      for (const bucket of Object.values(counts)) {
        expect(bucket.ready).toBe(0);
        expect(bucket.missing).toBe(0);
        expect(bucket.dimMismatch).toBe(0);
      }
    } finally {
      cleanup();
    }
  });

  it("uses BLOB byte length for dimension comparison (encoded by encodeVector)", () => {
    // Sanity check: the stored BLOB byte length must equal `dim * 4`
    // so the SQL `LENGTH(vec) <> @expected_byte_len` comparison works.
    const float32 = vecBlob([1, 2, 3, 4]);
    const buf = encodeVector(float32);
    expect(buf.byteLength).toBe(EXPECTED_BYTE_LEN);
  });
});
