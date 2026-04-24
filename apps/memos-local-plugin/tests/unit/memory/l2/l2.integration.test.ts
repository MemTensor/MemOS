/**
 * End-to-end integration for `core/memory/l2/l2.ts`.
 *
 * Scenario mirrors V7 §2.4.5 example 1 (container + pip):
 *   - episode A: Alpine / lxml → xmlsec1 missing  → V=+0.8
 *   - episode B: Debian / psycopg2 → pg_config    → V=+0.9
 *  Same primary tag (pip/docker) and same errCode (EXIT_1 here) but
 *  different tools. Expected: both traces land in a single candidate bucket;
 *  after the second episode the bucket clears `minEpisodesForInduction` and
 *  the mocked LLM mints a new `candidate` policy.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createL2EventBus,
  runL2,
  type L2Config,
  type L2Event,
} from "../../../../core/memory/l2/index.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type {
  EmbeddingVector,
  EpisodeId,
  SessionId,
  TraceRow,
} from "../../../../core/types.js";
import { fakeLlm } from "../../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import { ensureEpisode, toolCalls as tc, type PartialToolCall } from "./_helpers.js";

const NOW = 1_700_000_000_000;

function cfg(): L2Config {
  return {
    minSimilarity: 0.8,
    candidateTtlDays: 30,
    gamma: 0.9,
    tauSoftmax: 0.4,
    useLlm: true,
    minTraceValue: 0.1,
    minEpisodesForInduction: 2,
    inductionTraceCharCap: 2_000,
  };
}

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

type TraceOverrides = Omit<Partial<TraceRow>, "toolCalls"> & {
  id: string;
  episodeId: string;
  toolCalls?: readonly PartialToolCall[];
};

function mkTrace(partial: TraceOverrides): TraceRow {
  return {
    id: partial.id as TraceRow["id"],
    episodeId: partial.episodeId as TraceRow["episodeId"],
    sessionId: "s_int" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ? tc(partial.toolCalls) : [],
    reflection: partial.reflection ?? null,
    value: partial.value ?? 0.8,
    alpha: (partial.alpha ?? 0.5) as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: partial.tags ?? [],
    vecSummary: partial.vecSummary ?? null,
    vecAction: partial.vecAction ?? null,
    schemaVersion: 1,
  };
}

describe("memory/l2/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("adds candidates on episode A, induces new policy on episode B", async () => {
    ensureEpisode(handle, "ep_A", "s_int");
    ensureEpisode(handle, "ep_B", "s_int");
    ensureEpisode(handle, "ep_C", "s_int");
    // ── Episode A: Alpine + lxml, no existing L2 → ends up in candidate pool
    const trA = mkTrace({
      id: "tr_a",
      episodeId: "ep_A",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "lxml" }, output: "Error: MODULE_NOT_FOUND xmlsec1" },
      ],
      reflection: "alpine missing system lib",
      value: 0.8,
      alpha: 0.6 as TraceRow["alpha"],
      vecSummary: vec([1, 0, 0]),
    });
    handle.repos.traces.insert(trA);

    const bus = createL2EventBus();
    const events: L2Event[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": {
          title: "install missing system libs in container",
          trigger: "pip install fails in container with MODULE_NOT_FOUND due to missing system lib",
          procedure: "1. detect lib 2. use distro pkg manager 3. retry pip",
          verification: "pip install succeeds",
          boundary: "native systems with dev libs present",
          rationale: "container images don't ship dev libs",
          caveats: ["alpine uses musl libc"],
          confidence: 0.78,
        },
      },
    });

    const depsA = {
      db: handle.db,
      repos: handle.repos,
      llm,
      log: rootLogger.child({ channel: "core.memory.l2" }),
      bus,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    };

    const runA = await runL2(
      {
        episodeId: "ep_A" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trA],
        trigger: "manual",
      },
      depsA,
    );
    expect(runA.inductions).toHaveLength(0);
    expect(runA.associations[0].matchedPolicyId).toBeNull();
    expect(runA.associations[0].addedToCandidatePool).toBe(true);
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(true);

    // ── Episode B: Debian + psycopg2, same primary tag + errCode
    const trB = mkTrace({
      id: "tr_b",
      episodeId: "ep_B",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "psycopg2" }, output: "Error: MODULE_NOT_FOUND pg_config" },
      ],
      reflection: "debian missing pg dev lib",
      value: 0.9,
      alpha: 0.5 as TraceRow["alpha"],
      vecSummary: vec([0.98, 0.2, 0]),
    });
    handle.repos.traces.insert(trB);

    const runB = await runL2(
      {
        episodeId: "ep_B" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trB],
        trigger: "manual",
      },
      depsA,
    );
    expect(runB.inductions).toHaveLength(1);
    const induced = runB.inductions[0];
    expect(induced.policyId).not.toBeNull();
    expect(induced.skippedReason).toBeNull();
    expect(induced.episodeIds.sort()).toEqual(["ep_A", "ep_B"]);
    expect(
      events.some((e) => e.kind === "l2.policy.induced" && e.policyId === induced.policyId),
    ).toBe(true);

    // ── Policy exists and candidate-pool rows were promoted
    const persisted = handle.repos.policies.getById(induced.policyId!)!;
    expect(persisted.status).toBe("candidate");
    expect(persisted.sourceEpisodeIds.sort()).toEqual(["ep_A", "ep_B"]);

    // ── A third run with a trace that cosine-matches the new policy should
    //    associate (not re-induce) and bump gain/support.
    const trC = mkTrace({
      id: "tr_c",
      episodeId: "ep_C",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "Pillow" }, output: "Error: MODULE_NOT_FOUND jpeg" },
      ],
      value: 0.85,
      vecSummary: persisted.vec, // re-use policy vector so it *always* matches
    });
    handle.repos.traces.insert(trC);

    const runC = await runL2(
      {
        episodeId: "ep_C" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trC],
        trigger: "manual",
      },
      depsA,
    );
    expect(runC.associations[0].matchedPolicyId).toBe(induced.policyId);
    const afterC = handle.repos.policies.getById(induced.policyId!)!;
    expect(afterC.support).toBeGreaterThan(0);
  });

  it("minEpisodesForInduction=3 suppresses induction until a third episode arrives", async () => {
    const cfg3 = { ...cfg(), minEpisodesForInduction: 3 };
    const bus = createL2EventBus();
    const events: L2Event[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": {
          title: "t",
          trigger: "tr",
          procedure: "pr",
          verification: "v",
          boundary: "b",
          rationale: "why",
          caveats: [],
          confidence: 0.5,
        },
      },
    });
    const deps = {
      db: handle.db,
      repos: handle.repos,
      llm,
      log: rootLogger.child({ channel: "core.memory.l2" }),
      bus,
      config: cfg3,
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    };

    const mk = (i: number, ep: string) => {
      ensureEpisode(handle, ep, "s_int");
      const t = mkTrace({
        id: `tr_${i}`,
        episodeId: ep,
        tags: ["docker", "pip"],
        toolCalls: [
          { name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND x" },
        ],
        value: 0.8,
        vecSummary: vec([1, 0, 0]),
      });
      handle.repos.traces.insert(t);
      return t;
    };
    const t1 = mk(1, "ep_1");
    const t2 = mk(2, "ep_2");
    for (const t of [t1, t2]) {
      await runL2(
        {
          episodeId: t.episodeId,
          sessionId: t.sessionId,
          traces: [t],
          trigger: "manual",
        },
        deps,
      );
    }
    expect(events.filter((e) => e.kind === "l2.policy.induced")).toHaveLength(0);

    const t3 = mk(3, "ep_3");
    const r3 = await runL2(
      {
        episodeId: t3.episodeId,
        sessionId: t3.sessionId,
        traces: [t3],
        trigger: "manual",
      },
      deps,
    );
    expect(r3.inductions.some((i) => i.policyId !== null)).toBe(true);
  });
});
