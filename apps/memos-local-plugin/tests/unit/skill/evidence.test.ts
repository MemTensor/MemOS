import { describe, it, expect, afterEach } from "vitest";

import {
  gatherCounterExamples,
  gatherEvidence,
} from "../../../core/skill/evidence.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { EpisodeId, PolicyId } from "../../../core/types.js";
import { ensureEpisode } from "../memory/l2/_helpers.js";
import { NOW } from "./_helpers.js";
import {
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

describe("skill/evidence", () => {
  it("prefers traces with high V and policy-aligned summaries", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const policy = seedPolicy(h, {
      id: "po_ev" as PolicyId,
      sourceEpisodeIds: ["ep_e1" as EpisodeId, "ep_e2" as EpisodeId],
      vec: vec([1, 0, 0]),
    });

    const aligned = seedTrace(h, {
      id: "tr_best",
      episodeId: "ep_e1",
      sessionId: "s_ev",
      userText: "pip install cryptography failing",
      agentText: "apk add libffi-dev, retry",
      value: 0.9,
      vec: vec([1, 0, 0]),
    });
    const weak = seedTrace(h, {
      id: "tr_weak",
      episodeId: "ep_e2",
      sessionId: "s_ev",
      userText: "hello",
      agentText: "world",
      value: 0.3,
      vec: vec([0, 1, 0]),
    });

    const r = gatherEvidence(policy, {
      repos: h.repos,
      config: makeSkillConfig({ evidenceLimit: 2 }),
    });
    expect(r.traces.length).toBe(2);
    expect(r.traces[0]!.trace.id).toBe(aligned.id);
    expect(r.traces[1]!.trace.id).toBe(weak.id);
    expect(r.episodeIds).toContain(aligned.episodeId);
    expect(r.medianValue).toBeGreaterThan(0);
  });

  it("drops redacted traces and char-caps long text", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const policy = seedPolicy(h, {
      id: "po_ev" as PolicyId,
      sourceEpisodeIds: ["ep_r" as EpisodeId],
    });

    const long = "a".repeat(1000);
    seedTrace(h, {
      episodeId: "ep_r",
      userText: "[REDACTED]",
      agentText: "[REDACTED]",
      value: 1.0,
    });
    seedTrace(h, {
      id: "tr_long",
      episodeId: "ep_r",
      userText: long,
      agentText: long,
      value: 0.6,
    });

    const r = gatherEvidence(policy, {
      repos: h.repos,
      config: makeSkillConfig({ evidenceLimit: 5, traceCharCap: 120 }),
    });
    expect(r.traces.length).toBe(1);
    expect(r.traces[0]!.trace.userText.length).toBeLessThanOrEqual(121);
    expect(r.traces[0]!.trace.agentText.length).toBeLessThanOrEqual(121);
  });

  it("dedupes duplicate trace content by signature before scoring", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const policy = seedPolicy(h, {
      id: "po_ev" as PolicyId,
      sourceEpisodeIds: ["ep_dup" as EpisodeId],
    });

    const base = {
      episodeId: "ep_dup",
      sessionId: "s_ev",
      userText: "same user question",
      agentText: "same answer",
      value: 0.2,
      ts: NOW,
    };
    seedTrace(h, { id: "tr_dup_a", ...base });
    seedTrace(h, { id: "tr_dup_b", ...base });
    seedTrace(h, {
      id: "tr_unique",
      episodeId: "ep_dup",
      sessionId: "s_ev",
      userText: "high value unique",
      agentText: "best",
      value: 0.95,
    });

    const r = gatherEvidence(policy, {
      repos: h.repos,
      config: makeSkillConfig({ evidenceLimit: 2 }),
    });
    expect(r.poolAfterDedupe).toBe(2);
    expect(r.traces[0]!.trace.id).toBe("tr_unique");
  });

  it("excludes traces from failure-outcome episodes", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const failEp = "ep_fail" as EpisodeId;
    const okEp = "ep_ok" as EpisodeId;
    ensureEpisode(h, failEp, "s_ev");
    ensureEpisode(h, okEp, "s_ev");
    h.repos.episodes.setVerifierPassed(failEp, false);
    h.repos.episodes.setOutcome(failEp, "failure");
    h.repos.episodes.setOutcome(okEp, "success");
    const policy = seedPolicy(h, {
      sourceEpisodeIds: [failEp, okEp],
    });
    seedTrace(h, {
      id: "tr_fail_high_v",
      episodeId: failEp,
      sessionId: "s_ev",
      value: 0.99,
    });
    seedTrace(h, {
      id: "tr_ok",
      episodeId: okEp,
      sessionId: "s_ev",
      value: 0.5,
    });

    const r = gatherEvidence(policy, {
      repos: h.repos,
      config: makeSkillConfig({ evidenceLimit: 4 }),
    });
    expect(r.excludedFailureCount).toBe(1);
    expect(r.traces.map((a) => a.trace.id)).toEqual(["tr_ok"]);
  });

  it("returns empty when the policy has no source episodes", () => {
    const h = open();
    const policy = seedPolicy(h, { sourceEpisodeIds: [] });
    const r = gatherEvidence(policy, {
      repos: h.repos,
      config: makeSkillConfig(),
    });
    expect(r.traces.length).toBe(0);
    expect(r.episodeIds.length).toBe(0);
  });
});

