import { describe, it, expect } from "vitest";

import { applyFeedback, recomputeEta, shouldArchiveIdle } from "../../../core/skill/lifecycle.js";
import type { PolicyRow, SkillRow } from "../../../core/types.js";
import { makeSkillConfig, NOW } from "./_helpers.js";

function mkSkill(partial: Partial<SkillRow> = {}): SkillRow {
  return {
    id: (partial.id ?? "sk_l") as SkillRow["id"],
    name: partial.name ?? "skill",
    status: partial.status ?? "candidate",
    invocationGuide: "",
    procedureJson: null,
    eta: partial.eta ?? 0.5,
    support: partial.support ?? 3,
    gain: partial.gain ?? 0.3,
    trialsAttempted: partial.trialsAttempted ?? 0,
    trialsPassed: partial.trialsPassed ?? 0,
    sourcePolicyIds: partial.sourcePolicyIds ?? [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: null,
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    version: partial.version ?? 1,
  };
}

describe("skill/lifecycle", () => {
  it("bumps trial counters and blends outcomes with a one-sample η prior", () => {
    const s = mkSkill();
    const a = applyFeedback(s, "trial.pass", makeSkillConfig());
    expect(a.trialsAttempted).toBe(1);
    expect(a.trialsPassed).toBe(1);
    expect(a.eta).toBeCloseTo(0.75, 5);
    const b = applyFeedback({ ...s, ...a }, "trial.fail", makeSkillConfig());
    expect(b.trialsAttempted).toBe(2);
    expect(b.trialsPassed).toBe(1);
    expect(b.eta).toBe(0.5);
  });

  it("keeps a 0.58-prior skill alive until the fifth consecutive failure at a 0.1 floor", () => {
    const cfg = makeSkillConfig({
      candidateTrials: 1,
      archiveEta: 0.1,
      minEtaForRetrieval: 0.1,
    });
    let s = mkSkill({ status: "candidate", eta: 0.58 });

    for (let i = 0; i < 4; i += 1) {
      const update = applyFeedback(s, "trial.fail", cfg);
      expect(update.status).not.toBe("archived");
      s = { ...s, ...update };
    }

    const fifth = applyFeedback(s, "trial.fail", cfg);
    expect(fifth.eta).toBeLessThan(0.1);
    expect(fifth.status).toBe("archived");
    expect(fifth.transition).toBe("archived");
  });

  it("promotes candidate → active once enough passing trials accrue", () => {
    const cfg = makeSkillConfig({ candidateTrials: 3, minEtaForRetrieval: 0.5 });
    let s = mkSkill({ status: "candidate" });
    s = { ...s, ...applyFeedback(s, "trial.pass", cfg) };
    s = { ...s, ...applyFeedback(s, "trial.pass", cfg) };
    const after = applyFeedback(s, "trial.pass", cfg);
    expect(after.status).toBe("active");
    expect(after.transition).toBe("promoted");
  });

  it("archives when trial ratio cannot meet the floor after candidate trials", () => {
    const cfg = makeSkillConfig({ candidateTrials: 3, minEtaForRetrieval: 0.8 });
    let s = mkSkill({ status: "candidate" });
    s = { ...s, ...applyFeedback(s, "trial.fail", cfg) };
    s = { ...s, ...applyFeedback(s, "trial.fail", cfg) };
    const after = applyFeedback(s, "trial.fail", cfg);
    expect(after.status).toBe("archived");
    expect(after.transition).toBe("archived");
  });

  it("handles user thumbs", () => {
    const cfg = makeSkillConfig({ etaDelta: 0.1 });
    let s = mkSkill({ eta: 0.5, status: "active" });
    const up = applyFeedback(s, "user.positive", cfg);
    expect(up.eta).toBeCloseTo(0.6, 5);
    s = { ...s, ...up };
    const down = applyFeedback(s, "user.negative", cfg, 0.5);
    expect(down.eta).toBeCloseTo(0.1, 5);
  });

  it("demotes to archived on severe reward drift", () => {
    const cfg = makeSkillConfig({ archiveEta: 0.4 });
    const s = mkSkill({ status: "active", eta: 0.5 });
    const drift = applyFeedback(s, "reward.updated", cfg, 0.0);
    expect(drift.eta).toBeLessThan(0.4);
    expect(drift.status).toBe("archived");
  });

  it("recomputeEta falls back to policy gain when skill has no trials", () => {
    const cfg = makeSkillConfig({ minEtaForRetrieval: 0.5 });
    const s = mkSkill({ trialsAttempted: 0, eta: 0.1 });
    const policy = { gain: 0.7 } as PolicyRow;
    expect(recomputeEta(s, policy, cfg)).toBeCloseTo(0.7, 5);
  });

  it("shouldArchiveIdle picks up stale active skills with low η", () => {
    const cfg = makeSkillConfig({ minEtaForRetrieval: 0.6 });
    const s = mkSkill({ status: "active", eta: 0.4, updatedAt: 0 as SkillRow["updatedAt"] });
    expect(shouldArchiveIdle(s, 1000, cfg, 10_000)).toBe(true);
  });
});
