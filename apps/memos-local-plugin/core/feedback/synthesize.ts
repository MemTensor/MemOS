/**
 * V7 §2.4.6 — synthesize a `DecisionRepairDraft` from evidence + trigger.
 *
 * Two paths:
 *
 *   - `useLlm === true` + `llm` provided: call `decision.repair` prompt
 *     for a polished `{preference, anti_pattern, severity, confidence}`
 *     block grounded in the evidence.
 *   - `useLlm === false` OR the LLM fails: fall back to a deterministic
 *     template that picks the highest-value trace for `preference` and the
 *     lowest-value trace for `anti_pattern`. The template is intentionally
 *     blunt — it's better to have a conservative repair than none at all.
 *
 * Either way, the output is normalised to a consistent `DecisionRepairDraft`
 * and the confidence is clamped to `[0, 1]`. The orchestrator decides
 * whether to persist based on `valueDelta`.
 */

import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../logger/types.js";
import { DECISION_REPAIR_PROMPT } from "../llm/prompts/decision-repair.js";
import { sanitizeDerivedMarkdown, sanitizeDerivedText } from "../safety/content.js";
import type { PolicyId, PolicyRow, TraceId, TraceRow } from "../types.js";
import { capTrace } from "./evidence.js";
import type {
  ClassifiedFeedback,
  DecisionRepairDraft,
  FeedbackConfig,
  RepairTrigger,
} from "./types.js";

export interface SynthesizeInput {
  trigger: RepairTrigger;
  contextHash: string;
  highValue: TraceRow[];
  lowValue: TraceRow[];
  classifiedFeedback?: ClassifiedFeedback;
  toolId?: string;
  /** Policies referenced by the high/low-value traces — used for attach. */
  candidatePolicies?: readonly PolicyRow[];
}

export interface SynthesizeDeps {
  llm: LlmClient | null;
  log: Logger;
  config: FeedbackConfig;
}

export type SynthesizeResult =
  | { ok: true; draft: DecisionRepairDraft }
  | { ok: false; reason: "insufficient-evidence" | "llm-failed" | "llm-disabled"; detail?: string };

export async function synthesizeDraft(
  input: SynthesizeInput,
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  if (input.highValue.length === 0 && input.lowValue.length === 0) {
    return { ok: false, reason: "insufficient-evidence" };
  }

  const policyIds = collectPolicyIds(input.candidatePolicies ?? []);

  if (!deps.config.useLlm || !deps.llm) {
    const fallback = templateDraft(input, policyIds);
    if (!fallback) return { ok: false, reason: "insufficient-evidence" };
    deps.log.info("repair.template.used", {
      contextHash: input.contextHash,
      highValue: input.highValue.length,
      lowValue: input.lowValue.length,
    });
    return { ok: true, draft: fallback };
  }

  try {
    const { prefer, avoid } = input.classifiedFeedback ?? {};
    const prompt = packPrompt(input, prefer, avoid, deps.config.traceCharCap);
    const res = await deps.llm.completeJson<LlmRepairResponse>(prompt, {
      op: "decision.repair",
      schemaHint: "decision-repair.v1",
    });
    const value = res.value as LlmRepairResponse;
    if (!isLlmRepairResponse(value)) {
      deps.log.warn("repair.llm.invalid_response", {
        contextHash: input.contextHash,
      });
      const fallback = templateDraft(input, policyIds);
      return fallback
        ? { ok: true, draft: fallback }
        : { ok: false, reason: "llm-failed", detail: "invalid_response" };
    }
    return {
      ok: true,
      draft: normalizeDraft(input, value, policyIds),
    };
  } catch (err) {
    deps.log.warn("repair.llm.failed", {
      contextHash: input.contextHash,
      err: err instanceof Error ? err.message : String(err),
    });
    const fallback = templateDraft(input, policyIds);
    return fallback
      ? { ok: true, draft: fallback }
      : { ok: false, reason: "llm-failed" };
  }
}

