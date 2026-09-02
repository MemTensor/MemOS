import { describe, it, expect } from "vitest";

import { evaluateEligibility } from "../../../core/skill/eligibility.js";
import type { PolicyRow, SkillRow } from "../../../core/types.js";
import { makeSkillConfig } from "./_helpers.js";

const BASE_POLICY = {
  title: "x",
  trigger: "t",
  procedure: "p",
  verification: "v",
  boundary: "",
  sourceEpisodeIds: [] as string[],
  inducedBy: "l2.l2.induction.v1",
  decisionGuidance: { preference: [], antiPattern: [] },
  vec: null,
  createdAt: 1 as unknown as PolicyRow["createdAt"],
  updatedAt: 2 as unknown as PolicyRow["updatedAt"],
} as const;

function mkPolicy(partial: Partial<PolicyRow>): PolicyRow {
  return {
    ...BASE_POLICY,
    id: (partial.id ?? "po_1") as PolicyRow["id"],
    status: partial.status ?? "active",
    support: partial.support ?? 3,
    gain: partial.gain ?? 0.3,
    title: partial.title ?? BASE_POLICY.title,
    trigger: partial.trigger ?? BASE_POLICY.trigger,
    procedure: partial.procedure ?? BASE_POLICY.procedure,
    verification: partial.verification ?? BASE_POLICY.verification,
    boundary: partial.boundary ?? BASE_POLICY.boundary,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? [],
    inducedBy: partial.inducedBy ?? BASE_POLICY.inducedBy,
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: partial.vec ?? null,
    createdAt: (partial.createdAt ?? BASE_POLICY.createdAt) as PolicyRow["createdAt"],
    updatedAt: (partial.updatedAt ?? BASE_POLICY.updatedAt) as PolicyRow["updatedAt"],
    crystallizationBackoff: partial.crystallizationBackoff,
  };
}

function mkSkill(partial: Partial<SkillRow>): SkillRow {
  return {
    id: (partial.id ?? "sk_1") as SkillRow["id"],
    name: partial.name ?? "n",
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
    createdAt: (partial.createdAt ?? 1) as SkillRow["createdAt"],
    updatedAt: (partial.updatedAt ?? 1) as SkillRow["updatedAt"],
    version: partial.version ?? 1,
  };
}

