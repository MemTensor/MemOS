/**
 * V7 §2.5.2 — LLM-driven skill crystallization.
 */

import type { LlmClient } from "../llm/types.js";
import { detectModelRefusal } from "../llm/refusal.js";
import {
  languageSteeringLine,
} from "../llm/prompts/index.js";
import { SKILL_CRYSTALLIZE_PROMPT } from "../llm/prompts/skill-crystallize.js";
import { SKILL_REBUILD_PROMPT } from "../llm/prompts/skill-rebuild.js";
import { reflectionAsText } from "../capture/types.js";
import type { Logger } from "../logger/types.js";
import {
  sanitizeDerivedList,
  sanitizeDerivedMarkdown,
  sanitizeDerivedMarkdownList,
  sanitizeDerivedText,
} from "../safety/content.js";
import type { EpisodeId, PolicyRow, SkillRow } from "../types.js";
import type { AnnotatedTrace } from "./evidence.js";
import { MemosError } from "../../agent-contract/errors.js";
import { extractToolNames } from "./tool-names.js";
import { existingSkillSnapshot } from "./merge.js";
import type { RebuildLevel } from "./rebuild-level.js";
import { procedureFromSkillRow } from "./merge.js";
import { normalizeSkillName } from "./name.js";
import type { SkillOutputLanguage } from "./language.js";
import type {
  SkillModelRefusalDetails,
  SkillConfig,
  SkillCrystallizationDraft,
  SkillExampleDraft,
  SkillParameterDraft,
  SkillStepDraft,
} from "./types.js";

export interface CrystallizeInput {
  policy: PolicyRow;
  evidence: AnnotatedTrace[];
  counterExamples?: AnnotatedTrace[];
  namingSpace: string[];
  episodeId?: EpisodeId;
  mode?: "crystallize" | "rebuild";
  existingSkill?: SkillRow | null;
  incrementalEvidence?: AnnotatedTrace[];
  rebuildLevel?: RebuildLevel;
  outputLanguage?: SkillOutputLanguage;
  renameAllowed?: boolean;
}

export interface CrystallizeDeps {
  llm: LlmClient | null;
  log: Logger;
  config: SkillConfig;
  validate?: (draft: SkillCrystallizationDraft) => void;
}

export type CrystallizeResult =
  | { ok: true; draft: SkillCrystallizationDraft; changedSections?: string[] }
  | { ok: false; skippedReason: string; modelRefusal?: SkillModelRefusalDetails };

