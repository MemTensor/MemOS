/**
 * Offline verification drill (read-only simulation + snapshot
 * migration/inference/restart + both-modes + timer throughput).
 *
 * OFFLINE ONLY. Every test builds a GENERATED scratch DB under os.tmpdir()
 * (via makeTmpDb / raw openDb) and never touches a live host DB — no real
 * snapshot was available in this lane, so the drill runs on generated scratch
 * data and says so. Nothing here writes outside its own tmp dir; nothing is a
 * permanent product surface (no src/ changes, assertions only).
 *
 * Drill legs:
 *  (a) FRESH historical simulation refresh: trace_ids_json grouping (with a
 *      duplicated ID proving distinct-S), both inferred provenances
 *      (inferred_normalized + legacy_unscaled), NULL exclusion, exact-owner
 *      handling (foreign-owner episode untouched), orphan + malformed-JSON
 *      reporting. Totals are recorded fresh below — the old 305 projection
 *      is NOT reused.
 *  (b) Snapshot schema-migration timing + inference/restart drill incl.
 *      restart idempotence (second pass stamps nothing).
 *  (c) Both modes (gainV2Enabled on/off) behavior check on the repair tick.
 *  (d) Timer throughput/latency measured on the snapshot: 100 attempts/hour
 *      is nominal capacity (batch 25 per 900 s interval), NOT a guarantee —
 *      the drill records the measured wall rate, per-attempt latency and
 *      backlog behavior.
 *  (e) Unchanged V/priority everywhere; unchanged startup policy fields
 *      after the migration+inference path (repair ticks may only move
 *      gain/gain_version/status/updated_at — support and all content fields
 *      are preserved).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GAIN_INFERENCE_VERSION,
  runGainInference,
} from "../../../core/reward/gain-inference.js";
import {
  gainRepairRescreenKey,
  runGainRepairTick,
  type GainRepairAttemptDeps,
  type GainRepairOwner,
} from "../../../core/memory/l2/gain-repair.js";
import { selectAndComputeGain } from "../../../core/memory/l2/recompute-gain.js";
import type { GainEvidenceTrace } from "../../../core/memory/l2/recompute-gain.js";
import type { L2Config } from "../../../core/memory/l2/types.js";
import {
  makeRepos,
  openDb,
  runMigrations,
} from "../../../core/storage/index.js";
import { rootLogger } from "../../../core/logger/index.js";
import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../core/types.js";
import type { GainValueSource } from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000 as EpochMs; // 2023 — pre-cutover, so legacy groups are not post-cutover.
const OWNER: GainRepairOwner = {
  ownerAgentKind: "openclaw",
  ownerProfileId: "default",
  ownerWorkspaceId: null,
};
const THRESHOLDS = { minSupport: 2, minGain: 0.04, archiveGain: -0.05 };

function baseConfig(overrides: Partial<L2Config> = {}): L2Config {
  return {
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
    gainRepairBatchSize: 25,
    gainRepairIntervalMs: 900_000,
    gainRepairMaxTotal: 25,
    gainRepairRescreenGeneration: 0,
    ...overrides,
  };
}

// ─── Scratch seeding (generated data, tmp DBs only) ──────────────────────────

function seedTrace(
  h: TmpDbHandle,
  id: string,
  eid: string,
  partial: Partial<TraceRow> = {},
): void {
  h.repos.traces.insert({
    id: id as TraceId,
    episodeId: eid as EpisodeId,
    sessionId: "s1" as SessionId,
    ts: (partial.ts ?? NOW) as EpochMs,
    userText: partial.userText ?? "user text",
    agentText: partial.agentText ?? "agent text",
    toolCalls: [],
    reflection: null,
    value: partial.value ?? 0,
    alpha: (partial.alpha ?? 0.5) as TraceRow["alpha"],
    rHuman: partial.rHuman ?? null,
    priority: partial.priority ?? 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  } as TraceRow);
}

function seedEpisode(h: TmpDbHandle, eid: string, traceIds: string[]): void {
  if (!h.repos.sessions.getById("s1" as never)) {
    h.repos.sessions.upsert({
      id: "s1" as never,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
  }
  h.repos.episodes.insert({
    id: eid as unknown as EpisodeId,
    sessionId: "s1" as never,
    startedAt: NOW,
    endedAt: NOW,
    status: "closed",
    rTask: null,
    traceIds,
    meta: {},
  } as never);
}

/** Historical-simulation dataset: conserving + legacy + unresolved + orphan + foreign + malformed. */
function seedSimulation(h: TmpDbHandle): void {
  // Conserving group: N=2 nonzero, gain = clamp(0.5*2) = 1.0 → inferred_normalized.
  // Duplicated "tc1" in S proves distinct-S grouping (2 stamped traces, not 3).
  seedEpisode(h, "ep_c1", ["tc1", "tc2", "tc1"]);
  seedTrace(h, "tc1", "ep_c1", { value: 0.5, rHuman: 1 });
  seedTrace(h, "tc2", "ep_c1", { value: 0.5, rHuman: 1 });
  // Orphan: same episode_id, never listed in S → unresolved, unstamped, reported.
  seedTrace(h, "orph_c1", "ep_c1", { value: 0.9, rHuman: 1 });

  // Non-conserving but integrity-ok: 0.525*2 = 1.05 (outside tolerance) → legacy_unscaled, gain = V.
  seedEpisode(h, "ep_l1", ["tl1", "tl2"]);
  seedTrace(h, "tl1", "ep_l1", { value: 0.525, rHuman: 1 });
  seedTrace(h, "tl2", "ep_l1", { value: 0.525, rHuman: 1 });

  // NULL evidence → unresolved (NULL gain, stamped so restarts never rescan).
  seedEpisode(h, "ep_u1", ["tu1", "tu2"]);
  seedTrace(h, "tu1", "ep_u1", { value: 0.5, rHuman: 1 });
  seedTrace(h, "tu2", "ep_u1", { value: 0.5, rHuman: null });

  // Foreign-owner episode: exact-owner handling must leave it entirely untouched.
  seedEpisode(h, "ep_f1", ["tf1", "tf2"]);
  seedTrace(h, "tf1", "ep_f1", { value: 0.5, rHuman: 1 });
  seedTrace(h, "tf2", "ep_f1", { value: 0.5, rHuman: 1 });
  h.db.exec(
    `UPDATE episodes SET owner_agent_kind='hermes', owner_profile_id='other' WHERE id='ep_f1'`,
  );

  // Malformed trace_ids_json: invalid-JSON group, member stamped unresolved via the member branch.
  // (Bypasses the episodes.json_valid CHECK the way a legacy/foreign writer could — same idiom as
  // the gain-inference suite's setTraceIdsJsonRaw.)
  seedEpisode(h, "ep_bad", ["tb1"]);
  seedTrace(h, "tb1", "ep_bad", { value: 0.5, rHuman: 1 });
  h.db.raw.pragma("ignore_check_constraints = ON");
  try {
    h.db.exec(`UPDATE episodes SET trace_ids_json='not-json{{{' WHERE id='ep_bad'`);
  } finally {
    h.db.raw.pragma("ignore_check_constraints = OFF");
  }
}