describe("skill/eligibility", () => {
  it("crystallizes a policy that meets support + gain + active", () => {
    const cfg = makeSkillConfig({ minSupport: 3, minGain: 0.2 });
    const policy = mkPolicy({ support: 4, gain: 0.3, status: "active" });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map() },
      cfg,
    );
    expect(r.eligibleCount).toBe(1);
    expect(r.skippedCount).toBe(0);
    expect(r.decisions[0]!.action).toBe("crystallize");
  });

  it("skips inactive policies", () => {
    const cfg = makeSkillConfig();
    const policy = mkPolicy({ status: "candidate", support: 5, gain: 0.4 });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map() },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("skip");
    expect(r.decisions[0]!.reason).toMatch(/policy.status/);
  });

  it("skips if gain or support are too low", () => {
    const cfg = makeSkillConfig({ minSupport: 3, minGain: 0.2 });
    const low = mkPolicy({ id: "po_low", support: 1, gain: 0.3 });
    const weak = mkPolicy({ id: "po_weak", support: 5, gain: 0.1 });
    const r = evaluateEligibility(
      { policies: [low, weak], skillsByPolicy: new Map() },
      cfg,
    );
    expect(r.decisions.every((d) => d.action === "skip")).toBe(true);
  });

  it("rebuilds when existing skill is older than policy", () => {
    const cfg = makeSkillConfig();
    const policy = mkPolicy({ support: 5, gain: 0.4, updatedAt: 100 as PolicyRow["updatedAt"] });
    const existing = mkSkill({
      sourcePolicyIds: [policy.id],
      updatedAt: 50 as SkillRow["updatedAt"],
      status: "active",
    });
    const r = evaluateEligibility(
      {
        policies: [policy],
        skillsByPolicy: new Map([[policy.id, existing]]),
      },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("rebuild");
  });

  it("skips when existing skill is fresher than policy", () => {
    const cfg = makeSkillConfig();
    const policy = mkPolicy({ support: 5, gain: 0.4, updatedAt: 50 as PolicyRow["updatedAt"] });
    const existing = mkSkill({
      sourcePolicyIds: [policy.id],
      updatedAt: 100 as SkillRow["updatedAt"],
      status: "active",
    });
    const r = evaluateEligibility(
      {
        policies: [policy],
        skillsByPolicy: new Map([[policy.id, existing]]),
      },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("skip");
  });

  it("treats an archived existing skill the same as no skill — mints fresh", () => {
    const cfg = makeSkillConfig();
    const policy = mkPolicy({ support: 5, gain: 0.4 });
    const archived = mkSkill({ status: "archived", sourcePolicyIds: [policy.id] });
    const r = evaluateEligibility(
      {
        policies: [policy],
        skillsByPolicy: new Map([[policy.id, archived]]),
      },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("crystallize");
    expect(r.decisions[0]!.existingSkill?.status).toBe("archived");
  });

  // ─── Crystallization back-off gate (issue #2319) ─────────────────────

  it("skips a policy whose back-off window has not yet elapsed", () => {
    const cfg = makeSkillConfig({
      crystallizationBackoffBaseMs: 60_000,
      crystallizationBackoffMaxMs: 3_600_000,
      crystallizationMaxAttempts: 8,
    });
    const policy = mkPolicy({
      support: 5,
      gain: 0.4,
      updatedAt: 1_000 as PolicyRow["updatedAt"],
      crystallizationBackoff: {
        attempts: 1,
        backoffUntil: 60_000 as PolicyRow["updatedAt"],
        lastAttemptAt: 5_000 as PolicyRow["updatedAt"],
        lastFailureReason: "llm-refusal",
      },
    });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map(), now: 30_000 },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("skip");
    expect(r.decisions[0]!.reason).toMatch(/^crystallization-backoff attempts=1 until=60000$/);
  });

  it("proceeds once the back-off window has elapsed", () => {
    const cfg = makeSkillConfig({
      crystallizationBackoffBaseMs: 60_000,
      crystallizationMaxAttempts: 8,
    });
    const policy = mkPolicy({
      support: 5,
      gain: 0.4,
      updatedAt: 1_000 as PolicyRow["updatedAt"],
      crystallizationBackoff: {
        attempts: 1,
        backoffUntil: 60_000 as PolicyRow["updatedAt"],
        lastAttemptAt: 5_000 as PolicyRow["updatedAt"],
        lastFailureReason: "llm-refusal",
      },
    });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map(), now: 60_001 },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("crystallize");
  });

  it("quarantines a policy once max attempts is reached", () => {
    const cfg = makeSkillConfig({ crystallizationMaxAttempts: 3 });
    const policy = mkPolicy({
      support: 5,
      gain: 0.4,
      updatedAt: 100 as PolicyRow["updatedAt"],
      crystallizationBackoff: {
        attempts: 3,
        backoffUntil: null,
        lastAttemptAt: 1_000 as PolicyRow["updatedAt"],
        lastFailureReason: "verify:coverage-below-threshold",
      },
    });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map(), now: 999_999_999 },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("skip");
    expect(r.decisions[0]!.reason).toContain("crystallization-quarantined attempts=3");
    expect(r.decisions[0]!.reason).toContain("reason=verify:coverage-below-threshold");
  });

  it("ignores back-off when the policy has been updated since the last attempt", () => {
    const cfg = makeSkillConfig({ crystallizationMaxAttempts: 8 });
    const policy = mkPolicy({
      support: 5,
      gain: 0.4,
      updatedAt: 10_000 as PolicyRow["updatedAt"],
      crystallizationBackoff: {
        attempts: 5,
        backoffUntil: 999_999_999 as PolicyRow["updatedAt"],
        lastAttemptAt: 5_000 as PolicyRow["updatedAt"],
        lastFailureReason: "verify:resonance-below-threshold",
      },
    });
    const r = evaluateEligibility(
      { policies: [policy], skillsByPolicy: new Map(), now: 6_000 },
      cfg,
    );
    expect(r.decisions[0]!.action).toBe("crystallize");
  });
});
