/**
 * V7 §2.5.2 — LLM-driven skill crystallization.
 *
 * Given a policy + its evidence, we call `SKILL_CRYSTALLIZE_PROMPT` to
 * produce a structured draft. The draft is normalised / clamped to avoid
 * surprising the packager if the LLM emits missing or weird fields.
 *
 * We never call the LLM without evidence — if the caller hands us zero
 * traces we fail fast with `skipped_reason="no-evidence"`.
 */

import type { LlmClient } from "../llm/types.js";
import { detectModelRefusal } from "../llm/refusal.js";
import {
  detectDominantLanguage,
  languageSteeringLine,
} from "../llm/prompts/index.js";
import { SKILL_CRYSTALLIZE_PROMPT } from "../llm/prompts/skill-crystallize.js";
import type { Logger } from "../logger/types.js";
import {
  sanitizeDerivedList,
  sanitizeDerivedMarkdown,
  sanitizeDerivedMarkdownList,
  sanitizeDerivedText,
} from "../safety/content.js";
import type { EpisodeId, PolicyRow, SkillRow, TraceRow } from "../types.js";
import { MemosError } from "../../agent-contract/errors.js";
import { extractToolNames } from "./tool-names.js";
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
  evidence: TraceRow[];
  /**
   * Optional negative evidence: traces from the same context that scored
   * V < 0. Surfaced to the LLM as `counter_examples` so it can write
   * concrete `decision_guidance.anti_pattern` lines (V7 §2.4.6 step ⑤
   * "对比 V 分布生成动作偏好"). Caller decides how to mine these — see
   * `core/skill/skill.ts` for the live wiring.
   */
  counterExamples?: TraceRow[];
  /** Names of *non-archived* skills, so the LLM can avoid collisions. */
  namingSpace: string[];
  /**
   * Episode that triggered this crystallization, when known. Forwarded
   * to the LLM call so the resulting `system_model_status` audit row
   * can be grouped with the rest of that episode's pipeline activity in
   * the Logs viewer.
   */
  episodeId?: EpisodeId;
}

export interface CrystallizeDeps {
  llm: LlmClient | null;
  log: Logger;
  config: SkillConfig;
  /** Optional structural validator, allows tests to inject extra rules. */
  validate?: (draft: SkillCrystallizationDraft) => void;
}

export type CrystallizeResult =
  | { ok: true; draft: SkillCrystallizationDraft }
  | { ok: false; skippedReason: string; modelRefusal?: SkillModelRefusalDetails };

/**
 * Run one crystallization call and return a normalised draft.
 */
