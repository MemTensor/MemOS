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

  it("resolves a strict (repair) trial by full-pass-only while a loose trial passes on the same reward", async () => {
    handle = makeTmpDb();
    const h = handle;
    const l2Bus = createL2EventBus();
    const rewardBus = createRewardEventBus();
    const bus = createSkillEventBus();

    const { episodeId } = seedTracesForPolicy(h, "po_strict" as PolicyId);

    const baseSkill = {
      ownerAgentKind: "openclaw" as const,
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      invocationGuide: "guide",
      procedureJson: null,
      eta: 0.5,
      support: 1,
      gain: 0.3,
      trialsAttempted: 0,
      trialsPassed: 0,
      sourcePolicyIds: [],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: 1 as never,
      updatedAt: 1 as never,
      version: 1,
    };
    h.repos.skills.insert({
      ...baseSkill,
      id: "sk_strict" as never,
      name: "strict_repair",
      status: "candidate",
      strictTrial: true,
      repairOrigin: true,
    } as never);
    h.repos.skills.insert({
      ...baseSkill,
      id: "sk_loose" as never,
      name: "loose_skill",
      status: "candidate",
      strictTrial: false,
    } as never);

    const baseTrial = {
      ownerAgentKind: "openclaw" as const,
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      sessionId: null,
      episodeId,
      traceId: null,
      turnId: null,
      toolCallId: null,
      status: "pending" as const,
      createdAt: 1,
      resolvedAt: null,
      evidence: {},
    };
    h.repos.skillTrials.createPending({ ...baseTrial, id: "st_strict", skillId: "sk_strict" as never } as never);
    h.repos.skillTrials.createPending({ ...baseTrial, id: "st_loose", skillId: "sk_loose" as never } as never);

    // The re-run's verifier: a PARTIAL pass (3/4, reward 0) — a failure under
    // full-pass-only, even though r_task=0.6 would loosely pass.
    h.repos.feedback.insert({
      id: "fb_v" as never,
      ts: 5,
      episodeId: episodeId as never,
      traceId: null,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 1,
      rationale: "Verifier: passed 3/4.",
      raw: { source: "verifier", verifier: { reward: 0, passed: 3, total: 4 } },
    } as never);

    const sub = attachSkillSubscriber({
      l2Bus,
      rewardBus,
      bus,
      repos: h.repos,
      embedder: null,
      llm: null,
      log: rootLogger.child({ channel: "core.skill.subscriber" }),
      config: makeSkillConfig({ cooldownMs: 0, candidateTrials: 5 }),
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: { episodeId, sessionId: `s-po_strict`, rHuman: 0.6, completedAt: 10 } as never,
    });
    await new Promise((r) => setTimeout(r, 20));
    await sub.flush();

    const strict = h.repos.skills.getById("sk_strict" as never)!;
    const loose = h.repos.skills.getById("sk_loose" as never)!;
    // Strict: verifier was a partial pass → trial fails (no pass credit).
    expect(strict.trialsAttempted).toBe(1);
    expect(strict.trialsPassed).toBe(0);
    // Loose: r_task 0.6 ≥ 0.5 → trial passes.
    expect(loose.trialsAttempted).toBe(1);
    expect(loose.trialsPassed).toBe(1);
    sub.dispose();
  });
});