describe("skill/evidence gatherCounterExamples", () => {
  it("prefers V<0 traces inside failure episodes", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const failEp = "ep_fail" as EpisodeId;
    ensureEpisode(h, failEp, "s_ev");
    h.repos.episodes.setOutcome(failEp, "failure");

    const policy = seedPolicy(h, { sourceEpisodeIds: [failEp] });
    seedTrace(h, {
      id: "tr_pretty",
      episodeId: failEp,
      sessionId: "s_ev",
      value: 0.9,
    });
    seedTrace(h, {
      id: "tr_bad",
      episodeId: failEp,
      sessionId: "s_ev",
      value: -0.4,
    });

    const counters = gatherCounterExamples(policy, {
      repos: h.repos,
      config: makeSkillConfig(),
    });
    expect(counters.map((a) => a.trace.id)).toEqual(["tr_bad"]);
  });

  it("when failure cone has no negative V, takes lowest-V traces only", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const failEp = "ep_fail" as EpisodeId;
    ensureEpisode(h, failEp, "s_ev");
    h.repos.episodes.setOutcome(failEp, "failure");

    const policy = seedPolicy(h, { sourceEpisodeIds: [failEp] });
    seedTrace(h, {
      id: "tr_high",
      episodeId: failEp,
      sessionId: "s_ev",
      userText: "high step",
      value: 0.9,
    });
    seedTrace(h, {
      id: "tr_mid",
      episodeId: failEp,
      sessionId: "s_ev",
      userText: "mid step",
      value: 0.5,
    });
    seedTrace(h, {
      id: "tr_low",
      episodeId: failEp,
      sessionId: "s_ev",
      userText: "low step",
      value: 0.2,
    });

    const counters = gatherCounterExamples(policy, {
      repos: h.repos,
      config: makeSkillConfig(),
    });
    expect(counters.map((a) => a.trace.id)).toEqual(["tr_low", "tr_mid", "tr_high"]);
    expect(counters[0]!.trace.id).toBe("tr_low");
    expect(counters[counters.length - 1]!.trace.id).toBe("tr_high");
  });

  it("falls back to global V<0 when no failure outcome is labeled", () => {
    const h = open();
    seedSessionOnly(h, "s_ev");
    const ep = "ep_unk" as EpisodeId;
    ensureEpisode(h, ep, "s_ev");

    const policy = seedPolicy(h, { sourceEpisodeIds: [ep] });
    seedTrace(h, {
      id: "tr_pos",
      episodeId: ep,
      sessionId: "s_ev",
      value: 0.8,
    });
    seedTrace(h, {
      id: "tr_neg",
      episodeId: ep,
      sessionId: "s_ev",
      value: -0.3,
    });

    const counters = gatherCounterExamples(policy, {
      repos: h.repos,
      config: makeSkillConfig(),
    });
    expect(counters.map((a) => a.trace.id)).toEqual(["tr_neg"]);
  });
});