export async function crystallizeDraft(
  input: CrystallizeInput,
  deps: CrystallizeDeps,
): Promise<CrystallizeResult> {
  const { llm, log, config } = deps;

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

  const userPayload = packPrompt(input, config);

  // Detect the language of the evidence so the crystallised skill's
  // human-facing fields (display_title, summary, preconditions, steps,
  // examples) come out in the same language the user was using. The
  // `name` slug stays snake_case regardless — enforced by `sanitiseName`.
  const evidenceLang = detectDominantLanguage([
    input.policy.title,
    input.policy.trigger,
    input.policy.procedure,
    ...input.evidence.flatMap((t) => [t.userText, t.agentText, t.reflection]),
  ]);

  try {
    const rsp = await llm.completeJson<Record<string, unknown>>(
      [
        { role: "system", content: SKILL_CRYSTALLIZE_PROMPT.system },
        { role: "system", content: languageSteeringLine(evidenceLang) },
        { role: "user", content: userPayload },
      ],
      {
        op: "skill.crystallize",
        phase: "skill",
        episodeId: input.episodeId,
        schemaHint: "skill-crystallize.v2",
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
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    const draft = normaliseDraft(rsp.value, input);
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
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    if (deps.validate) deps.validate(draft);
    return { ok: true, draft };
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
        error: message,
        ...modelRefusal,
      });
      return { ok: false, skippedReason: "llm-refusal", modelRefusal };
    }
    log.error("skill.crystallize.failed", { policyId: input.policy.id, error: message });
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

/**
 * Produce a deterministic JSON payload for the LLM.
 *
 * V7 §2.4.6: surface the policy's structured `decisionGuidance` as a
 * separate `repair_hints` field so the prompt schema is unambiguous —
 * the LLM never sees our internal storage shape, and the boundary text
 * stays a clean human-readable scope description.
 *
 * `counter_examples` are evidence rows with V < 0 — caller-provided
 * (see `core/skill/skill.ts::gatherCounterExamples`); the prompt
 * marks them optional so it's fine to omit.
 */
function packPrompt(input: CrystallizeInput, config: SkillConfig): string {
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

  const evidence = input.evidence.slice(0, config.evidenceLimit).map((t) => ({
    id: t.id,
    episodeId: t.episodeId,
    reflection: t.reflection,
    user: capString(t.userText, config.traceCharCap),
    agent: capString(t.agentText, config.traceCharCap),
    value: Number.isFinite(t.value) ? t.value : 0,
    alpha: typeof t.alpha === "number" ? t.alpha : null,
    tags: t.tags,
  }));

  const counterExamples = (input.counterExamples ?? [])
    .slice(0, Math.max(0, config.evidenceLimit))
    .map((t) => ({
      id: t.id,
      episodeId: t.episodeId,
      reflection: t.reflection,
      user: capString(t.userText, config.traceCharCap),
      agent: capString(t.agentText, config.traceCharCap),
      value: Number.isFinite(t.value) ? t.value : 0,
      tags: t.tags,
    }));

  const evidenceTools = Array.from(extractToolNames(input.evidence));

  const payload: Record<string, unknown> = {
    policy,
    evidence,
    evidence_tools: evidenceTools,
    naming_space: input.namingSpace,
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
  return JSON.stringify(payload);
}

/**
 * Clamp + shape-guard the LLM response. We intentionally never throw on
 * missing fields — the caller's validator decides whether a draft is good
 * enough to persist.
 */
function normaliseDraft(
  raw: Record<string, unknown>,
  input: CrystallizeInput,
): SkillCrystallizationDraft {
  const rawName = String(raw.name ?? "").trim();
  const name = sanitiseName(rawName || `skill_${input.policy.id.slice(-6)}`);
  const displayTitle =
    sanitizeDerivedText(raw.display_title ?? raw.displayTitle ?? input.policy.title ?? name) ||
    name;
  const summary = sanitizeDerivedText(raw.summary);

  const parameters = asArray(raw.parameters).map(coerceParameter).filter(Boolean) as SkillParameterDraft[];
  const preconditions = sanitizeDerivedMarkdownList(asStringArray(raw.preconditions));
  const steps = asArray(raw.steps).map(coerceStep).filter(Boolean) as SkillStepDraft[];
  const examples = asArray(raw.examples).map(coerceExample).filter(Boolean) as SkillExampleDraft[];
  const tags = dedupeLc(sanitizeDerivedList(asStringArray(raw.tags)));
  // V7 §2.4.6 — coerce both `decision_guidance` (preferred LLM key)
  // and `decisionGuidance` (camelCase fallback). Caps at 5 entries each
  // to keep the skill body skim-able and the prompt budget bounded.
  const decisionGuidance = coerceDecisionGuidance(raw.decision_guidance ?? raw.decisionGuidance);

  const tools = dedupeLc(sanitizeDerivedList(asStringArray(raw.tools)));

  return {
    name,
    displayTitle,
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

function sanitiseName(raw: string): string {
  const lower = raw.toLowerCase();
  const out = lower
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return out.length > 0 ? out : "skill";
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

/**
 * A sensible default validator used both in production and in tests.
 * Throws if the draft is structurally unusable (no name, no steps, no summary).
 */
export function defaultDraftValidator(draft: SkillCrystallizationDraft): void {
  if (!draft.name) throw new Error("skill.crystallize.invalid: missing name");
  if (!draft.summary) throw new Error("skill.crystallize.invalid: missing summary");
  if (draft.steps.length === 0)
    throw new Error("skill.crystallize.invalid: missing steps");
}
