import { describe, it, expect, afterEach, vi } from "vitest";

import { createL2EventBus } from "../../../core/memory/l2/events.js";
import { createRewardEventBus } from "../../../core/reward/events.js";
import type { RewardResult } from "../../../core/reward/types.js";
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
  seedSkill,
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

function minimalRewardResult(episodeId: EpisodeId): RewardResult {
  return {
    episodeId,
    sessionId: "s_reward",
    rHuman: 0.8,
    humanScore: {
      rHuman: 0.8,
      axes: { goalAchievement: 1, processQuality: 1, userSatisfaction: 1 },
      reason: "test",
      source: "heuristic",
      model: null,
    },
    feedbackCount: 0,
    backprop: {
      updates: [],
      meanAbsValue: 0,
      maxPriority: 0,
      echoParams: { gamma: 0.9, decayHalfLifeDays: 30, now: Date.now() },
    },
    traceIds: [],
    timings: { summary: 0, score: 0, backprop: 0, persist: 0, total: 0 },
    warnings: [],
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
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

  it("runs reward updates only for policies linked to that episode", async () => {
    handle = makeTmpDb();
    const h = handle;
    const episodeA = seedTracesForPolicy(h, "po_reward_a" as PolicyId).episodeId;
    const episodeB = seedTracesForPolicy(h, "po_reward_b" as PolicyId).episodeId;
    const policyA = seedPolicy(h, { id: "po_reward_a" as PolicyId, sourceEpisodeIds: [episodeA] });
    seedPolicy(h, { id: "po_reward_b" as PolicyId, sourceEpisodeIds: [episodeB] });
    const traceA = h.repos.traces.listAllForEpisode(episodeA)[0]!;
    h.repos.tracePolicyLinks.link({ traceId: traceA.id, policyId: policyA.id, episodeId: episodeA });

    const rewardBus = createRewardEventBus();
    let draftNumber = 0;
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus,
      bus: createSkillEventBus(),
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({
        completeJson: {
          "skill.crystallize": () => {
            draftNumber += 1;
            return makeDraft({ name: `reward_policy_${draftNumber}` });
          },
        },
      }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 6 * 60 * 60 * 1000 }),
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: minimalRewardResult(episodeA),
    });
    await sub.flush();

    expect(h.repos.skills.list().map((skill) => skill.sourcePolicyIds.flat()).flat()).toEqual([policyA.id]);
    sub.dispose();
  });

  it("does not let one policy cooldown block another policy reward update", async () => {
    handle = makeTmpDb();
    const h = handle;
    const episodeA = seedTracesForPolicy(h, "po_reward_c" as PolicyId).episodeId;
    const episodeB = seedTracesForPolicy(h, "po_reward_d" as PolicyId).episodeId;
    const policyA = seedPolicy(h, { id: "po_reward_c" as PolicyId, sourceEpisodeIds: [episodeA] });
    const policyB = seedPolicy(h, { id: "po_reward_d" as PolicyId, sourceEpisodeIds: [episodeB] });
    for (const [policy, episode] of [[policyA, episodeA], [policyB, episodeB]] as const) {
      const trace = h.repos.traces.listAllForEpisode(episode)[0]!;
      h.repos.tracePolicyLinks.link({ traceId: trace.id, policyId: policy.id, episodeId: episode });
    }

    const rewardBus = createRewardEventBus();
    let draftNumber = 0;
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus,
      bus: createSkillEventBus(),
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({
        completeJson: {
          "skill.crystallize": () => {
            draftNumber += 1;
            return makeDraft({ name: `reward_cooldown_${draftNumber}` });
          },
        },
      }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 6 * 60 * 60 * 1000 }),
    });

    rewardBus.emit({ kind: "reward.updated", result: minimalRewardResult(episodeA) });
    await sub.flush();
    rewardBus.emit({ kind: "reward.updated", result: minimalRewardResult(episodeB) });
    await sub.flush();

    expect(h.repos.skills.list().flatMap((skill) => skill.sourcePolicyIds.map(String)).sort()).toEqual([
      String(policyA.id),
      String(policyB.id),
    ]);
    sub.dispose();
  });

  it("retains a same-policy reward event received during cooldown", async () => {
    handle = makeTmpDb();
    const h = handle;
    const episode = seedTracesForPolicy(h, "po_reward_pending" as PolicyId).episodeId;
    const policy = seedPolicy(h, {
      id: "po_reward_pending" as PolicyId,
      sourceEpisodeIds: [episode],
    });
    const trace = h.repos.traces.listAllForEpisode(episode)[0]!;
    h.repos.tracePolicyLinks.link({ traceId: trace.id, policyId: policy.id, episodeId: episode });

    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();
    let eligibilityRuns = 0;
    bus.on("skill.eligibility.checked", () => {
      eligibilityRuns += 1;
    });
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: fakeLlm({ completeJson: { "skill.crystallize": makeDraft() } }),
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 20 }),
    });

    rewardBus.emit({ kind: "reward.updated", result: minimalRewardResult(episode) });
    await sub.flush();
    rewardBus.emit({ kind: "reward.updated", result: minimalRewardResult(episode) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sub.flush();

    expect(eligibilityRuns).toBe(2);
    sub.dispose();
  });

  it("archives each stale low-η active skill once without regressing candidate promotion", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();
    const events: Array<{
      skillId: string;
      previous: string;
      next: string;
      transition: string;
    }> = [];
    bus.on("skill.status.changed", (event) => {
      if (event.kind !== "skill.status.changed") return;
      events.push({
        skillId: event.skillId,
        previous: event.previous,
        next: event.next,
        transition: event.transition,
      });
    });

    const stale = seedSkill(h, {
      id: "sk_stale" as never,
      name: "stale_skill",
      status: "active",
      eta: 0.05,
      createdAt: 1 as never,
      updatedAt: 9_000 as never,
      lastUsedAt: 1_000 as never,
    });
    const candidate = seedSkill(h, {
      id: "sk_candidate" as never,
      name: "candidate_skill",
      status: "candidate",
      eta: 0.7,
      createdAt: 1 as never,
      updatedAt: 1 as never,
    });

    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: null,
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ minEtaForRetrieval: 0.1, idleArchiveMs: 1_000 }),
    });

    await sub.lifecycleTick();
    await sub.lifecycleTick();

    expect(h.repos.skills.getById(stale.id)?.status).toBe("archived");
    expect(h.repos.skills.getById(candidate.id)?.status).toBe("active");
    expect(events.filter((event) => event.skillId === stale.id)).toEqual([
      { skillId: stale.id, previous: "active", next: "archived", transition: "archived" },
    ]);
    expect(events.filter((event) => event.skillId === candidate.id)).toHaveLength(1);
    sub.dispose();
  });

  it("drains more than one 500-skill idle archive batch in one lifecycle tick", async () => {
    handle = makeTmpDb();
    const h = handle;
    for (let i = 0; i < 501; i++) {
      seedSkill(h, {
        id: `sk_stale_${i}` as never,
        name: `stale_skill_${i}`,
        status: "active",
        eta: 0.05,
        createdAt: 1 as never,
        updatedAt: (i + 1) as never,
        lastUsedAt: 1 as never,
      });
    }
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus: createRewardEventBus(),
      bus: createSkillEventBus(),
      repos: h.repos,
      embedder: null,
      llm: null,
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ minEtaForRetrieval: 0.1, idleArchiveMs: 1_000 }),
    });

    await sub.lifecycleTick();

    expect(h.repos.skills.count({ status: "archived" })).toBe(501);
    expect(h.repos.skills.count({ status: "active" })).toBe(0);
    sub.dispose();
  });

  it("caps idle archival at ten batches per lifecycle tick", async () => {
    handle = makeTmpDb();
    const h = handle;
    for (let i = 0; i < 5_001; i++) {
      seedSkill(h, {
        id: `sk_backlog_${i}` as never,
        name: `backlog_skill_${i}`,
        status: "active",
        eta: 0.05,
        createdAt: 1 as never,
        updatedAt: (i + 1) as never,
        lastUsedAt: 1 as never,
      });
    }
    const log = rootLogger.child({ channel: "core.skill.subscriber" });
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const sub = attachSkillSubscriber({
      l2Bus: createL2EventBus(),
      rewardBus: createRewardEventBus(),
      bus: createSkillEventBus(),
      repos: h.repos,
      embedder: null,
      llm: null,
      log,
      config: makeSkillConfig({ minEtaForRetrieval: 0.1, idleArchiveMs: 1_000 }),
    });

    await sub.lifecycleTick();

    expect(h.repos.skills.count({ status: "archived" })).toBe(5_000);
    expect(h.repos.skills.count({ status: "active" })).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith("skill.idle_archive_batch_limit_reached", {
      batchCount: 10,
      archivedCount: 5_000,
      batchSize: 500,
    });

    await sub.lifecycleTick();

    expect(h.repos.skills.count({ status: "archived" })).toBe(5_001);
    expect(h.repos.skills.count({ status: "active" })).toBe(0);
    sub.dispose();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
