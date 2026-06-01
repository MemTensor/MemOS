import { describe, it, expect } from "vitest";

import {
  assertValidOutcomeThresholds,
  computeEpisodeOutcome,
  extractEpisodeVerifierPassed,
  DEFAULT_OUTCOME_THRESHOLDS,
} from "../../../core/episode/outcome.js";

const cfg = DEFAULT_OUTCOME_THRESHOLDS;

describe("assertValidOutcomeThresholds", () => {
  it("accepts default symmetric bands", () => {
    expect(() => assertValidOutcomeThresholds(cfg)).not.toThrow();
  });

  it("rejects success <= failure", () => {
    expect(() =>
      assertValidOutcomeThresholds({ successThreshold: -0.2, failureThreshold: 0.3 }),
    ).toThrow(/must be > outcomeRTaskFailureThreshold/);
    expect(() =>
      assertValidOutcomeThresholds({ successThreshold: 0.5, failureThreshold: 0.5 }),
    ).toThrow();
  });
});

describe("computeEpisodeOutcome", () => {
  it("verifier=false is a one-vote veto regardless of rTask", () => {
    expect(computeEpisodeOutcome(0.9, false, cfg)).toBe("failure");
    expect(computeEpisodeOutcome(null, false, cfg)).toBe("failure");
  });

  it("rTask >= 0.5 = success (when verifier doesn't veto)", () => {
    expect(computeEpisodeOutcome(0.5, null, cfg)).toBe("success");
    expect(computeEpisodeOutcome(0.6, true, cfg)).toBe("success");
    expect(computeEpisodeOutcome(1, null, cfg)).toBe("success");
    expect(computeEpisodeOutcome(0.25, null, cfg)).toBe("unknown");
  });

  it("rTask <= -0.5 = failure (when verifier doesn't veto)", () => {
    expect(computeEpisodeOutcome(-0.5, null, cfg)).toBe("failure");
    expect(computeEpisodeOutcome(-1, null, cfg)).toBe("failure");
    expect(computeEpisodeOutcome(-0.25, null, cfg)).toBe("unknown");
  });

  it("neutral rTask + verifier=true => verifier fallback yields success", () => {
    expect(computeEpisodeOutcome(0.0, true, cfg)).toBe("success");
    expect(computeEpisodeOutcome(0.1, true, cfg)).toBe("success");
  });

  it("neutral rTask + verifier=null => unknown", () => {
    expect(computeEpisodeOutcome(0.0, null, cfg)).toBe("unknown");
    expect(computeEpisodeOutcome(0.1, null, cfg)).toBe("unknown");
    expect(computeEpisodeOutcome(-0.1, null, cfg)).toBe("unknown");
  });
});

describe("extractEpisodeVerifierPassed", () => {
  it("full pass via passed/total", () => {
    expect(extractEpisodeVerifierPassed([{ raw: { passed: 4, total: 4 } }])).toBe(true);
  });

  it("full pass via reward>=1", () => {
    expect(extractEpisodeVerifierPassed([{ raw: { reward: 1 } }])).toBe(true);
  });

  it("partial pass is false", () => {
    expect(extractEpisodeVerifierPassed([{ raw: { passed: 2, total: 4 } }])).toBe(false);
  });

  it("no verifier signal => null", () => {
    expect(extractEpisodeVerifierPassed([{ raw: { sentiment: "good" } }])).toBeNull();
    expect(extractEpisodeVerifierPassed([])).toBeNull();
  });

  it("nested verifier payload", () => {
    expect(
      extractEpisodeVerifierPassed([{ raw: { verifier: { passed: 3, total: 3 } } }]),
    ).toBe(true);
  });

  it("any false vetoes across rows", () => {
    expect(
      extractEpisodeVerifierPassed([
        { raw: { passed: 4, total: 4 } },
        { raw: { passed: 1, total: 4 } },
      ]),
    ).toBe(false);
  });

  it("aligns with objectiveOutcome: score alias at top level", () => {
    expect(extractEpisodeVerifierPassed([{ raw: { source: "verifier", score: 1 } }])).toBe(
      true,
    );
    expect(extractEpisodeVerifierPassed([{ raw: { source: "verifier", score: -1 } }])).toBe(
      false,
    );
  });

  it("aligns with objectiveOutcome: numeric strings and nested verifier", () => {
    expect(
      extractEpisodeVerifierPassed([
        { raw: JSON.stringify({ verifier: { passed: "4", total: "4" } }) },
      ]),
    ).toBe(true);
    expect(
      extractEpisodeVerifierPassed([
        { raw: { verifier: { reward: 0.9999999998 } } },
      ]),
    ).toBe(true);
  });
});
