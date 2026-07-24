import { describe, it, expect, afterEach, vi } from "vitest";

import { createL2EventBus } from "../../../core/memory/l2/events.js";
import { createRewardEventBus } from "../../../core/reward/events.js";
import {
  attachSkillSubscriber,
  createSkillEventBus,
} from "../../../core/skill/index.js";
import { rootLogger } from "../../../core/logger/index.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { EpisodeId, PolicyId, PolicyRow, TraceId } from "../../../core/types.js";
import type { PatternSignature } from "../../../core/memory/l2/types.js";
import {
  makeDraft,
  makeSkillConfig,
  seedPolicy,
  seedSessionOnly,
  seedTrace,
} from "./_helpers.js";

let handle: TmpDbHandle | null = null;
afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function seedTracesForPolicy(h: TmpDbHandle, id: PolicyId) {
  const sessionId = `s-${id}`;
  const episodeId = `ep-${id}` as EpisodeId;
  seedSessionOnly(h, sessionId);
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    userText: "pip install cryptography failing on alpine",
    agentText:
      "1. detect missing lib from pip error. 2. apk add openssl-dev libffi-dev. 3. retry pip install cryptography",
    reflection: "install system libs before pip on alpine",
    value: 0.9,
  });
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    userText: "retry pip install",
    agentText: "apk add then retry pip install cryptography succeeds",
    value: 0.8,
  });
  return { episodeId };
}

describe("skill/subscriber", () => {
  it("triggers runSkill on l2.policy.induced", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();

    const { episodeId } = seedTracesForPolicy(h, "po_sub" as PolicyId);
    const policy = seedPolicy(h, {
      id: "po_sub" as PolicyId,
      sourceEpisodeIds: [episodeId],
    });

    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({ completeJson: { "skill.crystallize": makeDraft() } }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0 }),
    });

    l2Bus.emit({
      kind: "l2.policy.induced",
      episodeId: episodeId,
      policyId: policy.id,
      signature: "pip|alpine|pip.install|MODULE_NOT_FOUND" as PatternSignature,
      evidenceTraceIds: [] as TraceId[],
      evidenceEpisodeIds: [episodeId],
      title: "alpine pip",
    });

    // Wait a tick for debounced run
    await new Promise((r) => setTimeout(r, 20));
    await sub.flush();

    const skills = h.repos.skills.list();
    expect(skills.length).toBe(1);
    sub.dispose();
  });

  it("ignores l2.policy.updated unless status is active", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();
    const spy = vi.fn();
    bus.onAny(spy);

    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: null,
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0 }),
    });

    l2Bus.emit({
      kind: "l2.policy.updated",
      episodeId: "ep_zzz" as EpisodeId,
      policyId: "po_zzz" as PolicyId,
      status: "candidate" as PolicyRow["status"],
      support: 2,
      gain: 0.1,
    });
    await new Promise((r) => setTimeout(r, 20));
    await sub.flush();
    expect(spy).not.toHaveBeenCalled();
    sub.dispose();
  });

  it("runOnce reuses the scheduler state", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();

    const { episodeId } = seedTracesForPolicy(h, "po_once" as PolicyId);
    const policy = seedPolicy(h, {
      id: "po_once" as PolicyId,
      sourceEpisodeIds: [episodeId],
    });

    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({ completeJson: { "skill.crystallize": makeDraft() } }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0 }),
    });

    const r = await sub.runOnce({ trigger: "manual", policyId: policy.id });
    expect(r.crystallized).toBe(1);
    sub.dispose();
  });

  it("serializes manual and event-driven crystallization for one policy", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();
    const { episodeId } = seedTracesForPolicy(
      h,
      "po_singleflight" as PolicyId,
    );
    const policy = seedPolicy(h, {
      id: "po_singleflight" as PolicyId,
      sourceEpisodeIds: [episodeId],
    });
    let crystallizeCalls = 0;
    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({
        completeJson: {
          "skill.crystallize": async () => {
            crystallizeCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
              ...makeDraft(),
              name: `singleflight_${crystallizeCalls}`,
            };
          },
        },
      }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0 }),
    });

    l2Bus.emit({
      kind: "l2.policy.induced",
      episodeId,
      policyId: policy.id,
      signature: "single|flight|skill|race" as PatternSignature,
      evidenceTraceIds: [] as TraceId[],
      evidenceEpisodeIds: [episodeId],
      title: "single flight",
    });
    const manual = sub.runOnce({ trigger: "manual", policyId: policy.id });
    await manual;
    await sub.flush();

    expect(crystallizeCalls).toBe(1);
    expect(h.repos.skills.list()).toHaveLength(1);
    sub.dispose();
  });

  it("coalesces concurrent runs for the same policy", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { episodeId } = seedTracesForPolicy(
      h,
      "po_coalesced" as PolicyId,
    );
    const policy = seedPolicy(h, {
      id: "po_coalesced" as PolicyId,
      sourceEpisodeIds: [episodeId],
    });
    let crystallizeCalls = 0;
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus: createRewardEventBus(),
      bus: createSkillEventBus(),
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({
        completeJson: {
          "skill.crystallize": async () => {
            crystallizeCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return makeDraft();
          },
        },
      }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0 }),
    });

    const [first, duplicate] = await Promise.all([
      sub.runOnce({ trigger: "manual", policyId: policy.id }),
      sub.runOnce({ trigger: "manual", policyId: policy.id }),
    ]);

    expect(first.crystallized).toBe(1);
    expect(duplicate.crystallized).toBe(1);
    expect(crystallizeCalls).toBe(1);
    expect(h.repos.skills.list()).toHaveLength(1);
    sub.dispose();
  });
});
