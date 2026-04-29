import { describe, it, expect } from "vitest";

import {
  crystallizeDraft,
  defaultDraftValidator,
} from "../../../core/skill/crystallize.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { LlmClient, LlmJsonCompletion } from "../../../core/llm/types.js";
import type { PolicyRow, TraceRow } from "../../../core/types.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";
import {
  NOW,
  makeDraft,
  makeSkillConfig,
  vec,
} from "./_helpers.js";

function mkPolicy(): PolicyRow {
  return {
    id: "po_c" as PolicyRow["id"],
    title: "install system libs before pip",
    trigger: "pip install errors on alpine",
    procedure: "1. detect 2. apk add 3. retry",
    verification: "pip install succeeds",
    boundary: "alpine musl",
    support: 3,
    gain: 0.3,
    status: "active",
    sourceEpisodeIds: [],
    inducedBy: "l2.l2.induction.v1",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: vec([1, 0, 0]),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mkTrace(id: string, userText: string): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: "ep_1" as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: NOW,
    userText,
    agentText: "apk add libffi-dev then retry pip install",
    toolCalls: [],
    reflection: "libraries first, then pip",
    value: 0.8,
    alpha: 0.7 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: ["alpine", "pip"],
    vecSummary: vec([1, 0, 0]),
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

const log = rootLogger.child({ channel: "core.skill.crystallize" });

function refusalLlm(raw: string): LlmClient {
  return {
    ...fakeLlm(),
    provider: "anthropic",
    model: "claude-test",
    async completeJson<T>(): Promise<LlmJsonCompletion<T>> {
      return {
        value: makeDraft() as T,
        raw,
        provider: "anthropic",
        model: "claude-test",
        finishReason: "stop",
        servedBy: "anthropic",
        durationMs: 1,
      };
    },
  };
}

describe("skill/crystallize", () => {
  it("normalises the LLM draft into a structured object", async () => {
    const policy = mkPolicy();
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": {
          name: "alpine-pip!!",
          display_title: "Alpine Pip",
          summary: "Install system libs first",
          parameters: [
            { name: "package", type: "string", required: true, description: "pip target" },
            { name: "mode", type: "enum", enum: ["dev", "prod"] },
          ],
          preconditions: ["alpine base"],
          steps: [
            { title: "detect", body: "look at error" },
            { title: "install", body: "apk add libs" },
          ],
          examples: [{ input: "cryptography", expected: "success" }],
          tags: ["alpine", "Alpine", "pip"],
          tools: ["shell", "pip.install"],
        },
      },
    });

    const r = await crystallizeDraft(
      { policy, evidence: [mkTrace("tr_1", "pip fails")], namingSpace: ["other_skill"] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toBe("alpine_pip");
    expect(r.draft.displayTitle).toBe("Alpine Pip");
    expect(r.draft.parameters.length).toBe(2);
    expect(r.draft.parameters[1]!.type).toBe("enum");
    expect(r.draft.parameters[1]!.enumValues).toEqual(["dev", "prod"]);
    expect(r.draft.steps.length).toBe(2);
    expect(r.draft.tags).toEqual(["alpine", "pip"]);
    expect(r.draft.tools).toEqual(["shell", "pip.install"]);
  });

  it("skips when useLlm is false", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkTrace("tr_1", "x")], namingSpace: [] },
      { llm: fakeLlm(), log, config: makeSkillConfig({ useLlm: false }) },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedReason).toBe("llm-disabled");
  });

  it("skips when evidence is empty", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [], namingSpace: [] },
      { llm: fakeLlm(), log, config: makeSkillConfig() },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedReason).toBe("no-evidence");
  });

  it("returns skipped on LLM failure", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkTrace("tr_1", "x")], namingSpace: [] },
      { llm: throwingLlm(new Error("boom")), log, config: makeSkillConfig() },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedReason).toMatch(/^llm-failed:/);
  });

  it("rejects model refusals instead of persisting them as skills", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkTrace("tr_1", "x")], namingSpace: [] },
      {
        llm: refusalLlm("I am Claude, made by Anthropic. I cannot process this request."),
        log,
        config: makeSkillConfig(),
        validate: defaultDraftValidator,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedReason).toBe("llm-refusal");
    expect(r.modelRefusal).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      matchedPrefix: "I am Claude",
    });
    expect(r.modelRefusal?.content).toContain("I cannot process this request");
  });

  it("rejects drafts that the validator flags as invalid", async () => {
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": makeDraft({ steps: [], summary: "" }) as unknown,
      },
    });
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkTrace("tr_1", "x")], namingSpace: [] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(false);
  });
});
