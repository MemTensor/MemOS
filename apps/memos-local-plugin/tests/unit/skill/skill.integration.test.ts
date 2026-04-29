import { describe, it, expect, afterEach } from "vitest";

import { rootLogger } from "../../../core/logger/index.js";
import {
  applySkillFeedback,
  createSkillEventBus,
  runSkill,
  type RunSkillDeps,
  type SkillEvent,
} from "../../../core/skill/index.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { EpisodeId, PolicyId, SkillId } from "../../../core/types.js";
import {
  makeDraft,
  makeSkillConfig,
  seedPolicy,
  seedSessionOnly,
  seedTrace,
  vec,
} from "./_helpers.js";

let handle: TmpDbHandle | null = null;

function open(): TmpDbHandle {
  handle = makeTmpDb();
  return handle;
}

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function makeDeps(
  h: TmpDbHandle,
  overrides: Partial<RunSkillDeps> = {},
): { deps: RunSkillDeps; events: SkillEvent[] } {
  const bus = createSkillEventBus();
  const events: SkillEvent[] = [];
  bus.onAny((e) => events.push(e));
  const deps: RunSkillDeps = {
    repos: h.repos,
    embedder: null,
    llm: fakeLlm({
      completeJson: {
        "skill.crystallize": makeDraft(),
      },
    }),
    log: rootLogger.child({ channel: "core.skill" }),
    bus,
    config: makeSkillConfig(),
    ...overrides,
  };
  return { deps, events };
}

function seedFullCandidate(h: TmpDbHandle): {
  policyId: PolicyId;
  episodeId: EpisodeId;
} {
  const sessionId = "s_int";
  const episodeId = "ep_int" as EpisodeId;
  seedSessionOnly(h, sessionId);
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    userText: "pip install cryptography failing",
    agentText: "apk add openssl-dev libffi-dev, retry pip install",
    reflection: "install system libs before pip",
    value: 0.9,
  });
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    userText: "cryptography install retry",
    agentText: "apk add then retry pip install cryptography",
    value: 0.7,
  });
  const policy = seedPolicy(h, {
    id: "po_int" as PolicyId,
    sourceEpisodeIds: [episodeId],
    gain: 0.3,
    support: 3,
    status: "active",
  });
  return { policyId: policy.id, episodeId };
}

describe("skill/runSkill (integration)", () => {
  it("crystallizes a fresh skill for an eligible policy", async () => {
    const h = open();
    const { policyId } = seedFullCandidate(h);
    const { deps, events } = makeDeps(h);
    const r = await runSkill({ trigger: "manual", policyId }, deps);
    expect(r.evaluated).toBe(1);
    expect(r.crystallized).toBe(1);
    expect(r.rejected).toBe(0);
    expect(events.some((e) => e.kind === "skill.crystallized")).toBe(true);
    const all = h.repos.skills.list();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("candidate");
    expect(all[0]!.sourcePolicyIds).toContain(policyId);
  });

  it("rebuilds an existing skill when the policy has drifted", async () => {
    const h = open();
    const { policyId } = seedFullCandidate(h);
    const { deps } = makeDeps(h);
    await runSkill({ trigger: "manual", policyId }, deps);
    const before = h.repos.skills.list()[0]!;

    // Mutate the policy so updatedAt > skill.updatedAt. The orchestrator
    // stamped the skill with `nowMs()`, so push the policy's timestamp
    // comfortably past that.
    const current = h.repos.policies.getById(policyId)!;
    h.repos.policies.upsert({
      ...current,
      procedure: `${current.procedure}\n4. verify service restart`,
      gain: current.gain + 0.1,
      updatedAt: (before.updatedAt + 1000) as typeof current.updatedAt,
    });

    const run2 = makeDeps(h);
    const r = await runSkill({ trigger: "manual", policyId }, run2.deps);
    expect(r.rebuilt).toBe(1);
    expect(r.crystallized).toBe(0);
    expect(run2.events.some((e) => e.kind === "skill.rebuilt")).toBe(true);
    const after = h.repos.skills.getById(before.id)!;
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("skips when LLM is disabled", async () => {
    const h = open();
    const { policyId } = seedFullCandidate(h);
    const { deps, events } = makeDeps(h, {
      config: makeSkillConfig({ useLlm: false }),
    });
    const r = await runSkill({ trigger: "manual", policyId }, deps);
    expect(r.rejected).toBe(1);
    expect(r.crystallized).toBe(0);
    expect(events.some((e) => e.kind === "skill.failed" && e.stage === "crystallize")).toBe(
      true,
    );
  });

  it("emits policy and model details when skill crystallization is refused by the model", async () => {
    const h = open();
    const { policyId } = seedFullCandidate(h);
    const { deps, events } = makeDeps(h, {
      llm: fakeLlm({
        servedBy: "anthropic",
        model: "claude-test",
        completeJson: {
          "skill.crystallize": makeDraft({
            summary: "I am Claude, made by Anthropic. I cannot process this request.",
          }),
        },
      }),
    });

    const r = await runSkill({ trigger: "manual", policyId }, deps);
    expect(r.rejected).toBe(1);
    expect(r.crystallized).toBe(0);
    const failed = events.find(
      (e) => e.kind === "skill.failed" && e.stage === "crystallize",
    );
    expect(failed).toMatchObject({
      policyId,
      reason: "llm-refusal",
      modelRefusal: {
        provider: "openai_compatible",
        model: "claude-test",
        content: expect.stringContaining("I cannot process this request"),
      },
    });
  });

  it("applySkillFeedback updates η + status and emits", async () => {
    const h = open();
    const { policyId } = seedFullCandidate(h);
    const { deps } = makeDeps(h);
    await runSkill({ trigger: "manual", policyId }, deps);
    const sk = h.repos.skills.list()[0]!;
    const events: SkillEvent[] = [];
    deps.bus.onAny((e) => events.push(e));

    applySkillFeedback(sk.id as SkillId, "user.positive", deps);
    applySkillFeedback(sk.id as SkillId, "user.positive", deps);
    const post = h.repos.skills.getById(sk.id as SkillId)!;
    expect(post.eta).toBeGreaterThan(sk.eta);
    expect(events.some((e) => e.kind === "skill.eta.updated")).toBe(true);
  });

  it("emits skill.failed when evidence is empty (e.g. redacted)", async () => {
    const h = open();
    const sessionId = "s_empty";
    const episodeId = "ep_empty" as EpisodeId;
    seedSessionOnly(h, sessionId);
    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      userText: "[REDACTED]",
      agentText: "[REDACTED]",
      value: 0.9,
    });
    const policy = seedPolicy(h, {
      id: "po_empty" as PolicyId,
      sourceEpisodeIds: [episodeId],
      support: 3,
      gain: 0.3,
    });
    const { deps, events } = makeDeps(h);
    const r = await runSkill({ trigger: "manual", policyId: policy.id }, deps);
    expect(r.rejected).toBe(0);
    expect(r.evaluated).toBe(1);
    expect(r.warnings[0]?.reason).toBe("no-evidence");
    expect(events.some((e) => e.kind === "skill.failed")).toBe(true);
  });
});