function snapshotTraces(h: TmpDbHandle): Array<{
  id: string;
  value: number;
  alpha: number;
  rHuman: number | null;
  priority: number;
}> {
  return h.db
    .prepare<unknown, { id: string; value: number; alpha: number; r_human: number | null; priority: number }>(
      `SELECT id, value, alpha, r_human, priority FROM traces ORDER BY id`,
    )
    .all()
    .map((r) => ({ id: r.id, value: r.value, alpha: r.alpha, rHuman: r.r_human, priority: r.priority }));
}

function snapshotPolicies(h: TmpDbHandle): unknown[] {
  return h.db
    .prepare<unknown, Record<string, unknown>>(`SELECT * FROM policies ORDER BY id`)
    .all();
}

function tickDeps(h: TmpDbHandle, config: L2Config, extra: Partial<GainRepairAttemptDeps> = {}): GainRepairAttemptDeps {
  return {
    db: h.db,
    repos: h.repos,
    config,
    owner: OWNER,
    thresholds: THRESHOLDS,
    log: rootLogger.child({ channel: "test.task6-drill" }),
    now: () => NOW,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    ...extra,
  };
}

function preConsumeRescreen(h: TmpDbHandle): void {
  h.repos.kv.set(gainRepairRescreenKey(OWNER), {
    generation: 0,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    consumedAt: NOW,
  });
}

