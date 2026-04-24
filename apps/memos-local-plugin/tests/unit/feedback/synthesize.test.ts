import { describe, it, expect } from "vitest";

import { synthesizeDraft } from "../../../core/feedback/synthesize.js";
import { rootLogger } from "../../../core/logger/index.js";
import type {
  EpisodeId,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../core/types.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";
import { makeFeedbackConfig, vec } from "./_helpers.js";

const NOW = 1_700_000_000_000;

function trace(args: {
  id?: string;
  value: number;
  agentText?: string;
  userText?: string;
  reflection?: string;
}): TraceRow {
  return {
    id: (args.id ?? `t_${Math.random().toString(36).slice(2, 8)}`) as TraceId,
    episodeId: "ep1" as EpisodeId,
    sessionId: "s1" as SessionId,
    ts: NOW as TraceRow["ts"],
    userText: args.userText ?? "",
    agentText: args.agentText ?? "",
    toolCalls: [],
    reflection: args.reflection ?? null,
    value: args.value,
    alpha: 0.6 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

function policy(id: string): PolicyRow {
  return {
    id: id as PolicyId,
    title: "policy",
    trigger: "",
    procedure: "",
    verification: "",
    boundary: "",
    support: 3,
    gain: 0.3,
    status: "active" as PolicyRow["status"],
    sourceEpisodeIds: [],
    inducedBy: "l2.l2.induction.v1",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: vec([1, 0, 0]),
    createdAt: NOW as PolicyRow["createdAt"],
    updatedAt: NOW as PolicyRow["updatedAt"],
  };
}

describe("feedback/synthesize", () => {
  it("returns insufficient-evidence when both lists are empty", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "user.negative",
        contextHash: "ctx",
        highValue: [],
        lowValue: [],
      },
      {
        llm: null,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: false }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient-evidence");
  });

  it("template fallback crafts prefer/avoid from evidence extremes when LLM is disabled", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "failure-burst",
        contextHash: "ctx1",
        highValue: [
          trace({
            value: 0.9,
            reflection: "apk add openssl-dev before pip",
          }),
        ],
        lowValue: [
          trace({ value: -0.8, agentText: "pip install cryptography failed" }),
        ],
        candidatePolicies: [policy("p1"), policy("p2")],
      },
      {
        llm: null,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: false }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.preference).toContain("apk add openssl-dev");
    expect(r.draft.antiPattern).toContain("pip install cryptography failed");
    expect(r.draft.severity).toBe("warn");
    expect(r.draft.attachToPolicyIds).toEqual(["p1", "p2"]);
    expect(r.draft.highValueTraceIds).toHaveLength(1);
    expect(r.draft.lowValueTraceIds).toHaveLength(1);
  });

  it("template uses classifier prefer/avoid when present", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "user.preference",
        contextHash: "ctx2",
        highValue: [trace({ value: 0.5, agentText: "boring success" })],
        lowValue: [trace({ value: -0.4, agentText: "boring failure" })],
        classifiedFeedback: {
          shape: "preference",
          confidence: 0.8,
          prefer: "uv",
          avoid: "pip",
          text: "use uv instead of pip",
        },
      },
      {
        llm: null,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: false }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.preference).toContain("uv");
    expect(r.draft.antiPattern).toContain("pip");
    expect(r.draft.confidence).toBeCloseTo(0.8, 5);
  });

  it("calls the LLM and uses its response when useLlm is true", async () => {
    const llm = fakeLlm({
      completeJson: {
        "decision.repair": {
          preference: "Pre-install openssl-dev with apk before pip",
          anti_pattern: "Running pip install cryptography on bare alpine",
          severity: "warn",
          confidence: 0.85,
        },
      },
    });

    const r = await synthesizeDraft(
      {
        trigger: "failure-burst",
        contextHash: "ctx3",
        highValue: [
          trace({ value: 0.8, agentText: "apk add openssl-dev; pip install cryptography" }),
        ],
        lowValue: [
          trace({ value: -0.6, agentText: "pip install cryptography fails on alpine" }),
        ],
      },
      {
        llm,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: true }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.preference).toMatch(/openssl-dev/);
    expect(r.draft.antiPattern).toMatch(/alpine/);
    expect(r.draft.severity).toBe("warn");
    expect(r.draft.confidence).toBeCloseTo(0.85, 5);
  });

  it("clamps LLM confidence to [0,1]", async () => {
    const llm = fakeLlm({
      completeJson: {
        "decision.repair": {
          preference: "p",
          anti_pattern: "a",
          severity: "info",
          confidence: 2.3,
        },
      },
    });
    const r = await synthesizeDraft(
      {
        trigger: "manual",
        contextHash: "ctx4",
        highValue: [trace({ value: 0.5 })],
        lowValue: [trace({ value: -0.5 })],
      },
      {
        llm,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: true }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.confidence).toBe(1);
  });

  it("falls back to template on LLM schema violations", async () => {
    const llm = fakeLlm({
      completeJson: {
        "decision.repair": { not: "valid" },
      },
    });
    const r = await synthesizeDraft(
      {
        trigger: "manual",
        contextHash: "ctx5",
        highValue: [trace({ value: 0.7, reflection: "use A" })],
        lowValue: [trace({ value: -0.7, reflection: "avoid B" })],
      },
      {
        llm,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: true }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.preference).toContain("use A");
    expect(r.draft.antiPattern).toContain("avoid B");
  });

  it("falls back to template on LLM transport failure", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "manual",
        contextHash: "ctx6",
        highValue: [trace({ value: 0.7, reflection: "ok" })],
        lowValue: [trace({ value: -0.7, reflection: "bad" })],
      },
      {
        llm: throwingLlm(new Error("boom")),
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: true }),
      },
    );
    expect(r.ok).toBe(true);
  });

  it("returns llm-failed when the LLM fails and no evidence provides fallback text", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "manual",
        contextHash: "ctx7",
        // Evidence has neither reflection nor agentText → fallback template
        // cannot derive a preference / anti-pattern line, so the orchestrator
        // must surface the LLM failure.
        highValue: [trace({ value: 0.3 })],
        lowValue: [trace({ value: -0.3 })],
      },
      {
        llm: throwingLlm(new Error("boom")),
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: true }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("llm-failed");
  });

  it("dedupes policy ids from candidatePolicies", async () => {
    const r = await synthesizeDraft(
      {
        trigger: "user.negative",
        contextHash: "ctx8",
        highValue: [trace({ value: 0.5, agentText: "x" })],
        lowValue: [trace({ value: -0.5, agentText: "y" })],
        candidatePolicies: [policy("p1"), policy("p2"), policy("p1")],
      },
      {
        llm: null,
        log: rootLogger.child({ channel: "test.synth" }),
        config: makeFeedbackConfig({ useLlm: false }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.attachToPolicyIds).toEqual(["p1", "p2"]);
  });
});