// ─── Prompt packing ───────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function packPrompt(
  input: SynthesizeInput,
  prefer: string | undefined,
  avoid: string | undefined,
  traceCharCap: number,
): ChatMessage[] {
  const contextHead = [
    `TRIGGER: ${input.trigger}`,
    input.toolId ? `TOOL: ${input.toolId}` : "",
    prefer ? `USER_PREFERS: ${prefer}` : "",
    avoid ? `USER_AVOIDS: ${avoid}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const summarizeTrace = (t: TraceRow, cap: number): string => {
    const capped = capTrace(t, cap);
    return [
      `trace ${t.id}`,
      `value: ${t.value.toFixed(2)}`,
      `user: ${capped.userText.trim()}`,
      `agent: ${capped.agentText.trim()}`,
      capped.reflection ? `reflection: ${capped.reflection.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const high = input.highValue
    .map((t) => summarizeTrace(t, traceCharCap))
    .join("\n---\n");
  const low = input.lowValue
    .map((t) => summarizeTrace(t, traceCharCap))
    .join("\n---\n");

  const userContent = [
    "CURRENT_CONTEXT:",
    contextHead,
    "",
    "FAILURE_HISTORY:",
    low || "(none)",
    "",
    "SIMILAR_SUCCESS:",
    high || "(none)",
    "",
    "Return the JSON object described in the system prompt.",
  ].join("\n");

  return [
    { role: "system", content: DECISION_REPAIR_PROMPT.system },
    { role: "user", content: userContent },
  ];
}

// ─── LLM response validation ──────────────────────────────────────────────

interface LlmRepairResponse {
  preference: string;
  anti_pattern: string;
  severity: "info" | "warn";
  confidence: number;
}

function isLlmRepairResponse(v: unknown): v is LlmRepairResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.preference === "string" &&
    typeof o.anti_pattern === "string" &&
    (o.severity === "info" || o.severity === "warn") &&
    typeof o.confidence === "number"
  );
}

// ─── Draft normalisation ──────────────────────────────────────────────────

function normalizeDraft(
  input: SynthesizeInput,
  v: LlmRepairResponse,
  policyIds: PolicyId[],
): DecisionRepairDraft {
  return {
    contextHash: input.contextHash,
    preference: sanitizeDerivedMarkdown(v.preference),
    antiPattern: sanitizeDerivedMarkdown(v.anti_pattern),
    severity: v.severity,
    confidence: clamp01(v.confidence),
    highValueTraceIds: input.highValue.map((t) => t.id) as TraceId[],
    lowValueTraceIds: input.lowValue.map((t) => t.id) as TraceId[],
    attachToPolicyIds: policyIds,
  };
}

// ─── Heuristic fallback ───────────────────────────────────────────────────

function templateDraft(
  input: SynthesizeInput,
  policyIds: PolicyId[],
): DecisionRepairDraft | null {
  const best = input.highValue.slice().sort((a, b) => b.value - a.value)[0];
  const worst = input.lowValue.slice().sort((a, b) => a.value - b.value)[0];
  const hint = input.classifiedFeedback;
  const preferText = sanitizeDerivedMarkdown(hint?.prefer) || sanitizeDerivedMarkdown(firstNonEmpty(best?.reflection, best?.agentText));
  const avoidText = sanitizeDerivedMarkdown(hint?.avoid) || sanitizeDerivedMarkdown(firstNonEmpty(worst?.reflection, worst?.agentText));
  if (!preferText && !avoidText) return null;
  return {
    contextHash: input.contextHash,
    preference: preferText
      ? `Prefer: ${trim80(preferText)}`
      : "Prefer the path that has worked in this context before.",
    antiPattern: avoidText
      ? `Avoid: ${trim80(avoidText)}`
      : "Avoid repeating the same failing approach.",
    severity: worst ? "warn" : "info",
    confidence: hint?.confidence ?? (best && worst ? 0.6 : 0.4),
    highValueTraceIds: input.highValue.map((t) => t.id) as TraceId[],
    lowValueTraceIds: input.lowValue.map((t) => t.id) as TraceId[],
    attachToPolicyIds: policyIds,
  };
}

function firstNonEmpty(...xs: Array<string | null | undefined>): string | undefined {
  for (const x of xs) {
    if (x && x.trim()) return x.trim();
  }
  return undefined;
}

function trim80(s: string): string {
  const line = s.split(/\r?\n/)[0] ?? s;
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function collectPolicyIds(policies: readonly PolicyRow[]): PolicyId[] {
  const seen = new Set<string>();
  const out: PolicyId[] = [];
  for (const p of policies) {
    if (!p?.id) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p.id);
  }
  return out;
}
