/**
 * Unit tests for `attachL3Subscriber`:
 *   - listens to `l2.policy.induced` and invokes runL3
 *   - runOnce() works with no L2 signal
 *   - adjustFeedback bumps/lowers confidence through the subscriber
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachL3Subscriber } from "../../../../core/memory/l3/index.js";
import { createL2EventBus } from "../../../../core/memory/l2/index.js";
import { createL3EventBus } from "../../../../core/memory/l3/index.js";
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

function fakeL3Llm(): ReturnType<typeof fakeLlm> {
  return fakeLlm({
    completeJson: {
      [OP]: {
        title: "Alpine / pip model",
        domain_tags: ["docker", "alpine"],
        environment: [{ label: "musl", description: "no glibc" }],
        inference: [],
        constraints: [],
        body: "# summary",
        confidence: 0.7,
        supersedes_world_ids: [],
      },
    },
  });
}

function baseConfig() {
  return {
    minPolicies: 3,
    minPolicyGain: 0.1,
    minPolicySupport: 2,
    clusterMinSimilarity: 0.6,
    policyCharCap: 400,
    traceCharCap: 300,
    traceEvidencePerPolicy: 1,
    useLlm: true,
    cooldownDays: 0,
    confidenceDelta: 0.1,
    minConfidenceForRetrieval: 0.2,
  };
}

describe("memory/l3/subscriber", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  function seedFresh() {
    seedPolicy(handle, {
      id: "po_1" as PolicyId,
      title: "apk add then pip install",
      trigger: "pip fails on alpine",
      procedure: "apk add -t pip install",
      sourceEpisodeIds: ["ep_a" as EpisodeId],
      vec: vec([1, 0, 0]),
    });
    seedPolicy(handle, {
      id: "po_2" as PolicyId,
      title: "build from source on alpine",
      trigger: "pip install lxml fails",
      procedure: "apk add libxml2-dev; pip install",
      sourceEpisodeIds: ["ep_b" as EpisodeId],
      vec: vec([0.95, 0.05, 0]),
    });
    seedPolicy(handle, {
      id: "po_3" as PolicyId,
      title: "no-binary for alpine",
      trigger: "pip alpine issue",
      procedure: "pip install --no-binary",
      sourceEpisodeIds: ["ep_c" as EpisodeId],
      vec: vec([0.9, 0.1, 0]),
    });
    seedTrace(handle, { id: "tr_1", episodeId: "ep_a", tags: ["docker", "alpine", "pip"] });
    seedTrace(handle, { id: "tr_2", episodeId: "ep_b", tags: ["docker", "alpine", "pip"] });
    seedTrace(handle, { id: "tr_3", episodeId: "ep_c", tags: ["docker", "alpine", "pip"] });
  }

  it("runs L3 when an l2.policy.induced event arrives", async () => {
    seedFresh();

    const l2Bus = createL2EventBus();
    const l3Bus = createL3EventBus();
    const handleSub = attachL3Subscriber({
      repos: {
        policies: handle.repos.policies,
        traces: handle.repos.traces,
        worldModel: handle.repos.worldModel,
        kv: handle.repos.kv,
      },
      l2Bus,
      l3Bus,
      llm: fakeL3Llm(),
      log: rootLogger,
      config: baseConfig(),
    });

    const seen: string[] = [];
    l3Bus.onAny((e) => seen.push(e.kind));

    l2Bus.emit({
      kind: "l2.policy.induced",
      episodeId: "ep_a" as EpisodeId,
      policyId: "po_new" as PolicyId,
      signature: "docker|alpine|pip.install|_",
      evidenceTraceIds: ["tr_1", "tr_2"],
      evidenceEpisodeIds: ["ep_a" as EpisodeId, "ep_b" as EpisodeId],
      title: "new pol",
    });

    // Wait one microtask cycle for the fire-and-forget triggerRun.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(seen).toContain("l3.abstraction.started");
    expect(seen).toContain("l3.world-model.created");
    expect(handle.repos.worldModel.list().length).toBe(1);

    handleSub.detach();
  });

  it("runOnce() kicks off a run without any event", async () => {
    seedFresh();

    const l2Bus = createL2EventBus();
    const l3Bus = createL3EventBus();
    const sub = attachL3Subscriber({
      repos: {
        policies: handle.repos.policies,
        traces: handle.repos.traces,
        worldModel: handle.repos.worldModel,
        kv: handle.repos.kv,
      },
      l2Bus,
      l3Bus,
      llm: fakeL3Llm(),
      log: rootLogger,
      config: baseConfig(),
    });

    const result = await sub.runOnce({ trigger: "rebuild" });
    expect(result.trigger).toBe("rebuild");
    expect(result.abstractions.length).toBe(1);
    expect(result.abstractions[0]!.createdNew).toBe(true);

    sub.detach();
  });

  it("adjustFeedback bumps / lowers confidence", async () => {
    const seeded = seedWorldModel(handle, {
      id: "wm_fb" as WorldModelId,
      confidence: 0.5,
    });
    const l2Bus = createL2EventBus();
    const l3Bus = createL3EventBus();
    const sub = attachL3Subscriber({
      repos: {
        policies: handle.repos.policies,
        traces: handle.repos.traces,
        worldModel: handle.repos.worldModel,
        kv: handle.repos.kv,
      },
      l2Bus,
      l3Bus,
      llm: null,
      log: rootLogger,
      config: { ...baseConfig(), confidenceDelta: 0.2 },
    });

    const up = await sub.adjustFeedback(seeded.id, "positive");
    expect(up?.next).toBeCloseTo(0.7, 5);

    const down = await sub.adjustFeedback(seeded.id, "negative");
    expect(down?.next).toBeCloseTo(0.5, 5);

    const down2 = await sub.adjustFeedback(seeded.id, "negative");
    expect(down2?.next).toBeCloseTo(0.3, 5);

    sub.detach();
  });

  it("returns null from adjustFeedback for unknown world model", async () => {
    const l2Bus = createL2EventBus();
    const l3Bus = createL3EventBus();
    const sub = attachL3Subscriber({
      repos: {
        policies: handle.repos.policies,
        traces: handle.repos.traces,
        worldModel: handle.repos.worldModel,
        kv: handle.repos.kv,
      },
      l2Bus,
      l3Bus,
      llm: null,
      log: rootLogger,
      config: baseConfig(),
    });

    const out = await sub.adjustFeedback("wm_missing" as WorldModelId, "positive");
    expect(out).toBeNull();

    sub.detach();
  });
});
