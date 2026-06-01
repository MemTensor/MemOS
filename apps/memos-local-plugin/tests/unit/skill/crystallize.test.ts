import { describe, it, expect } from "vitest";

import {
  crystallizeDraft,
  defaultDraftValidator,
} from "../../../core/skill/crystallize.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { LlmClient, LlmJsonCompletion } from "../../../core/llm/types.js";
import type { AnnotatedTrace } from "../../../core/skill/evidence.js";
import type { PolicyRow, SkillRow, TraceRow } from "../../../core/types.js";
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

function mkAnnotated(id: string, userText: string): AnnotatedTrace {
  return {
    trace: mkTrace(id, userText),
    episodeOutcome: "success",
    episodeRTask: 0.8,
    episodeVerifierPassed: true,
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
          retrieval_blurb: "pip install fails on alpine, missing libffi",
          trigger_context: "Use when alpine pip install hits missing shared libs.",
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
      { policy, evidence: [mkAnnotated("tr_1", "pip fails")], namingSpace: ["other_skill"] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toBe("alpine_pip_apply");
    expect(r.draft.triggerContext).toContain("alpine");
    expect(r.draft.parameters.length).toBe(2);
    expect(r.draft.parameters[1]!.type).toBe("enum");
    expect(r.draft.parameters[1]!.enumValues).toEqual(["dev", "prod"]);
    expect(r.draft.steps.length).toBe(2);
    expect(r.draft.tags).toEqual(["alpine", "pip"]);
    expect(r.draft.tools).toEqual(["shell", "pip.install"]);
  });

  it("cleans unsafe markup from LLM-derived skill fields", async () => {
    const policy = mkPolicy();
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": {
          name: "unsafe-skill",
          trigger_context: "<img src=x onerror=alert(1)> Alpine Pip",
          retrieval_blurb: "alpine pip install cryptography errors",
          summary: "<script>alert(1)</script>Use [docs](javascript:alert(1))",
          parameters: [
            {
              name: "package",
              type: "string",
              required: true,
              description: "<b>pip target</b>",
            },
          ],
          preconditions: ["<svg onload=alert(1)>alpine base"],
          steps: [
            {
              title: "<b>detect</b>",
              body: "Use [safe](https://example.com) not [bad](javascript:alert(1))",
            },
          ],
          examples: [{ input: "<script>alert(1)</script>cryptography", expected: "<b>success</b>" }],
          tags: ["alpine"],
          tools: ["shell"],
          decision_guidance: {
            preference: ["<script>alert(1)</script>install libs first"],
            anti_pattern: ["[bad](javascript:alert(1))"],
          },
        },
      },
    });

    const r = await crystallizeDraft(
      { policy, evidence: [mkAnnotated("tr_1", "pip fails")], namingSpace: [] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const combined = [
      r.draft.triggerContext,
      r.draft.summary,
      r.draft.parameters[0]?.description,
      ...r.draft.preconditions,
      ...r.draft.steps.flatMap((s) => [s.title, s.body]),
      ...r.draft.examples.flatMap((e) => [e.input, e.expected]),
      ...r.draft.decisionGuidance.preference,
      ...r.draft.decisionGuidance.antiPattern,
    ].join("\n");
    expect(combined).not.toMatch(/<script|<img|<svg|javascript:/i);
    expect(r.draft.triggerContext).toBe("Alpine Pip");
    expect(r.draft.parameters[0]!.description).toBe("<b>pip target</b>");
    expect(r.draft.examples[0]!.expected).toBe("<b>success</b>");
    expect(r.draft.steps[0]!.body).toContain("[safe](https://example.com)");
    expect(r.draft.steps[0]!.body).toContain("bad");
  });

  it("skips when useLlm is false", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkAnnotated("tr_1", "x")], namingSpace: [] },
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
      { policy: mkPolicy(), evidence: [mkAnnotated("tr_1", "x")], namingSpace: [] },
      { llm: throwingLlm(new Error("boom")), log, config: makeSkillConfig() },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedReason).toMatch(/^llm-failed:/);
  });

  it("rejects model refusals instead of persisting them as skills", async () => {
    const r = await crystallizeDraft(
      { policy: mkPolicy(), evidence: [mkAnnotated("tr_1", "x")], namingSpace: [] },
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
      { policy: mkPolicy(), evidence: [mkAnnotated("tr_1", "x")], namingSpace: [] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(false);
  });

  it("honours the LLM-generated name when renameAllowed is true (repair graduation, §12 A)", async () => {
    const policy = mkPolicy();
    const existing: SkillRow = {
      id: "sk_repair_old" as SkillRow["id"],
      name: "repair_wrapper_path_kx48x",
      status: "candidate",
      invocationGuide: "",
      procedureJson: null,
      eta: 0.1,
      support: 1,
      gain: 0.3,
      trialsAttempted: 0,
      trialsPassed: 0,
      sourcePolicyIds: ["po_c" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      repairOrigin: true,
    } as SkillRow;
    const llm = fakeLlm({
      completeJson: {
        "skill.rebuild": {
          name: "alpine_pip_install_apply",
          retrieval_blurb: "pip install fails on alpine, missing libffi",
          summary: "Install system libs first",
          steps: [{ title: "detect", body: "look at error" }],
          tools: ["shell"],
          changed_sections: ["retrieval_blurb", "summary", "steps"],
        },
      },
    });
    const r = await crystallizeDraft(
      {
        policy,
        evidence: [mkAnnotated("tr_g1", "pip fails on alpine")],
        namingSpace: [existing.name],
        mode: "rebuild",
        existingSkill: existing,
        rebuildLevel: "L2",
        renameAllowed: true,
      },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toBe("alpine_pip_install_apply");
    expect(r.draft.name).not.toBe(existing.name);
  });

  it("locks the existing name when renameAllowed is false (normal rebuild)", async () => {
    const policy = mkPolicy();
    const existing: SkillRow = {
      id: "sk_locked" as SkillRow["id"],
      name: "alpine_pip_apply",
      status: "active",
      invocationGuide: "",
      procedureJson: null,
      eta: 0.6,
      support: 3,
      gain: 0.3,
      trialsAttempted: 4,
      trialsPassed: 3,
      sourcePolicyIds: ["po_c" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    } as SkillRow;
    const llm = fakeLlm({
      completeJson: {
        "skill.rebuild": {
          name: "something_totally_different",
          retrieval_blurb: "pip install fails on alpine",
          summary: "Install system libs first",
          steps: [{ title: "detect", body: "look at error" }],
          tools: ["shell"],
        },
      },
    });
    const r = await crystallizeDraft(
      {
        policy,
        evidence: [mkAnnotated("tr_lk", "pip fails")],
        namingSpace: [existing.name],
        mode: "rebuild",
        existingSkill: existing,
        rebuildLevel: "L1",
        renameAllowed: false,
      },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toBe(existing.name);
  });

  it("falls back to existing name (not skill_<id>) when LLM omits name in rename-allowed rebuild", async () => {
    const policy = mkPolicy();
    const existing: SkillRow = {
      id: "sk_silent_llm" as SkillRow["id"],
      name: "repair_old_name_kx48x",
      status: "candidate",
      invocationGuide: "",
      procedureJson: null,
      eta: 0.1,
      support: 1,
      gain: 0.3,
      trialsAttempted: 0,
      trialsPassed: 0,
      sourcePolicyIds: ["po_c" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      repairOrigin: true,
    } as SkillRow;
    const llm = fakeLlm({
      completeJson: {
        "skill.rebuild": {
          name: "",
          retrieval_blurb: "fallback test",
          summary: "fallback summary",
          steps: [{ title: "x", body: "y" }],
          tools: [],
        },
      },
    });
    const r = await crystallizeDraft(
      {
        policy,
        evidence: [mkAnnotated("tr_f1", "x")],
        namingSpace: [existing.name],
        mode: "rebuild",
        existingSkill: existing,
        rebuildLevel: "L2",
        renameAllowed: true,
      },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // LLM declined to rename → keep existing name, NOT mint a fresh skill_<id>.
    expect(r.draft.name).toBe("repair_old_name_kx48x");
    expect(r.draft.name).not.toMatch(/^skill_/);
  });

  it("never reuses an archived existing-skill name in crystallize mode (unique-constraint safety)", async () => {
    const policy = mkPolicy();
    const archived: SkillRow = {
      id: "sk_archived" as SkillRow["id"],
      name: "archived_pip_apply",
      status: "archived",
      invocationGuide: "",
      procedureJson: null,
      eta: 0,
      support: 1,
      gain: 0.1,
      trialsAttempted: 3,
      trialsPassed: 0,
      sourcePolicyIds: ["po_c" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    } as SkillRow;
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": {
          name: "",
          retrieval_blurb: "x",
          summary: "y",
          steps: [{ title: "z", body: "w" }],
          tools: [],
        },
      },
    });
    const r = await crystallizeDraft(
      {
        policy,
        evidence: [mkAnnotated("tr_a1", "x")],
        namingSpace: [],
        mode: "crystallize",
        existingSkill: archived,
      },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Must NOT reuse the archived skill's name (would collide with the
    // (owner, name) UNIQUE index in `skills`).
    expect(r.draft.name).not.toBe(archived.name);
    expect(r.draft.name).toMatch(/^skill_/);
  });

  it("clamps long LLM names down to <=48 chars while preserving the skeleton", async () => {
    const policy = mkPolicy();
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": {
          name: "alpine_pip_install_cryptography_with_openssl_libffi_devheaders_apply",
          retrieval_blurb: "alpine pip install fails on cryptography",
          summary: "Install system libs first then retry pip install",
          steps: [{ title: "detect", body: "inspect error" }],
          tools: ["shell"],
        },
      },
    });
    const r = await crystallizeDraft(
      { policy, evidence: [mkAnnotated("tr_long", "pip fails")], namingSpace: [] },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name.length).toBeLessThanOrEqual(48);
    expect(r.draft.name).toMatch(/^[a-z0-9_]+$/);
    // skeleton: domain_..._action — both ends survive truncation.
    expect(r.draft.name.startsWith("alpine_")).toBe(true);
    expect(r.draft.name.endsWith("_apply")).toBe(true);
  });

  it("keeps name snake_case even when zh output is requested", async () => {
    const policy = mkPolicy();
    const llm = fakeLlm({
      completeJson: {
        "skill.crystallize": {
          name: "修复补丁流程",
          retrieval_blurb: "当补丁无法应用时使用",
          trigger_context: "当用户要求修复补丁失败问题时",
          summary: "该流程用于稳定修复补丁应用失败问题",
          steps: [{ title: "检查补丁", body: "确认补丁上下文和目标文件" }],
          tools: ["shell"],
        },
      },
    });

    const r = await crystallizeDraft(
      {
        policy,
        evidence: [mkAnnotated("tr_zh_1", "补丁无法应用，帮我修复")],
        namingSpace: [],
        outputLanguage: "zh",
      },
      { llm, log, config: makeSkillConfig(), validate: defaultDraftValidator },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toMatch(/^[a-z0-9_]+$/);
  });
});
