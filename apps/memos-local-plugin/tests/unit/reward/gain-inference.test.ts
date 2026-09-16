/**
 * Historical gain inference.
 *
 * S is the distinct set of IDs in episodes.trace_ids_json (the actual reward
 * pass), never all episode_id rows. Orphan rows outside S stay unresolved and
 * are reported separately. Missing listed members forbid deriving N from a
 * partial set. Every screening attempt — including unresolved ones — stamps
 * GAIN_INFERENCE_VERSION so a restart does not rescan stamped groups.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GAIN_INFERENCE_VERSION,
  GAIN_POST_CUTOVER_BOUNDARY_MS,
  GAIN_REPAIR_QUEUE_SEED_KEY,
  reconcileGainRepairQueue,
  screenGainGroup,
  runGainInference,
} from "../../../core/reward/gain-inference.js";
import type { EpisodeId, EpochMs, TraceRow } from "../../../core/types.js";
import type { TmpDbHandle } from "../../helpers/tmp-db.js";
import { makeTmpDb } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000 as EpochMs;
const OWNER = { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null };

function member(
  partial: Partial<{
    id: string;
    episodeId: string;
    value: number;
    rHuman: number | null;
    ts: number;
    ownerAgentKind?: string;
    ownerProfileId?: string;
    ownerWorkspaceId?: string | null;
  }>,
) {
  return {
    id: partial.id ?? "t",
    episodeId: partial.episodeId ?? "ep",
    value: partial.value ?? 0,
    rHuman: partial.rHuman ?? null,
    ts: partial.ts ?? NOW,
    ownerAgentKind: partial.ownerAgentKind ?? "unknown",
    ownerProfileId: partial.ownerProfileId ?? "default",
    ownerWorkspaceId: partial.ownerWorkspaceId ?? null,
  };
}

function seedTrace(handle: TmpDbHandle, id: string, eid: string, partial: Partial<TraceRow> = {}): void {
  const row: TraceRow = {
    id: id as unknown as TraceRow["id"],
    episodeId: eid as unknown as TraceRow["episodeId"],
    sessionId: ("s1" as unknown) as TraceRow["sessionId"],
    ts: (partial.ts ?? NOW) as EpochMs,
    userText: partial.userText ?? "user text",
    agentText: partial.agentText ?? "agent text",
    toolCalls: [],
    reflection: partial.reflection ?? null,
    value: partial.value ?? 0,
    alpha: (partial.alpha ?? 0) as TraceRow["alpha"],
    rHuman: partial.rHuman ?? null,
    priority: partial.priority ?? 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
    ...(partial.ownerAgentKind ? { ownerAgentKind: partial.ownerAgentKind } : {}),
    ...(partial.ownerProfileId ? { ownerProfileId: partial.ownerProfileId } : {}),
    ...(partial.ownerWorkspaceId !== undefined
      ? { ownerWorkspaceId: partial.ownerWorkspaceId }
      : {}),
  };
  handle.repos.traces.insert(row);
}

function seedEpisode(
  handle: TmpDbHandle,
  eid: string,
  traceIds: string[],
  meta: Record<string, unknown> = {},
  workspaceId?: string | null,
): void {
  // upsert is INSERT OR REPLACE: re-upserting session s1 would DELETE it and
  // cascade-delete every episode/trace that references it. Seed once.
  if (!handle.repos.sessions.getById("s1" as never)) {
    handle.repos.sessions.upsert({
      id: "s1" as never,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
  }
  handle.repos.episodes.insert({
    id: eid as unknown as EpisodeId,
    sessionId: "s1" as never,
    startedAt: NOW as EpochMs,
    endedAt: NOW as EpochMs,
    status: "closed",
    rTask: null,
    traceIds,
    meta,
    ...(workspaceId !== undefined ? { ownerWorkspaceId: workspaceId } : {}),
  } as never);
}

describe("screenGainGroup (pure)", () => {
  it("requires a nonempty, valid, complete member set", () => {
    expect(screenGainGroup({ episodeId: "ep", traceIds: [], members: [] }).status).toBe("unresolved");
    // Listed member missing from the fetched set → never derive N from a partial set.
    const missing = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1 })],
    });
    expect(missing.status).toBe("unresolved");
    expect(missing.reason).toMatch(/missing/);
  });

  it("rejects members outside the episode and mixed ownership", () => {
    const outside = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", episodeId: "other_ep", value: 0.5, rHuman: 1 })],
    });
    expect(outside.status).toBe("unresolved");

    const mixed = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1, ownerAgentKind: "openclaw" })],
      episodeOwnerAgentKind: "hermes",
    });
    expect(mixed.status).toBe("unresolved");
    expect(mixed.reason).toMatch(/owner/);
  });

  it("rejects member workspace mismatch with NULL-exact semantics", () => {
    // Episode in ws-a, member in ws-b → unresolved, never a numeric gain.
    const mixed = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1, ownerWorkspaceId: "ws-b" })],
      episodeOwnerWorkspaceId: "ws-a",
    });
    expect(mixed.status).toBe("unresolved");
    expect(mixed.reason).toMatch(/owner/);

    // NULL workspace is exact, not a wildcard: a NULL member in a ws-a
    // episode still mismatches.
    const nullMember = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1, ownerWorkspaceId: null })],
      episodeOwnerWorkspaceId: "ws-a",
    });
    expect(nullMember.status).toBe("unresolved");
    expect(nullMember.reason).toMatch(/owner/);

    // ...and NULL matches only NULL (group screens normally).
    const nullMatch = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", value: 0.9, rHuman: 0.9, ownerWorkspaceId: null })],
      episodeOwnerWorkspaceId: null,
    });
    expect(nullMatch.status).toBe("inferred_normalized");
  });

  it("requires finite V and r_human within [-1, 1] on every member", () => {
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1"],
        members: [member({ id: "t1", value: 2, rHuman: 1 })],
      }).status,
    ).toBe("unresolved");
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1"],
        members: [member({ id: "t1", value: 0.5, rHuman: null })],
      }).status,
    ).toBe("unresolved");
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1"],
        members: [member({ id: "t1", value: 0.5, rHuman: Number.NaN })],
      }).status,
    ).toBe("unresolved");
  });

  it("requires reward consistency within 1e-9", () => {
    const mixed = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1 }), member({ id: "t2", value: 0.5, rHuman: 0.9 })],
    });
    expect(mixed.status).toBe("unresolved");
    expect(mixed.reason).toMatch(/reward/i);
  });

  it("enforces sign: nonzero V shares R's sign; R=0 requires all V=0", () => {
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1"],
        members: [member({ id: "t1", value: 0.5, rHuman: -0.8 })],
      }).status,
    ).toBe("unresolved");
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1", "t2"],
        members: [member({ id: "t1", value: 0.1, rHuman: 0 }), member({ id: "t2", value: 0, rHuman: 0 })],
      }).status,
    ).toBe("unresolved");
    // R=0 with all V=0 passes integrity.
    expect(
      screenGainGroup({
        episodeId: "ep",
        traceIds: ["t1", "t2"],
        members: [member({ id: "t1", value: 0, rHuman: 0 }), member({ id: "t2", value: 0, rHuman: 0 })],
      }).status,
    ).toBe("inferred_normalized");
  });

  it("cross-checks meta.reward.traceIds exact-set equality when present", () => {
    const mismatch = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1 }), member({ id: "t2", value: 0.5, rHuman: 1 })],
      metaRewardTraceIds: ["t1", "t2", "ghost"],
    });
    expect(mismatch.status).toBe("unresolved");
    expect(mismatch.reason).toMatch(/traceIds|trace_ids/i);
    // Absent metadata permits inference (audit counts it).
    const absent = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5, rHuman: 1 }), member({ id: "t2", value: 0.5, rHuman: 1 })],
      metaRewardTraceIds: null,
    });
    expect(absent.status).toBe("inferred_normalized");
  });

  it("scalar/object/numeric-element meta.reward.traceIds never passes the cross-check", () => {
    const base = {
      episodeId: "ep",
      traceIds: ["t1"],
      members: [member({ id: "t1", value: 0.9, rHuman: 0.9 })],
    };
    // A scalar equal to the member id must STILL be unresolved — never coerced
    // into a one-element array that could pass the exact-set check.
    expect(screenGainGroup({ ...base, metaRewardTraceIds: "t1" }).status).toBe("unresolved");
    expect(screenGainGroup({ ...base, metaRewardTraceIds: ["t1", 5] }).status).toBe("unresolved");
    expect(screenGainGroup({ ...base, metaRewardTraceIds: { 0: "t1" } }).status).toBe("unresolved");
    expect(screenGainGroup({ ...base, metaRewardTraceIds: [null] }).status).toBe("unresolved");
  });

  it("conserving groups use contributor scaling (inferred_normalized)", () => {
    const out = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2", "t3"],
      members: [
        member({ id: "t1", value: 0.5, rHuman: 1 }),
        member({ id: "t2", value: 0.5, rHuman: 1 }),
        member({ id: "t3", value: 0, rHuman: 1 }),
      ],
    });
    expect(out.status).toBe("inferred_normalized");
    expect(out.nonzeroCount).toBe(2);
    // clamp(V * nonzeroCount) = clamp(0.5 * 2) = 1
    expect(out.gainByTraceId.get("t1")).toBeCloseTo(1, 12);
    expect(out.gainByTraceId.get("t2")).toBeCloseTo(1, 12);
    expect(out.gainByTraceId.get("t3")).toBe(0);
  });

  it("non-conserving groups with integrity use V unchanged (legacy_unscaled)", () => {
    const out = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5, rHuman: 0.9 }), member({ id: "t2", value: 0.5, rHuman: 0.9 })],
    });
    expect(out.status).toBe("legacy_unscaled");
    expect(out.gainByTraceId.get("t1")).toBeCloseTo(0.5, 12);
    expect(out.gainByTraceId.get("t2")).toBeCloseTo(0.5, 12);
  });

  it("applies the 0.2% / 1% conservation tolerance", () => {
    // |sum(V)-R| = 0.003 with R=1 → 0.003 <= max(0.002, 0.01) → inferred.
    const within = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.5015, rHuman: 1 }), member({ id: "t2", value: 0.5015, rHuman: 1 })],
    });
    expect(within.status).toBe("inferred_normalized");
    // |sum(V)-R| = 0.05 with R=1 → 0.05 > 0.01 → legacy_unscaled.
    const beyond = screenGainGroup({
      episodeId: "ep",
      traceIds: ["t1", "t2"],
      members: [member({ id: "t1", value: 0.525, rHuman: 1 }), member({ id: "t2", value: 0.525, rHuman: 1 })],
    });
    expect(beyond.status).toBe("legacy_unscaled");
  });
});

describe("runGainInference (storage)", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  function run(overrides: Partial<Parameters<typeof runGainInference>[0]> = {}) {
    return runGainInference({
      db: handle.db,
      kv: handle.repos.kv,
      episodesRepo: handle.repos.episodes,
      tracesRepo: handle.repos.traces,
      owner: OWNER,
      ...overrides,
    });
  }

  it("uses S from trace_ids_json, leaving episode_id orphans unresolved and reported", () => {
    seedEpisode(handle, "ep1", ["t1", "t2"]);
    seedTrace(handle, "t1", "ep1", { value: 0.5, rHuman: 1 });
    seedTrace(handle, "t2", "ep1", { value: 0.5, rHuman: 1 });
    // Orphan: same episode_id, never listed in trace_ids_json.
    seedTrace(handle, "orphan", "ep1", { value: 0.9, rHuman: 1 });

    const report = run();
    expect(report.orphansOutsideS).toBe(1);
    expect(report.inferredNormalized.groups).toBe(1);

    const orphan = handle.repos.traces.getById("orphan" as never)!;
    expect(orphan.gainValueSource).toBeNull();
    expect(orphan.gainInferenceVersion).toBe(0);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBe("inferred_normalized");
    expect(t1.gainValue).toBeCloseTo(1, 12);
  });

  it("missing listed member forbids deriving N from a partial set", () => {
    seedEpisode(handle, "ep1", ["t1", "ghost"]);
    seedTrace(handle, "t1", "ep1", { value: 0.9, rHuman: 1 });

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
    expect(t1.gainValue).toBeNull();
    // Even unresolved attempts get the stamp so restarts do not rescan.
    expect(t1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
  });

  it("is idempotent: restart does not rescan stamped unresolved groups", () => {
    seedEpisode(handle, "ep1", ["t1", "ghost"]);
    seedTrace(handle, "t1", "ep1", { value: 0.9, rHuman: 1 });

    const first = run();
    expect(first.candidateGroups).toBe(1);
    const second = run();
    expect(second.candidateGroups).toBe(0);
    expect(second.stampedTraces).toBe(0);
  });

  it("handles empty/malformed sets without stamping", () => {
    seedEpisode(handle, "ep_empty", []);
    const report = run();
    expect(report.candidateGroups).toBe(0);
  });

  it("metadata traceIds mismatch leaves the group unresolved", () => {
    seedEpisode(handle, "ep1", ["t1", "t2"], {
      reward: { traceIds: ["t1", "t2", "stale"] },
    });
    seedTrace(handle, "t1", "ep1", { value: 0.5, rHuman: 1 });
    seedTrace(handle, "t2", "ep1", { value: 0.5, rHuman: 1 });

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
  });

  it("mixed ownership stays unresolved", () => {
    seedEpisode(handle, "ep1", ["t1"]);
    seedTrace(handle, "t1", "ep1", { value: 0.5, rHuman: 1, ownerAgentKind: "openclaw" });

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    expect(handle.repos.traces.getById("t1" as never)!.gainValueSource).toBeNull();
  });

  it("is workspace-exact: a tick never selects or stamps another workspace's episodes", () => {
    seedEpisode(handle, "ep_a", ["ta"], {}, "ws-a");
    seedTrace(handle, "ta", "ep_a", { value: 0.9, rHuman: 0.9, ownerWorkspaceId: "ws-a" });
    seedEpisode(handle, "ep_b", ["tb"], {}, "ws-b");
    seedTrace(handle, "tb", "ep_b", { value: 0.9, rHuman: 0.9, ownerWorkspaceId: "ws-b" });

    // A null-workspace tick selects neither namespaced group.
    const none = run();
    expect(none.candidateGroups).toBe(0);

    // A ws-a tick screens only its own group; ws-b rows stay untouched.
    const reportA = run({
      owner: { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: "ws-a" },
    });
    expect(reportA.candidateGroups).toBe(1);
    expect(reportA.inferredNormalized.groups).toBe(1);
    expect(handle.repos.traces.getById("ta" as never)!.gainInferenceVersion).toBe(
      GAIN_INFERENCE_VERSION,
    );
    const tb = handle.repos.traces.getById("tb" as never)!;
    expect(tb.gainInferenceVersion).toBe(0);
    expect(tb.gainValueSource).toBeNull();
    expect(tb.gainValue).toBeNull();

    // A ws-b tick then screens only its own group.
    const reportB = run({
      owner: { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: "ws-b" },
    });
    expect(reportB.candidateGroups).toBe(1);
    expect(handle.repos.traces.getById("tb" as never)!.gainInferenceVersion).toBe(
      GAIN_INFERENCE_VERSION,
    );
  });

  it("never overwrites live_normalized scores with historical inference", () => {
    // Episode A: already live-scored (gain persisted with live provenance).
    seedEpisode(handle, "ep_live", ["la"]);
    seedTrace(handle, "la", "ep_live", { value: 0.3, rHuman: 0.9 });
    handle.repos.traces.updateScore("la" as never, {
      value: 0.3,
      alpha: 1,
      rHuman: 0.9,
      priority: 0.2,
      gainValue: 0.6,
      gainValueSource: "live_normalized",
    });
    // Episode B: historical, unscreened.
    seedEpisode(handle, "ep_hist", ["hb"]);
    seedTrace(handle, "hb", "ep_hist", { value: 0.9, rHuman: 0.9 });

    const report = run();
    const live = handle.repos.traces.getById("la" as never)!;
    expect(live.gainValueSource).toBe("live_normalized");
    expect(live.gainValue).toBeCloseTo(0.6, 12);
    expect(live.gainInferenceVersion).toBe(0); // live scoring is not inference
    const hist = handle.repos.traces.getById("hb" as never)!;
    expect(hist.gainValueSource).toBe("inferred_normalized");
    expect(hist.gainValue).toBeCloseTo(0.9, 12);
    expect(report.inferredNormalized.groups).toBe(1);
  });

  it("revisits lower-stamp inferred rows on an inference-version bump", () => {
    seedEpisode(handle, "ep1", ["t1", "t2"]);
    seedTrace(handle, "t1", "ep1", { value: 0.5, rHuman: 1 });
    seedTrace(handle, "t2", "ep1", { value: 0.5, rHuman: 1 });

    run({ inferenceVersion: 1 });
    const before = handle.repos.traces.getById("t1" as never)!;
    expect(before.gainInferenceVersion).toBe(1);

    // Version 2 revisit: group re-screened and re-stamped at v2.
    const bumped = run({ inferenceVersion: 2 });
    expect(bumped.candidateGroups).toBe(1);
    expect(bumped.stampedTraces).toBe(2);
    const after = handle.repos.traces.getById("t1" as never)!;
    expect(after.gainInferenceVersion).toBe(2);
    // A third run at v2 is a no-op again.
    expect(run({ inferenceVersion: 2 }).candidateGroups).toBe(0);
  });

  it("reports legacy_unscaled groups by post-cutover chronology", () => {
    // Non-conserving group whose newest member is after the cutover.
    const afterCutover = GAIN_POST_CUTOVER_BOUNDARY_MS + 86_400_000;
    seedEpisode(handle, "ep_legacy", ["l1", "l2"]);
    seedTrace(handle, "l1", "ep_legacy", { value: 0.5, rHuman: 0.9, ts: afterCutover - 10_000 });
    seedTrace(handle, "l2", "ep_legacy", { value: 0.5, rHuman: 0.9, ts: afterCutover });

    const report = run();
    expect(report.legacyUnscaled.groups).toBe(1);
    expect(report.postCutoverLegacy.groups).toBe(1);
    expect(report.unknownChronology.groups).toBe(0);

    // Unknown timestamp (0) → unknown chronology, still legacy_unscaled.
    // Single member V=0.5 vs R=0.9: non-conserving with integrity → legacy.
    seedEpisode(handle, "ep_legacy2", ["m1"]);
    seedTrace(handle, "m1", "ep_legacy2", { value: 0.5, rHuman: 0.9, ts: 0 });
    const report2 = run();
    // Per-run report: run 1 already stamped ep_legacy, so this run only
    // screens ep_legacy2.
    expect(report2.legacyUnscaled.groups).toBe(1);
    expect(report2.unknownChronology.groups).toBe(1);
  });

  it("audit counts groups inferred without meta.reward.traceIds", () => {
    seedEpisode(handle, "ep1", ["t1"]);
    seedTrace(handle, "t1", "ep1", { value: 0.9, rHuman: 0.9 });
    const report = run();
    expect(report.inferredNormalized.groups).toBe(1);
    expect(report.auditMetaAbsent).toBe(1);
  });

  function setTraceIdsJsonRaw(eid: string, raw: string): void {
    // Bypass the episodes.json_valid CHECK so we can exercise the defensive
    // malformed-data paths the way a legacy/foreign writer could produce them.
    handle.db.raw.pragma("ignore_check_constraints = ON");
    try {
      handle.db
        .prepare<{ raw: string; id: string }>(`UPDATE episodes SET trace_ids_json = @raw WHERE id = @id`)
        .run({ raw, id: eid });
    } finally {
      handle.db.raw.pragma("ignore_check_constraints = OFF");
    }
  }

  it("malformed trace_ids_json never aborts the pass; members get unresolved attempt stamps", () => {
    seedEpisode(handle, "ep1", ["t1"]);
    seedTrace(handle, "t1", "ep1", { value: 0.5, rHuman: 0.9 });
    setTraceIdsJsonRaw("ep1", '{"broken');

    const report = run();
    expect(report.invalidJsonGroups).toBe(1);
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
    expect(t1.gainValue).toBeNull();
    expect(t1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    // Restart: stamped → no re-scan loop.
    expect(run().candidateGroups).toBe(0);
  });

  it("object/scalar trace_ids_json enters screening and is stamped unresolved, not skipped", () => {
    seedEpisode(handle, "ep_obj", ["t1"]);
    seedTrace(handle, "t1", "ep_obj", { value: 0.5, rHuman: 0.9 });
    setTraceIdsJsonRaw("ep_obj", '{"member": "t1"}');

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
    expect(t1.gainValue).toBeNull();
    expect(t1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    expect(run().candidateGroups).toBe(0);

    // Scalar shape behaves identically.
    seedEpisode(handle, "ep_scalar", ["s1"]);
    seedTrace(handle, "s1", "ep_scalar", { value: 0.5, rHuman: 0.9 });
    setTraceIdsJsonRaw("ep_scalar", '"s1"');
    const report2 = run();
    expect(report2.unresolved.groups).toBe(1);
    expect(handle.repos.traces.getById("s1" as never)!.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
  });

  it("object/scalar trace_ids_json whose values match NO member trace still enters screening (stamped, restart idempotent)", () => {
    // Values that do not match any member trace ID must NOT let the episode
    // fall between the array and non-array branches (json_array_length()
    // returns 0 for valid non-arrays — a length-based classifier would
    // wrongly route these to the array branch and skip them forever).
    seedEpisode(handle, "ep_obj", ["t1"]);
    seedTrace(handle, "t1", "ep_obj", { value: 0.5, rHuman: 0.9 });
    setTraceIdsJsonRaw("ep_obj", '{"member": "not_t1"}');

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
    expect(t1.gainValue).toBeNull();
    expect(t1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    // Restart: stamped → nothing selected again.
    expect(run().candidateGroups).toBe(0);

    // Scalar whose value matches no member id.
    seedEpisode(handle, "ep_scalar", ["s1"]);
    seedTrace(handle, "s1", "ep_scalar", { value: 0.5, rHuman: 0.9 });
    setTraceIdsJsonRaw("ep_scalar", '"not_s1"');
    const report2 = run();
    expect(report2.unresolved.groups).toBe(1);
    expect(handle.repos.traces.getById("s1" as never)!.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    expect(run().candidateGroups).toBe(0);
  });

  it("scalar meta.reward.traceIds stays unresolved with an attempt stamp — no numeric gain", () => {
    seedEpisode(handle, "ep1", ["t1"], { reward: { traceIds: "t1" } });
    seedTrace(handle, "t1", "ep1", { value: 0.9, rHuman: 0.9 });

    const report = run();
    expect(report.unresolved.groups).toBe(1);
    const t1 = handle.repos.traces.getById("t1" as never)!;
    expect(t1.gainValueSource).toBeNull();
    expect(t1.gainValue).toBeNull();
    expect(t1.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
  });

  it("oversized S stays within SQLite variable limits (chunked narrow reads)", () => {
    const N = 1200; // exceeds SQLite's 999-variable cap for a single IN clause
    const ids = Array.from({ length: N }, (_, i) => `big_${i}`);
    seedEpisode(handle, "ep_big", ids);
    for (const id of ids) {
      seedTrace(handle, id, "ep_big", { value: 0.9, rHuman: 0.9 });
    }

    const report = run();
    expect(report.candidateGroups).toBe(1);
    expect(report.legacyUnscaled.groups).toBe(1);
    expect(report.stampedTraces).toBe(N);
    const last = handle.repos.traces.getById(`big_${N - 1}` as never)!;
    expect(last.gainValueSource).toBe("legacy_unscaled");
    expect(last.gainValue).toBeCloseTo(0.9, 12);
    expect(last.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
  });

  it("caps per-boot groups and completes the backlog across simulated restarts without policy writes", () => {
    // 12 conserving groups (2 traces each → inferred_normalized, gain ≈ 1).
    for (let g = 0; g < 12; g++) {
      const eid = `ep_cap_${g}`;
      seedEpisode(handle, eid, [`t_cap_${g}_1`, `t_cap_${g}_2`]);
      seedTrace(handle, `t_cap_${g}_1`, eid, { value: 0.5, rHuman: 1 });
      seedTrace(handle, `t_cap_${g}_2`, eid, { value: 0.5, rHuman: 1 });
    }
    // A policy that the inference pass must never touch.
    handle.repos.policies.insert({
      id: "pol_cap",
      title: "t",
      trigger: "tr",
      procedure: "p",
      verification: "v",
      boundary: "b",
      support: 2,
      gain: 0.01,
      status: "candidate",
      sourceEpisodeIds: [],
      sourceTraceIds: [],
      inducedBy: "manual",
      decisionGuidance: { preference: [], antiPattern: [] },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    const policiesBefore = JSON.stringify(handle.repos.policies.list());

    // Each capped boot does bounded work and reports more backlog pending.
    const first = run({ maxGroups: 5 });
    expect(first.truncated).toBe(true);
    expect(first.candidateGroups).toBe(5);
    const second = run({ maxGroups: 5 });
    expect(second.truncated).toBe(true);
    expect(second.candidateGroups).toBe(5);
    const third = run({ maxGroups: 5 });
    expect(third.truncated).toBe(false);
    expect(third.candidateGroups).toBe(2);

    // The full backlog converted across restarts: every member stamped.
    expect(first.stampedTraces + second.stampedTraces + third.stampedTraces).toBe(24);
    for (let g = 0; g < 12; g++) {
      for (const tid of [`t_cap_${g}_1`, `t_cap_${g}_2`]) {
        const tr = handle.repos.traces.getById(tid as never)!;
        expect(tr.gainValueSource).toBe("inferred_normalized");
        expect(tr.gainValue).toBeCloseTo(1, 12);
        expect(tr.gainInferenceVersion).toBe(GAIN_INFERENCE_VERSION);
      }
    }
    // One more boot finds nothing — resume terminates.
    expect(run({ maxGroups: 5 }).candidateGroups).toBe(0);
    // No policy writes during any capped pass.
    expect(JSON.stringify(handle.repos.policies.list())).toBe(policiesBefore);
  });

  it("honours the wall-clock budget and resumes on the next call", () => {
    for (let g = 0; g < 3; g++) {
      const eid = `ep_bud_${g}`;
      seedEpisode(handle, eid, [`t_bud_${g}`]);
      seedTrace(handle, `t_bud_${g}`, eid, { value: 0.5, rHuman: 0.5 });
    }
    // Clock: pass start at t=1000, already past the 30s budget on first check.
    const times = [1000, 1000 + 60_000];
    let i = 0;
    const first = run({
      timeBudgetMs: 30_000,
      now: () => times[Math.min(i++, times.length - 1)]!,
    });
    expect(first.truncated).toBe(true);
    expect(first.candidateGroups).toBe(0);
    expect(first.stampedTraces).toBe(0);
    // Unbounded resume converts everything.
    const second = run();
    expect(second.truncated).toBe(false);
    expect(second.candidateGroups).toBe(3);
  });
});

describe("reconcileGainRepairQueue (durable startup seeding)", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  function seedPolicy(
    id: string,
    opts: { status?: string; sourceTraceIds?: string[]; archived?: boolean } = {},
  ): void {
    handle.repos.policies.insert({
      id: id as never,
      title: "t",
      trigger: "tr",
      procedure: "p",
      verification: "v",
      boundary: "b",
      support: 2,
      gain: 0.01,
      status: (opts.status ?? (opts.archived ? "archived" : "candidate")) as never,
      sourceEpisodeIds: [],
      sourceTraceIds: opts.sourceTraceIds ?? [],
      inducedBy: "manual",
      decisionGuidance: { preference: [], antiPattern: [] },
      createdAt: 1,
      updatedAt: 1,
    } as never);
  }

  function seedPolicySession(): void {
    handle.repos.sessions.upsert({
      id: "s1" as never,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
  }

  /** Stamp traces at the current inference version (stored state). */
  function stampInference(groups: Array<{ eid: string; traceIds: string[] }>) {
    for (const { eid, traceIds } of groups) {
      seedEpisode(handle, eid, traceIds);
      for (const tid of traceIds) {
        seedTrace(handle, tid, eid, { value: 0.5, rHuman: 1 });
      }
    }
    return runGainInference({
      db: handle.db,
      kv: handle.repos.kv,
      episodesRepo: handle.repos.episodes,
      tracesRepo: handle.repos.traces,
      owner: OWNER,
    });
  }

  function reconcile() {
    return reconcileGainRepairQueue({
      db: handle.db,
      kv: handle.repos.kv,
      gainRepair: handle.repos.gainRepair,
      tracesRepo: handle.repos.traces,
      owner: OWNER,
    });
  }

  it("derives the seed set from stored state for affected candidate/active policies, never archived", () => {
    seedPolicySession();
    const report = stampInference([{ eid: "ep1", traceIds: ["t1", "t2"] }]);
    expect(report.inferredNormalized.groups).toBe(1);
    seedPolicy("pol_active", { status: "active", sourceTraceIds: ["t1", "t2"] });
    seedPolicy("pol_candidate", { sourceTraceIds: ["t1"] });
    seedPolicy("pol_archived", { archived: true, sourceTraceIds: ["t1"] });
    seedPolicy("pol_unrelated", { sourceTraceIds: ["t9"] });

    const result = reconcile();
    expect(result.seeded).toBe(2);
    expect(result.reconciled).toBe(0);
    expect(result.alreadySeeded).toBe(false);

    const active = handle.repos.gainRepair.getByPolicy("pol_active" as never)!;
    expect(active.state).toBe("pending");
    expect(active.reason).toBe("inferred_evidence_updated");
    expect(active.inferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    const candidate = handle.repos.gainRepair.getByPolicy("pol_candidate" as never)!;
    expect(candidate.state).toBe("pending");
    // Archived policy is not a repair target.
    expect(handle.repos.gainRepair.getByPolicy("pol_archived" as never)).toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_unrelated" as never)).toBeNull();
  });

  it("malformed/non-array source_trace_ids_json never aborts reconciliation; bad rows are skipped", () => {
    seedPolicySession();
    const report = stampInference([{ eid: "ep1", traceIds: ["t1", "t2"] }]);
    expect(report.inferredNormalized.groups).toBe(1);
    seedPolicy("pol_good", { sourceTraceIds: ["t1", "t2"] });
    seedPolicy("pol_bad_malformed", { sourceTraceIds: ["t1"] });
    seedPolicy("pol_bad_object", { sourceTraceIds: ["t1"] });
    // Bypass the policies.json_valid CHECK the way a legacy/foreign writer
    // could — the guarded json_each must skip these rows, not throw.
    handle.db.raw.pragma("ignore_check_constraints = ON");
    try {
      const upd = handle.db.prepare<{ raw: string; id: string }>(
        `UPDATE policies SET source_trace_ids_json = @raw WHERE id = @id`,
      );
      upd.run({ raw: '{"broken', id: "pol_bad_malformed" });
      upd.run({ raw: '{"member": "t1"}', id: "pol_bad_object" });
    } finally {
      handle.db.raw.pragma("ignore_check_constraints = OFF");
    }

    const result = reconcile();
    expect(result.seeded).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("pol_good" as never)).not.toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_bad_malformed" as never)).toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_bad_object" as never)).toBeNull();
  });

  it("does not reseed once the watermark is current", () => {
    seedPolicySession();
    stampInference([{ eid: "ep1", traceIds: ["t1"] }]);
    seedPolicy("pol_ok", { sourceTraceIds: ["t1"] });

    const first = reconcile();
    expect(first.seeded).toBe(1);
    expect(first.alreadySeeded).toBe(false);

    const second = reconcile();
    expect(second.seeded).toBe(0);
    expect(second.alreadySeeded).toBe(true);
  });

  it("same-version newly stamped work is durably seeded after a crash before reconcile", () => {
    seedPolicySession();
    // 1. Complete inference + queue seed at v1.
    stampInference([{ eid: "ep1", traceIds: ["t1"] }]);
    seedPolicy("pol_first", { sourceTraceIds: ["t1"] });
    const firstSeed = reconcile();
    expect(firstSeed.seeded).toBe(1);
    expect(firstSeed.alreadySeeded).toBe(false);

    // 2. Add another unscreened group/policy.
    seedEpisode(handle, "ep2", ["t2"]);
    seedTrace(handle, "t2", "ep2", { value: 0.9, rHuman: 0.9 });
    seedPolicy("pol_second", { sourceTraceIds: ["t2"] });

    // 3. Run inference at v1 again: t2 is stamped at the SAME version, and
    //    the seed watermark is durably invalidated in the stamp transaction.
    const report = runGainInference({
      db: handle.db,
      kv: handle.repos.kv,
      episodesRepo: handle.repos.episodes,
      tracesRepo: handle.repos.traces,
      owner: OWNER,
    });
    expect(report.inferredNormalized.groups).toBe(1);
    expect(handle.repos.kv.get(GAIN_REPAIR_QUEUE_SEED_KEY, null)).toBeNull();

    // 4. Simulate a crash before queue reconciliation (reconcile never runs).
    // 5. Restart: reconcile recomputes from stored state → second policy seeded.
    const restart = reconcile();
    expect(restart.alreadySeeded).toBe(false);
    expect(restart.seeded).toBe(2); // pol_first re-derived (idempotent) + pol_second
    expect(handle.repos.gainRepair.getByPolicy("pol_first" as never)).not.toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_second" as never)).not.toBeNull();
    expect(handle.repos.kv.get(GAIN_REPAIR_QUEUE_SEED_KEY, null)).not.toBeNull();
  });

  it("a crash between inference commits and queue seeding is recovered on restart", () => {
    seedPolicySession();
    // "Crash": inference commits its trace stamps, seeding never runs.
    stampInference([{ eid: "ep1", traceIds: ["t1"] }]);
    seedPolicy("pol_ok", { sourceTraceIds: ["t1"] });

    // Restart: reconciliation recomputes the seed set from the database and
    // the affected policy is still seeded — no permanently omitted work.
    const result = reconcile();
    expect(result.seeded).toBe(1);
    expect(result.alreadySeeded).toBe(false);
    expect(handle.repos.gainRepair.getByPolicy("pol_ok" as never)).not.toBeNull();
  });

  it("a failed seeding attempt rolls back and is retried on the next restart", () => {
    seedPolicySession();
    stampInference([{ eid: "ep1", traceIds: ["t1"] }]);
    seedPolicy("pol_ok", { sourceTraceIds: ["t1"] });

    // Seeding attempt 1 fails mid-transaction (queue write error). The whole
    // reconcile rolls back — including the watermark.
    const failingRepo = {
      ...handle.repos.gainRepair,
      upsertPending: () => {
        throw new Error("queue write failed");
      },
    };
    expect(() =>
      reconcileGainRepairQueue({
        db: handle.db,
        kv: handle.repos.kv,
        gainRepair: failingRepo as never,
        tracesRepo: handle.repos.traces,
        owner: OWNER,
      }),
    ).toThrow(/queue write failed/);
    expect(handle.repos.kv.get(GAIN_REPAIR_QUEUE_SEED_KEY, null)).toBeNull();

    // Restart with a healthy repo: affected policies are still seeded.
    const result = reconcile();
    expect(result.seeded).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("pol_ok" as never)).not.toBeNull();
  });

  it("reconciles away queue entries whose policy is archived or deleted", () => {
    seedPolicySession();
    stampInference([{ eid: "ep1", traceIds: ["t1"] }]);
    seedPolicy("pol_ok", { sourceTraceIds: ["t1"] });
    seedPolicy("pol_archived", { archived: true });
    seedPolicy("pol_gone", {});
    for (const pid of ["pol_ok", "pol_archived", "pol_gone"]) {
      handle.repos.gainRepair.upsertPending({
        policyId: pid as never,
        ownerAgentKind: "unknown",
        ownerProfileId: "default",
      });
    }
    // pol_gone is deleted outright (FK cascade drops its queue row).
    handle.repos.policies.deleteById("pol_gone" as never);

    const result = reconcile();
    expect(result.seeded).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(handle.repos.gainRepair.getByPolicy("pol_ok" as never)).not.toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_archived" as never)).toBeNull();
    expect(handle.repos.gainRepair.getByPolicy("pol_gone" as never)).toBeNull();
  });

  it("no stamped traces → no seeding, but reconciliation still runs and marks seeded", () => {
    seedPolicySession();
    seedPolicy("pol_archived", { archived: true });
    handle.repos.gainRepair.upsertPending({
      policyId: "pol_archived" as never,
      ownerAgentKind: "unknown",
      ownerProfileId: "default",
    });
    const result = reconcile();
    expect(result.seeded).toBe(0);
    expect(result.reconciled).toBe(1);
    expect(result.alreadySeeded).toBe(false);
    // A second reconcile is a no-op.
    expect(reconcile().alreadySeeded).toBe(true);
  });
});