/** Repair-queue policy with resolved inferred evidence + queue entry (engine-level, no pipeline). */
function seedRepairPolicy(h: TmpDbHandle, id: string, gainValue = 0.6): void {
  const episodeId = `ep_${id}`;
  const traceId = `tr_${id}`;
  if (!h.repos.sessions.getById("s_rec" as never)) {
    h.repos.sessions.upsert({
      id: "s_rec" as never,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
  }
  h.repos.episodes.insert({
    id: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    startedAt: NOW,
    endedAt: NOW,
    status: "closed",
    rTask: null,
    traceIds: [],
    meta: {},
  } as never);
  h.repos.traces.insert({
    id: traceId as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    ts: NOW,
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value: 0.5,
    alpha: 0.5,
    rHuman: 0.5,
    priority: 0.3,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0,
    schemaVersion: 1,
    gainValue,
    gainValueSource: "inferred_normalized" as GainValueSource,
    gainInferenceVersion: GAIN_INFERENCE_VERSION,
    ownerAgentKind: OWNER.ownerAgentKind,
    ownerProfileId: OWNER.ownerProfileId,
    ownerWorkspaceId: null,
  } as TraceRow);
  h.repos.episodes.appendTrace(episodeId as EpisodeId, [traceId]);
  h.repos.policies.insert({
    id: id as PolicyId,
    title: "drill title",
    trigger: "drill trigger",
    procedure: "drill procedure",
    verification: "drill verification",
    boundary: "drill boundary",
    support: 0,
    gain: 0,
    gainVersion: 1,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "task6-drill",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: NOW,
    updatedAt: NOW,
    sourceTraceIds: [traceId],
    ownerAgentKind: OWNER.ownerAgentKind,
    ownerProfileId: OWNER.ownerProfileId,
    ownerWorkspaceId: null,
  } as PolicyRow);
  h.repos.tracePolicyLinks.link({
    traceId: traceId as TraceId,
    policyId: id as PolicyId,
    episodeId: episodeId as EpisodeId,
    now: NOW,
  });
  h.repos.gainRepair.upsertPending({
    policyId: id as PolicyId,
    ownerAgentKind: OWNER.ownerAgentKind,
    ownerProfileId: OWNER.ownerProfileId,
    ownerWorkspaceId: null,
    reason: "inferred_evidence_updated",
    inferenceVersion: GAIN_INFERENCE_VERSION,
    now: NOW,
  });
}

// ─── Drill ────────────────────────────────────────────────────────────────────

describe("offline verification drill (generated scratch DBs only)", () => {
  let handles: TmpDbHandle[] = [];
  afterEach(() => {
    for (const h of handles) h.cleanup();
    handles = [];
  });
  function scratch(): TmpDbHandle {
    const h = makeTmpDb({ agent: "openclaw" });
    handles.push(h);
    return h;
  }

  it("(a) FRESH historical simulation: trace_ids_json grouping, both provenances, NULL exclusion, exact-owner — fresh totals", () => {
    const h = scratch();
    seedSimulation(h);
    const tracesBefore = snapshotTraces(h);

    const t0 = Date.now();
    const report = runGainInference({
      db: h.db,
      kv: h.repos.kv,
      episodesRepo: h.repos.episodes,
      tracesRepo: h.repos.traces,
      owner: { ownerAgentKind: "openclaw", ownerProfileId: "default" },
    });
    const inferenceMs = Date.now() - t0;

    // FRESH totals (recorded here; the old 305 projection is NOT reused):
    // groups: ep_c1 inferred(2 traces) + ep_l1 legacy(2) + ep_u1 unresolved(2)
    //   + ep_bad unresolved-malformed(1); ep_f1 excluded by exact owner.
    expect(report.candidateGroups).toBe(4);
    expect(report.inferredNormalized).toEqual({ groups: 1, traces: 2 });
    expect(report.legacyUnscaled).toEqual({ groups: 1, traces: 2 });
    expect(report.unresolved).toEqual({ groups: 2, traces: 3 });
    expect(report.orphansOutsideS).toBe(1);
    expect(report.invalidJsonGroups).toBe(1);
    expect(report.stampedTraces).toBe(7);

    // Spot-check resolved values.
    const tc1 = h.repos.traces.getById("tc1" as TraceId)!;
    expect(tc1.gainValueSource).toBe("inferred_normalized");
    expect(tc1.gainValue).toBeCloseTo(1, 12);
    const tl1 = h.repos.traces.getById("tl1" as TraceId)!;
    expect(tl1.gainValueSource).toBe("legacy_unscaled");
    expect(tl1.gainValue).toBeCloseTo(0.525, 12);
    const tu2 = h.repos.traces.getById("tu2" as TraceId)!;
    expect(tu2.gainValue).toBeNull();
    expect(tu2.gainValueSource).toBeNull();
    expect(tu2.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION); // stamped even when unresolved
    const tb1 = h.repos.traces.getById("tb1" as TraceId)!;
    expect(tb1.gainValue).toBeNull();
    expect(tb1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);

    // Exact-owner handling: foreign episode + orphan fully untouched.
    const tf1 = h.repos.traces.getById("tf1" as TraceId)!;
    expect(tf1.gainValue).toBeNull();
    expect(tf1.gainInferenceVersion).toBe(0);
    const orph = h.repos.traces.getById("orph_c1" as TraceId)!;
    expect(orph.gainValue).toBeNull();
    expect(orph.gainInferenceVersion).toBe(0);

    // (e) V/priority byte-identical after the read-only pass.
    expect(snapshotTraces(h)).toEqual(tracesBefore);

    // eslint-disable-next-line no-console
    console.log(
      `[task6-drill] sim FRESH totals: candidates=${report.candidateGroups} ` +
        `inferred=${report.inferredNormalized.groups}g/${report.inferredNormalized.traces}t ` +
        `legacy=${report.legacyUnscaled.groups}g/${report.legacyUnscaled.traces}t ` +
        `unresolved=${report.unresolved.groups}g/${report.unresolved.traces}t ` +
        `orphans=${report.orphansOutsideS} invalidJson=${report.invalidJsonGroups} ` +
        `stamped=${report.stampedTraces} inferenceMs=${inferenceMs}`,
    );
  });

  it("(a-ii) NULL exclusion runs BEFORE the final 50 cap (55 resolved + 5 NULL with-evidence)", () => {
    const tracesById = new Map<string, GainEvidenceTrace>();
    const withIds: string[] = [];
    const poolIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `w_res_${i}`;
      withIds.push(id);
      poolIds.push(id);
      tracesById.set(id, {
        id: id as TraceId,
        episodeId: "ep_x" as EpisodeId,
        ts: (NOW + i) as EpochMs,
        value: 0.5,
        gainValue: 0.5,
        gainValueSource: "inferred_normalized",
        ownerAgentKind: "openclaw",
        ownerProfileId: "default",
        ownerWorkspaceId: null,
      });
    }
    for (let i = 0; i < 5; i++) {
      const id = `w_null_${i}`;
      withIds.push(id);
      poolIds.push(id);
      tracesById.set(id, {
        id: id as TraceId,
        episodeId: "ep_x" as EpisodeId,
        ts: (NOW + 100 + i) as EpochMs,
        value: 0.5,
        gainValue: null, // NULL evidence — must be excluded, never scored
        gainValueSource: null,
        ownerAgentKind: "openclaw",
        ownerProfileId: "default",
        ownerWorkspaceId: null,
      });
    }
    const out = selectAndComputeGain({
      policy: {
        id: "po_drill" as PolicyId,
        support: 0,
        gain: 0,
        gainVersion: 1,
        ownerAgentKind: "openclaw",
        ownerProfileId: "default",
        ownerWorkspaceId: null,
      },
      withIds,
      poolIds,
      tracesById,
      scoreMode: "gain",
      config: { gainEmaAlpha: 0.4, tauSoftmax: 0.5 },
    });
    expect(out.skipReason).toBeNull();
    expect(out.excluded.unresolvedWith).toBe(5); // NULLs excluded first…
    expect(out.excluded.withBeyondLimit).toBe(5); // …then the final 50 cap cuts 55 → 50
    expect(out.selectedWithIds).toHaveLength(50);
    expect(out.selectedWithIds.some((id) => id.startsWith("w_null_"))).toBe(false);
  });

  it("(b) snapshot schema-migration timing + inference/restart idempotence; (e) startup policy fields unchanged", () => {
    // Migration timing on a bare scratch DB (offline snapshot stand-in).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-task6-mig-"));
    try {
      const filepath = path.join(dir, "memos.db");
      const db = openDb({ filepath, agent: "openclaw" });
      try {
        const t0 = Date.now();
        const result = runMigrations(db);
        const migrationMs = Date.now() - t0;
        expect(result.applied.length).toBeGreaterThan(0);
        expect(result.applied.map((m) => m.version)).toContain(19);
        // eslint-disable-next-line no-console
        console.log(
          `[task6-drill] migration timing: applied=${result.applied.length} migrationMs=${migrationMs}`,
        );
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Restart drill: seed history + policies, snapshot, run, re-run.
    const h = scratch();
    seedSimulation(h);
    seedRepairPolicy(h, "po_drill_1");
    seedRepairPolicy(h, "po_drill_2");
    const policiesBefore = snapshotPolicies(h);
    const tracesBefore = snapshotTraces(h);

    const run = () =>
      runGainInference({
        db: h.db,
        kv: h.repos.kv,
        episodesRepo: h.repos.episodes,
        tracesRepo: h.repos.traces,
        owner: { ownerAgentKind: "openclaw", ownerProfileId: "default" },
      });
    const first = run();
    expect(first.stampedTraces).toBeGreaterThan(0);
    // (e) startup path mutates NO policy field.
    expect(snapshotPolicies(h)).toEqual(policiesBefore);
    expect(snapshotTraces(h)).toEqual(tracesBefore);

    // Restart idempotence: second pass stamps nothing, reprocesses nothing —
    // per-run provenance counts are all zero, which IS the no-rescan proof.
    const second = run();
    expect(second.stampedTraces).toBe(0);
    expect(second.candidateGroups).toBe(0);
    expect(second.inferredNormalized).toEqual({ groups: 0, traces: 0 });
    expect(second.legacyUnscaled).toEqual({ groups: 0, traces: 0 });
    expect(second.unresolved).toEqual({ groups: 0, traces: 0 });
    expect(snapshotPolicies(h)).toEqual(policiesBefore);
    // eslint-disable-next-line no-console
    console.log(
      `[task6-drill] restart idempotence: firstStamped=${first.stampedTraces} secondStamped=${second.stampedTraces}`,
    );
  });

  it("(c) both modes: disabled tick attempts nothing; enabled tick drains (queue/budget intact otherwise)", () => {
    const h = scratch();
    preConsumeRescreen(h);
    seedRepairPolicy(h, "po_mode_1");
    seedRepairPolicy(h, "po_mode_2");

    const pendingBefore = h.db
      .prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_queue WHERE state='pending'`)
      .get()!.n;
    expect(pendingBefore).toBe(2);

    // Disabled mode: zero attempts, queue untouched, no journal writes.
    const off = runGainRepairTick(tickDeps(h, baseConfig({ gainV2Enabled: false })));
    expect(off.attempted).toBe(0);
    expect(
      h.db.prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_queue`).get()!.n,
    ).toBe(2);
    expect(
      h.db.prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_journal`).get()!.n,
    ).toBe(0);

    // Enabled mode: attempts flow; still read-only w.r.t. V/priority.
    const tracesBefore = snapshotTraces(h);
    const on = runGainRepairTick(tickDeps(h, baseConfig({ gainV2Enabled: true })));
    expect(on.attempted).toBe(2);
    expect(snapshotTraces(h)).toEqual(tracesBefore);
    // eslint-disable-next-line no-console
    console.log(`[task6-drill] modes: disabledAttempted=${off.attempted} enabledAttempted=${on.attempted}`);
  });

  it("(d) timer throughput/latency on snapshot: 30 pending, batch 25/maxTotal 25 — measured rate vs nominal 100/hour", () => {
    const h = scratch();
    preConsumeRescreen(h);
    for (let i = 0; i < 30; i++) seedRepairPolicy(h, `po_t_${String(i).padStart(2, "0")}`);
    const tracesBefore = snapshotTraces(h);
    const policiesBefore = snapshotPolicies(h) as Array<Record<string, unknown>>;

    const t0 = Date.now();
    const first = runGainRepairTick(
      tickDeps(h, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 25 })),
    );
    const tickMs = Date.now() - t0;
    expect(first.attempted).toBe(25);
    const perAttemptMs = tickMs / 25;
    const projectedPerHour = tickMs > 0 ? Math.round((25 / tickMs) * 3_600_000) : Number.POSITIVE_INFINITY;
    // Nominal capacity is 100 attempts/hour (25 per 900 s tick): the engine is
    // far faster than the schedule — the interval, not execution, paces drain.
    // Backlog: 5 remain pending; the ceiling blocks the very next tick.
    const t1 = Date.now();
    const second = runGainRepairTick(
      tickDeps(h, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 25 })),
    );
    const secondMs = Date.now() - t1;
    expect(second.attempted).toBe(0);
    const pendingAfter = h.db
      .prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_queue WHERE state='pending'`)
      .get()!.n;
    expect(pendingAfter).toBe(5);

    // (e) V/priority unchanged by the repair ticks…
    expect(snapshotTraces(h)).toEqual(tracesBefore);
    // …and policy writes are confined to the five CAS fields: every content /
    // support / lineage field is byte-identical, only gain/gain_version /
    // status / updated_at may move.
    const policiesAfter = snapshotPolicies(h) as Array<Record<string, unknown>>;
    const beforeById = new Map(policiesBefore.map((p) => [p["id"], p]));
    for (const after of policiesAfter) {
      const before = beforeById.get(after["id"])!;
      for (const k of [
        "id",
        "title",
        "trigger",
        "procedure",
        "verification",
        "boundary",
        "support",
        "induced_by",
        "created_at",
        "source_episode_ids",
        "source_trace_ids",
      ]) {
        expect(after[k], `policy ${after["id"]} field ${k}`).toEqual(before[k]);
      }
    }
    // Completed journal rows recorded the post-write timestamp (CAS-safe).
    const nullTs = h.db
      .prepare<unknown, { n: number }>(
        `SELECT COUNT(*) AS n FROM gain_repair_journal WHERE result='completed' AND new_updated_at IS NULL`,
      )
      .get()!.n;
    expect(nullTs).toBe(0);
    // eslint-disable-next-line no-console
    console.log(
      `[task6-drill] timer: attempted=${first.attempted} tickMs=${tickMs} ` +
        `perAttemptMs=${perAttemptMs.toFixed(2)} projectedPerHour=${projectedPerHour} ` +
        `nominalPerHour=100 secondTickAttempted=${second.attempted} secondMs=${secondMs} ` +
        `backlogPending=${pendingAfter}`,
    );
  });
});
