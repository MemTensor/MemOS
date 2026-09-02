import { describe, it, expect, afterEach } from "vitest";

import { rootLogger } from "../../../core/logger/index.js";
import { runSkill, type RunSkillDeps } from "../../../core/skill/index.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { EpisodeId, PolicyId } from "../../../core/types.js";
import { makeDraft, makeSkillConfig, seedPolicy, seedSessionOnly, seedTrace } from "./_helpers.js";

let handle: TmpDbHandle | null = null;

function open(): TmpDbHandle {
  handle = makeTmpDb();
  return handle;
}

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function makeDeps(h: TmpDbHandle, llm: RunSkillDeps["llm"]): RunSkillDeps {
  return {
    repos: h.repos,
    embedder: null,
    llm,
    log: rootLogger.child({ channel: "core.skill.backoff-test" }),
    bus: { emit: () => {} } as unknown as RunSkillDeps["bus"],
    config: makeSkillConfig(),
  };
}

// Scripted model refusal — crystallize returns { ok:false, skippedReason:"llm-refusal" }.
// (We deliberately do NOT drive failures with llm=null: that path returns
// "llm-disabled", a global config state the backoff must not count.)
function refusingLlm(): RunSkillDeps["llm"] {
  // NB: the refusal detector scans the raw JSON string, so a plain-string
  // response is what actually trips it (an object response starts with "{").
  return fakeLlm({ completeJson: { "skill.crystallize": "I cannot assist with this request." } });
}

function seedCandidate(h: TmpDbHandle): PolicyId {
  const sessionId = "s_backoff";
  seedSessionOnly(h, sessionId);
  const episodeId = "ep_backoff" as EpisodeId;
  seedTrace(h, {
    episodeId,
    sessionId,
    userText: "pip install cryptography failing",
    agentText: "apk add openssl-dev libffi-dev, retry pip install",
    reflection: "install system libs before pip",
    value: 0.9,
  });
  seedTrace(h, {
    episodeId,
    sessionId,
    userText: "cryptography install retry",
    agentText: "apk add openssl-dev && pip install cryptography",
    reflection: "musl wheels need system libs",
    value: 0.8,
  });
  return seedPolicy(h, { sourceEpisodeIds: [episodeId] }).id;
}

function failCount(h: TmpDbHandle, policyId: PolicyId): number {
  return h.repos.kv.get<number>(`skill.failCount:${policyId}`, 0);
}

describe("skill crystallize failure backoff", () => {
  it("flips skill_eligible off after SKILL_FAILURE_BACKOFF_LIMIT consecutive failures", async () => {
    const h = open();
    const policyId = seedCandidate(h);
    const deps = makeDeps(h, refusingLlm());

    for (let i = 1; i <= 2; i++) {
      const r = await runSkill({ trigger: "manual", policyId }, deps);
      expect(r.crystallized).toBe(0);
      expect(failCount(h, policyId)).toBe(i);
      // below the limit the policy stays eligible
      expect(h.repos.policies.getById(policyId)!.skillEligible).not.toBe(false);
    }

    await runSkill({ trigger: "manual", policyId }, deps);
    expect(failCount(h, policyId)).toBe(3);
    expect(h.repos.policies.getById(policyId)!.skillEligible).toBe(false);
  });

  it("reports the tripped backoff as its own skip reason on later runs", async () => {
    const h = open();
    const policyId = seedCandidate(h);
    const deps = makeDeps(h, refusingLlm());
    for (let i = 0; i < 3; i++) await runSkill({ trigger: "manual", policyId }, deps);

    const r = await runSkill({ trigger: "manual", policyId }, deps);
    // the eligibility gate now skips before crystallize — the run counts
    // the policy as skipped (not evaluated) and the failure counter
    // stays frozen at 3
    expect(r.evaluated).toBe(0);
    expect(r.crystallized).toBe(0);
    expect(failCount(h, policyId)).toBe(3);
    expect(h.repos.policies.getById(policyId)!.skillEligible).toBe(false);
  });

  it("clears the counter after a successful crystallization", async () => {
    const h = open();
    const policyId = seedCandidate(h);

    await runSkill({ trigger: "manual", policyId }, makeDeps(h, refusingLlm()));
    expect(failCount(h, policyId)).toBe(1);

    await runSkill({ trigger: "manual", policyId }, makeDeps(h, fakeLlm({ completeJson: { "skill.crystallize": makeDraft() } })));
    expect(failCount(h, policyId)).toBe(0);
    // (fewer-than-limit failures not tripping the backoff is covered by
    // the second run of the first test above)
  });

  it("does not count llm-disabled toward the backoff", async () => {
    const h = open();
    const policyId = seedCandidate(h);
    // llm=null => crystallize returns { ok:false, skippedReason:"llm-disabled" }:
    // a global configuration state. Even after many such ticks the policy
    // must stay eligible and the counter untouched.
    const deps = makeDeps(h, null);

    for (let i = 0; i < 4; i++) {
      const r = await runSkill({ trigger: "manual", policyId }, deps);
      expect(r.crystallized).toBe(0);
    }
    expect(failCount(h, policyId)).toBe(0);
    expect(h.repos.policies.getById(policyId)!.skillEligible).not.toBe(false);
  });
});
