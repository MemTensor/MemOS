import { describe, it, expect, afterEach } from "vitest";

import { gatherEvidence } from "../../../core/skill/evidence.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { EpisodeId, PolicyId } from "../../../core/types.js";
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
    expect(r.traces[0]!.id).toBe(aligned.id);
    expect(r.traces[1]!.id).toBe(weak.id);
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
    expect(r.traces[0]!.userText.length).toBeLessThanOrEqual(121);
    expect(r.traces[0]!.agentText.length).toBeLessThanOrEqual(121);
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