export async function crystallizeDraft(
  input: CrystallizeInput,
  deps: CrystallizeDeps,
): Promise<CrystallizeResult> {
  const { llm, log, config } = deps;
  const mode = input.mode ?? "crystallize";

  if (input.evidence.length === 0) {
    log.warn("skill.crystallize.skip", {
      policyId: input.policy.id,
      reason: "no-evidence",
    });
    return { ok: false, skippedReason: "no-evidence" };
  }

  if (!config.useLlm || !llm) {
    const reason = !config.useLlm
      ? "useLlm disabled in config"
      : "llm client is null (provider not attached?)";
    log.warn("skill.crystallize.llm_unavailable", {
      policyId: input.policy.id,
      reason,
      fallback: "skipped",
    });
    return { ok: false, skippedReason: "llm-disabled" };
  }

  const promptDef =
    mode === "rebuild" ? SKILL_REBUILD_PROMPT : SKILL_CRYSTALLIZE_PROMPT;
  const userPayload = packPrompt(input, config, mode);

  const outputLanguage = input.outputLanguage ?? "en";

  try {
    const rsp = await llm.completeJson<Record<string, unknown>>(
      [
        { role: "system", content: promptDef.system },
        { role: "system", content: languageSteeringLine(outputLanguage) },
        { role: "user", content: userPayload },
      ],
      {
        op: mode === "rebuild" ? "skill.rebuild" : "skill.crystallize",
        phase: "skill",
        episodeId: input.episodeId,
        schemaHint:
          mode === "rebuild" ? "skill-rebuild.v3" : "skill-crystallize.v6",
      },
    );
    const rawRefusal = detectModelRefusal(rsp.raw);
    if (rawRefusal) {
      const modelRefusal = {
        provider: rsp.provider,
        model: rsp.model,
        servedBy: rsp.servedBy,
        ...rawRefusal,
      };
      log.error("skill.crystallize.model_refusal", {
        policyId: input.policy.id,
        mode,
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    const draft = normaliseDraft(rsp.value, input);
    const changedSections = asStringArray(
      rsp.value.changed_sections ?? rsp.value.changedSections,
    );
    const draftRefusal = detectModelRefusal(draft);
    if (draftRefusal) {
      const modelRefusal = {
        provider: rsp.provider,
        model: rsp.model,
        servedBy: rsp.servedBy,
        ...draftRefusal,
      };
      log.error("skill.crystallize.model_refusal", {
        policyId: input.policy.id,
        mode,
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    if (deps.validate) deps.validate(draft);
    return {
      ok: true,
      draft,
      changedSections: changedSections.length > 0 ? changedSections : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rawPreview = rawPreviewFromError(err);
    const refusal = rawPreview ? detectModelRefusal(rawPreview) : null;
    if (refusal) {
      const modelRefusal = {
        provider: providerFromError(err) ?? llm.provider,
        model: llm.model,
        servedBy: llm.provider,
        ...refusal,
      };
      log.error("skill.crystallize.model_refusal", {
        policyId: input.policy.id,
        mode,
        error: message,
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    log.error("skill.crystallize.failed", { policyId: input.policy.id, mode, error: message });
    return { ok: false, skippedReason: `llm-failed: ${message}` };
  }
}

function rawPreviewFromError(err: unknown): string | null {
  if (err instanceof MemosError && typeof err.details?.rawPreview === "string") {
    return err.details.rawPreview;
  }
  return null;
}

function providerFromError(err: unknown): string | null {
  if (err instanceof MemosError && typeof err.details?.provider === "string") {
    return err.details.provider;
  }
  return null;
}

function packPrompt(
  input: CrystallizeInput,
  config: SkillConfig,
  mode: "crystallize" | "rebuild",
): string {
  const repairHints = input.policy.decisionGuidance;

  const policy = {
    id: input.policy.id,
    title: input.policy.title,
    trigger: input.policy.trigger,
    procedure: input.policy.procedure,
    verification: input.policy.verification,
    boundary: input.policy.boundary,
    support: input.policy.support,
    gain: input.policy.gain,
  };

  const mapTrace = (a: AnnotatedTrace) => ({
    id: a.trace.id,
    episodeId: a.trace.episodeId,
    reflection: reflectionAsText(a.trace.reflection),
    user: capString(a.trace.userText, config.traceCharCap),
    agent: capString(a.trace.agentText, config.traceCharCap),
    value: Number.isFinite(a.trace.value) ? a.trace.value : 0,
    alpha: typeof a.trace.alpha === "number" ? a.trace.alpha : null,
    tags: a.trace.tags,
    episode_outcome: a.episodeOutcome,
    episode_r_task: a.episodeRTask,
  });

  const evidence = input.evidence.slice(0, config.evidenceLimit).map(mapTrace);

  const counterExamples = (input.counterExamples ?? [])
    .slice(0, Math.max(0, config.evidenceLimit))
    .map(mapTrace);

  const incremental = (input.incrementalEvidence ?? [])
    .slice(0, config.evidenceLimit)
    .map(mapTrace);

  const evidenceTools = Array.from(
    extractToolNames([
      ...input.evidence.map((a) => a.trace),
      ...(input.incrementalEvidence ?? []).map((a) => a.trace),
    ]),
  );

  const payload: Record<string, unknown> = {
    policy,
    evidence,
    evidence_tools: evidenceTools,
    naming_space: input.namingSpace,
    output_language: input.outputLanguage ?? "en",
  };
  if (counterExamples.length > 0) payload.counter_examples = counterExamples;
  if (
    repairHints.preference.length > 0 ||
    repairHints.antiPattern.length > 0
  ) {
    payload.repair_hints = {
      preference: repairHints.preference,
      antiPattern: repairHints.antiPattern,
    };
  }

  if (mode === "rebuild" && input.existingSkill) {
    const proc = procedureFromSkillRow(input.existingSkill.procedureJson);
    payload.existing_skill_snapshot = existingSkillSnapshot(
      proc,
      input.existingSkill.name,
    );
    payload.rebuild_level = input.rebuildLevel ?? "L1";
    payload.repair_rename_allowed = Boolean(input.renameAllowed);
    if (incremental.length > 0) payload.incremental_evidence = incremental;
  }

  return JSON.stringify(payload);
}

function normaliseDraft(
  raw: Record<string, unknown>,
  input: CrystallizeInput,
): SkillCrystallizationDraft {
  // §12 A — first L2 rebuild of a repair-origin skill is allowed to rename;
  // every other rebuild keeps the existing name verbatim. The orchestrator
  // sets `renameAllowed=true` only when that single-use gate fires, so we
  // honour the LLM-generated `name` exactly when it does.
  const lockName =
    input.mode === "rebuild" && input.existingSkill && !input.renameAllowed
      ? input.existingSkill.name
      : null;
  const rawName = String(raw.name ?? "").trim();
  // Empty-rawName fallback: only reuse the existing skill name during a
  // rename-allowed rebuild (LLM declined the rename → keep current name).
  // Crystallize mode may receive an *archived* existingSkill from
  // eligibility; reusing that name would collide with the
  // (owner, name) UNIQUE index, so we always mint a fresh id-based slug
  // there.
  const emptyFallback =
    input.mode === "rebuild" && input.renameAllowed && input.existingSkill
      ? input.existingSkill.name
      : `skill_${input.policy.id.slice(-6)}`;
  const name = lockName ?? normalizeSkillName(rawName || emptyFallback);
  const retrievalBlurb = sanitizeDerivedMarkdown(
    raw.retrieval_blurb ?? raw.retrievalBlurb ?? "",
  );
  const triggerContext = sanitizeDerivedText(
    raw.trigger_context ?? raw.triggerContext ?? "",
  );
  const summary = sanitizeDerivedText(raw.summary);

  const parameters = asArray(raw.parameters).map(coerceParameter).filter(Boolean) as SkillParameterDraft[];
  const preconditions = sanitizeDerivedMarkdownList(asStringArray(raw.preconditions));
  const steps = asArray(raw.steps).map(coerceStep).filter(Boolean) as SkillStepDraft[];
  const examples = asArray(raw.examples).map(coerceExample).filter(Boolean) as SkillExampleDraft[];
  const tags = dedupeLc(sanitizeDerivedList(asStringArray(raw.tags)));
  const decisionGuidance = coerceDecisionGuidance(raw.decision_guidance ?? raw.decisionGuidance);
  const tools = dedupeLc(sanitizeDerivedList(asStringArray(raw.tools)));

  return {
    name,
    retrievalBlurb,
    triggerContext,
    summary,
    parameters,
    preconditions,
    steps,
    examples,
    tags,
    decisionGuidance,
    tools,
  };
}

function coerceDecisionGuidance(raw: unknown): {
  preference: string[];
  antiPattern: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { preference: [], antiPattern: [] };
  }
  const o = raw as Record<string, unknown>;
  const pref = dedupeLc(sanitizeDerivedMarkdownList(asStringArray(o.preference))).slice(0, 5);
  const anti = dedupeLc(
    sanitizeDerivedMarkdownList(asStringArray(o.anti_pattern ?? o.antiPattern)),
  ).slice(0, 5);
  return { preference: pref, antiPattern: anti };
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

function asStringArray(x: unknown): string[] {
  return asArray(x).map((v) => String(v).trim()).filter((s) => s.length > 0);
}

function dedupeLc(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function coerceParameter(x: unknown): SkillParameterDraft | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const name = sanitizeDerivedText(o.name);
  if (!name) return null;
  const t = String(o.type ?? "string").toLowerCase() as SkillParameterDraft["type"];
  const allowed = new Set(["string", "number", "boolean", "enum"]);
  const type = (allowed.has(t) ? t : "string") as SkillParameterDraft["type"];
  const out: SkillParameterDraft = {
    name,
    type,
    required: Boolean(o.required ?? false),
    description: sanitizeDerivedMarkdown(o.description),
  };
  if (type === "enum") {
    out.enumValues = sanitizeDerivedMarkdownList(asStringArray(o.enum));
  }
  return out;
}

function coerceStep(x: unknown): SkillStepDraft | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const title = sanitizeDerivedText(o.title);
  const body = sanitizeDerivedMarkdown(o.body);
  if (!title && !body) return null;
  return { title: title || body.slice(0, 32), body };
}

function coerceExample(x: unknown): SkillExampleDraft | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const input = sanitizeDerivedMarkdown(o.input);
  const expected = sanitizeDerivedMarkdown(o.expected);
  if (!input && !expected) return null;
  return { input, expected };
}

function capString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "…";
}

export function defaultDraftValidator(draft: SkillCrystallizationDraft): void {
  if (!draft.name) throw new Error("skill.crystallize.invalid: missing name");
  if (!draft.summary) throw new Error("skill.crystallize.invalid: missing summary");
  if (!draft.retrievalBlurb) {
    throw new Error("skill.crystallize.invalid: missing retrieval_blurb");
  }
  if (draft.steps.length === 0)
    throw new Error("skill.crystallize.invalid: missing steps");
}
