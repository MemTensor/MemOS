/**
 * End-to-end integration for `core/memory/l3/l3.ts` against a real SQLite DB.
 *
 * Scenarios mirror V7 §2.4.1 "environment world model" examples:
 *
 *   1. Three Alpine/pip policies + evidence traces → one new WM is created.
 *   2. A second run with compatible policies + same domain merges into the
 *      existing WM instead of creating a new one.
 *   3. LLM disabled → every cluster is skipped with llm_disabled.
 *   4. Confidence adjustment via `adjustConfidence` bumps / demotes the WM.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  adjustConfidence,
  createL3EventBus,
  runL3,
  type L3Config,
  type L3Event,
} from "../../../../core/memory/l3/index.js";
import { L3_ABSTRACTION_PROMPT } from "../../../../core/llm/prompts/l3-abstraction.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type {
  EpisodeId,
  PolicyId,
  WorldModelId,
} from "../../../../core/types.js";
import { fakeLlm } from "../../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import {
  NOW,
  seedPolicy,
  seedTrace,
  seedWorldModel,
  vec,
} from "./_helpers.js";

const OP = `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`;
const log = rootLogger.child({ channel: "core.memory.l3" });

function cfg(overrides: Partial<L3Config> = {}): L3Config {
  return {
    minPolicies: 3,
    minPolicyGain: 0.1,
    minPolicySupport: 2,
    clusterMinSimilarity: 0.6,
    policyCharCap: 800,
    traceCharCap: 500,
    traceEvidencePerPolicy: 1,
    useLlm: true,
    cooldownDays: 0,
    confidenceDelta: 0.1,
    minConfidenceForRetrieval: 0.2,
    ...overrides,
  };
}

describe("memory/l3/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  function seedTriplet(extraEpId = "ep_c") {
    const p1 = seedPolicy(handle, {
      id: "po_1" as PolicyId,
      title: "apk add missing system libs before pip install",
      trigger: "pip install fails for lxml in Alpine",
      procedure: "apk add libxml2-dev libxslt-dev && pip install",
      sourceEpisodeIds: ["ep_a" as EpisodeId],
      vec: vec([1, 0, 0]),
    });
    const p2 = seedPolicy(handle, {
      id: "po_2" as PolicyId,
      title: "apk add then pip install for musl wheels",
      trigger: "pip install fails for pycrypto wheel on Alpine",
      procedure: "apk add openssl-dev && pip install",
      sourceEpisodeIds: ["ep_b" as EpisodeId],
      vec: vec([0.95, 0.05, 0]),
    });
    const p3 = seedPolicy(handle, {
      id: "po_3" as PolicyId,
      title: "force source build for pip in Alpine",
      trigger: "pip install wheel fails because musl",
      procedure: "pip install --no-binary :all: && apk add",
      sourceEpisodeIds: [extraEpId as EpisodeId],
      vec: vec([0.9, 0.1, 0]),
    });
    seedTrace(handle, { id: "tr_1", episodeId: "ep_a", tags: ["docker", "alpine", "pip"] });
    seedTrace(handle, { id: "tr_2", episodeId: "ep_b", tags: ["docker", "alpine", "pip"] });
    seedTrace(handle, { id: "tr_3", episodeId: extraEpId, tags: ["docker", "alpine", "pip"] });
    return { p1, p2, p3 };
  }

  it("creates a world model for a fresh cluster", async () => {
    seedTriplet();

    const bus = createL3EventBus();
    const events: L3Event[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "Alpine python dependency model",
          domain_tags: ["docker", "alpine", "pip"],
          environment: [{ label: "musl libc", description: "no glibc" }],
          inference: [
            { label: "binary wheels fail", description: "must compile from source" },
          ],
          constraints: [
            { label: "no --prebuilt", description: "avoid binary wheels" },
          ],
          body: "# summary",
          confidence: 0.75,
          supersedes_world_ids: [],
        },
      },
    });

    const result = await runL3(
      { trigger: "l2.policy.induced" },
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        llm,
        log,
        bus,
        config: cfg(),
      },
    );

    expect(result.abstractions.length).toBe(1);
    expect(result.abstractions[0]!.skippedReason).toBeNull();
    expect(result.abstractions[0]!.createdNew).toBe(true);

    const rows = handle.repos.worldModel.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("Alpine python dependency model");
    expect(rows[0]!.domainTags).toEqual(expect.arrayContaining(["docker", "alpine", "pip"]));
    expect(rows[0]!.structure.environment.length).toBeGreaterThan(0);
    expect(rows[0]!.confidence).toBeCloseTo(0.75, 5);
    expect(rows[0]!.policyIds.map(String).sort()).toEqual(["po_1", "po_2", "po_3"]);

    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["l3.abstraction.started", "l3.world-model.created"]),
    );
  });

  it("merges into an existing WM that covers the same domain", async () => {
    seedTriplet();
    // Seed a prior WM that shares domain tags + vector, so merge kicks in.
    seedWorldModel(handle, {
      id: "wm_prior" as WorldModelId,
      title: "prior alpine model",
      domainTags: ["docker", "alpine"],
      confidence: 0.5,
      vec: vec([0.95, 0.05, 0]),
      structure: {
        environment: [{ label: "shared libs", description: "musl-only" }],
        inference: [],
        constraints: [],
      },
    });

    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "refreshed alpine model",
          domain_tags: ["docker", "alpine", "pip"],
          environment: [
            { label: "new note", description: "alpine uses apk" },
          ],
          inference: [],
          constraints: [],
          body: "# refreshed",
          confidence: 0.8,
          supersedes_world_ids: [],
        },
      },
    });

    const result = await runL3(
      { trigger: "manual" },
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        llm,
        log,
        config: cfg(),
      },
    );
    expect(result.abstractions.length).toBe(1);
    expect(result.abstractions[0]!.skippedReason).toBeNull();
    expect(result.abstractions[0]!.createdNew).toBe(false);
    expect(String(result.abstractions[0]!.mergedIntoWorldId)).toBe("wm_prior");

    const after = handle.repos.worldModel.getById("wm_prior" as WorldModelId)!;
    expect(after.title).toBe("refreshed alpine model");
    // structure entries from both runs survive (merge unions)
    const envLabels = after.structure.environment.map((e) => e.label);
    expect(envLabels).toEqual(expect.arrayContaining(["shared libs", "new note"]));
    // confidence was bumped by `confidenceDelta`
    expect(after.confidence).toBeCloseTo(0.6, 5);

    // A second WM was NOT created.
    expect(handle.repos.worldModel.list().length).toBe(1);
  });

  it("skips every cluster when LLM is disabled", async () => {
    seedTriplet();
    const res = await runL3(
      { trigger: "manual" },
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        llm: null,
        log,
        config: cfg({ useLlm: false }),
      },
    );
    expect(res.abstractions.every((a) => a.skippedReason === "llm_disabled")).toBe(true);
    expect(handle.repos.worldModel.list().length).toBe(0);
  });

  it("skips the '_|_' untagged cluster before calling the LLM (issue #2374)", async () => {
    // Seed three policies whose text matches none of the domain regexes,
    // so they all land in the "_|_" bucket. Historically this cluster
    // was passed to `abstractDraft` and the LLM's empty `title` tripped
    // the validator, producing 100% `llm_failed`. The fix pre-filters
    // `_|_` clusters in `runL3` so no LLM call happens.
    seedPolicy(handle, {
      id: "po_u1" as PolicyId,
      title: "abstract planning heuristic",
      trigger: "when tasks become complex",
      procedure: "decompose into subgoals then evaluate",
      verification: "outcome satisfies goal",
      boundary: "general reasoning tasks",
      sourceEpisodeIds: ["ep_u1" as EpisodeId],
      vec: vec([1, 0, 0]),
    });
    seedPolicy(handle, {
      id: "po_u2" as PolicyId,
      title: "reflect on past decisions",
      trigger: "at episode boundary",
      procedure: "summarise and store lessons",
      verification: "reflection recorded",
      boundary: "reflection stage",
      sourceEpisodeIds: ["ep_u2" as EpisodeId],
      vec: vec([0.95, 0.05, 0]),
    });
    seedPolicy(handle, {
      id: "po_u3" as PolicyId,
      title: "prioritise information intake",
      trigger: "before starting a session",
      procedure: "review recent context and open questions",
      verification: "context reviewed",
      boundary: "session prelude",
      sourceEpisodeIds: ["ep_u3" as EpisodeId],
      vec: vec([0.9, 0.1, 0]),
    });

    const bus = createL3EventBus();
    const events: L3Event[] = [];
    bus.onAny((e) => events.push(e));

    let llmCalls = 0;
    const llm = fakeLlm({
      completeJson: {
        [OP]: () => {
          llmCalls += 1;
          // If this ever fires, `runL3` failed to pre-filter the bucket.
          return {
            title: "should not be called",
            domain_tags: [],
            environment: [],
            inference: [],
            constraints: [],
            body: "",
            confidence: 0.5,
            supersedes_world_ids: [],
          };
        },
      },
    });

    const result = await runL3(
      { trigger: "l2.policy.induced" },
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        llm,
        log,
        bus,
        config: cfg(),
      },
    );

    expect(result.abstractions.length).toBe(1);
    expect(result.abstractions[0]!.clusterKey).toBe("_|_");
    expect(result.abstractions[0]!.skippedReason).toBe("untagged_cluster");
    expect(result.abstractions[0]!.worldModelId).toBeNull();
    expect(result.abstractions[0]!.policyCount).toBe(3);

    // No LLM call — the pre-filter runs before `abstractDraft`.
    expect(llmCalls).toBe(0);

    // No WM row was created.
    expect(handle.repos.worldModel.list().length).toBe(0);

    // No `l3.failed` event — the skip is not a failure.
    expect(events.some((e) => e.kind === "l3.failed")).toBe(false);
  });

  it("still processes tagged clusters when mixed with an untagged bucket (issue #2374)", async () => {
    // Tagged docker+alpine+pip triplet — should still produce a WM.
    seedTriplet();

    // Additional three untagged policies that would otherwise form a
    // second (broken) cluster. Only the tagged one should survive.
    seedPolicy(handle, {
      id: "po_u1" as PolicyId,
      title: "abstract planning heuristic",
      trigger: "when tasks become complex",
      procedure: "decompose into subgoals then evaluate",
      verification: "outcome satisfies goal",
      boundary: "general reasoning tasks",
      sourceEpisodeIds: ["ep_u1" as EpisodeId],
      vec: vec([1, 0, 0]),
    });
    seedPolicy(handle, {
      id: "po_u2" as PolicyId,
      title: "reflect on past decisions",
      trigger: "at episode boundary",
      procedure: "summarise and store lessons",
      verification: "reflection recorded",
      boundary: "reflection stage",
      sourceEpisodeIds: ["ep_u2" as EpisodeId],
      vec: vec([0.95, 0.05, 0]),
    });
    seedPolicy(handle, {
      id: "po_u3" as PolicyId,
      title: "prioritise information intake",
      trigger: "before starting a session",
      procedure: "review recent context and open questions",
      verification: "context reviewed",
      boundary: "session prelude",
      sourceEpisodeIds: ["ep_u3" as EpisodeId],
      vec: vec([0.9, 0.1, 0]),
    });

    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "Alpine python dependency model",
          domain_tags: ["docker", "alpine", "pip"],
          environment: [{ label: "musl", description: "no glibc" }],
          inference: [{ label: "wheels fail", description: "must build from source" }],
          constraints: [{ label: "no prebuilt", description: "avoid binary" }],
          body: "# summary",
          confidence: 0.75,
          supersedes_world_ids: [],
        },
      },
    });

    const result = await runL3(
      { trigger: "l2.policy.induced" },
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        llm,
        log,
        config: cfg(),
      },
    );

    // Two clusters seen: one untagged (skipped), one tagged (created).
    const byKey = new Map(result.abstractions.map((a) => [a.clusterKey, a]));
    expect(byKey.get("_|_")?.skippedReason).toBe("untagged_cluster");
    const taggedEntry = Array.from(byKey.values()).find(
      (a) => a.clusterKey !== "_|_",
    );
    expect(taggedEntry?.skippedReason).toBeNull();
    expect(taggedEntry?.createdNew).toBe(true);

    // Only the tagged WM was inserted.
    const rows = handle.repos.worldModel.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("Alpine python dependency model");
  });

  it("adjustConfidence clamps in [0,1] and emits an event", async () => {
    const wm = seedWorldModel(handle, { id: "wm_adj" as WorldModelId, confidence: 0.9 });
    const bus = createL3EventBus();
    const events: L3Event[] = [];
    bus.onAny((e) => events.push(e));

    const up = adjustConfidence(
      wm.id,
      "positive",
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        log,
        bus,
        config: cfg({ confidenceDelta: 0.2 }),
      },
      NOW,
    )!;
    expect(up.next).toBeCloseTo(1, 5);

    const down = adjustConfidence(
      wm.id,
      "negative",
      {
        repos: {
          policies: handle.repos.policies,
          traces: handle.repos.traces,
          worldModel: handle.repos.worldModel,
          kv: handle.repos.kv,
        },
        log,
        bus,
        config: cfg({ confidenceDelta: 0.3 }),
      },
      NOW,
    )!;
    expect(down.next).toBeCloseTo(0.7, 5);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["l3.confidence.adjusted"]),
    );
  });
});
