/**
 * `IntentClassifier`.
 *
 * Decision flow:
 *   1. Empty / whitespace-only                → `chitchat` (zero-cost).
 *   2. Heuristic rule fires with conf ≥ 0.85 → use it.
 *   3. Heuristic rule fires with lower conf  → keep as fallback, try LLM.
 *   4. No rule fires                          → try LLM.
 *   5. LLM unavailable / fails                → use heuristic fallback
 *                                              or `unknown` (full retrieval).
 *
 * The classifier is pure-ish: it only depends on an injected LlmClient, so
 * tests can stub it. When `kind=meta`, retrieval is skipped regardless.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import { sanitizeDerivedText } from "../safety/content.js";
import { HEURISTIC_RULES, matchFirst, retrievalFor } from "./heuristics.js";
import type { IntentDecision, IntentKind } from "./types.js";

const STRONG_HEURISTIC = 0.85;

export interface IntentClassifierOptions {
  /** Optional LLM client. When absent, we only use heuristics. */
  llm?: LlmClient;
  /** Budget per classification. Default 6000 ms. */
  timeoutMs?: number;
  /** When true, skip LLM entirely (e.g. provider=local_only). Default derived from llm presence. */
  disableLlm?: boolean;
}

export interface IntentClassifier {
  classify(firstUserMessage: string): Promise<IntentDecision>;
}

export function createIntentClassifier(opts: IntentClassifierOptions = {}): IntentClassifier {
  const log = rootLogger.child({ channel: "core.session.intent" });
  const llmDisabled = opts.disableLlm ?? !opts.llm;
  const llm = opts.llm;
  const timeoutMs = opts.timeoutMs ?? 6_000;

  return {
    async classify(firstUserMessage: string): Promise<IntentDecision> {
      const text = (firstUserMessage ?? "").trim();
      if (text.length === 0) {
        return decisionFrom("chitchat", 0.9, "empty message", ["empty"]);
      }

      // Step 1: heuristics.
      const heuristic = matchFirst(text);
      if (heuristic && heuristic.confidence >= STRONG_HEURISTIC) {
        log.debug("heuristic.strong", {
          ruleId: heuristic.rule.id,
          kind: heuristic.kind,
          confidence: heuristic.confidence,
        });
        return decisionFrom(
          heuristic.kind,
          heuristic.confidence,
          heuristic.rule.label,
          [heuristic.rule.id],
        );
      }

      // Step 2: LLM tiebreaker when available.
      if (!llmDisabled && llm) {
        try {
          const result = await withTimeout(
            callLlm(llm, text),
            timeoutMs,
            "intent.llm.timeout",
          );
          log.debug("llm.ok", {
            kind: result.kind,
            confidence: result.confidence,
            modelServedBy: result.servedBy,
          });
          const signals = ["llm"];
          if (heuristic) signals.push(`heuristic:${heuristic.rule.id}(weak)`);
          const llmModel = result.servedBy;
          return {
            kind: result.kind,
            confidence: clamp01(result.confidence),
            reason: result.reason.slice(0, 120),
            retrieval: retrievalFor(result.kind),
            llmModel,
            signals,
          };
        } catch (err) {
          log.warn("llm.failed", { err: summarizeErr(err) });
          // Fall through — use heuristic fallback or `unknown`.
        }
      }

      // Step 3: heuristic fallback.
      if (heuristic) {
        log.debug("heuristic.fallback", {
          ruleId: heuristic.rule.id,
          kind: heuristic.kind,
          confidence: heuristic.confidence,
        });
        return decisionFrom(
          heuristic.kind,
          heuristic.confidence,
          `${heuristic.rule.label} (fallback)`,
          [heuristic.rule.id, "llm_skipped"],
        );
      }

      // Step 4: no signal at all — default to full retrieval.
      return decisionFrom(
        "unknown",
        0.4,
        "no classifier signal; defaulting to full retrieval",
        ["default_unknown"],
      );
    },
  };
}

function decisionFrom(
  kind: IntentKind,
  confidence: number,
  reason: string,
  signals: string[],
): IntentDecision {
  return {
    kind,
    confidence: clamp01(confidence),
    reason: reason.slice(0, 120),
    retrieval: retrievalFor(kind),
    signals,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function summarizeErr(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

// ─── LLM path ───────────────────────────────────────────────────────────────

const ALLOWED_KINDS: IntentKind[] = ["task", "memory_probe", "chitchat", "meta", "unknown"];

interface LlmIntentAnswer {
  kind: IntentKind;
  confidence: number;
  reason: string;
  servedBy: string;
}

const INTENT_SYSTEM = `You are a fast intent classifier for a memory/tool-using agent.

Classify the user's message into ONE of:
  - "task"         — user wants the agent to do work (build / fix / analyze / explain / run …).
  - "memory_probe" — user is asking about past conversation context.
  - "chitchat"     — small talk, thanks, greetings with no actionable content.
  - "meta"         — command to the plugin itself (starts with "/memos" / "/memory").
  - "unknown"      — truly ambiguous.

Return JSON with exactly these keys:
{
  "kind": one of the five labels above,
  "confidence": number in [0, 1],
  "reason": short English justification (≤ 80 chars, no quotes)
}

Rules:
- Never invent a new label.
- If unsure, pick "unknown" with confidence ≤ 0.5.
- "task" is the safe default for imperative requests in any language.`;

async function callLlm(llm: LlmClient, text: string): Promise<LlmIntentAnswer> {
  const rsp = await llm.completeJson<{ kind: unknown; confidence: unknown; reason: unknown }>(
    [
      { role: "system", content: INTENT_SYSTEM },
      { role: "user", content: text.slice(0, 2000) },
    ],
    {
      op: "session.intent.classify",
      phase: "session",
      schemaHint: `{"kind":"task"|"memory_probe"|"chitchat"|"meta"|"unknown","confidence":0..1,"reason":"..."}`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        if (typeof o.kind !== "string" || !ALLOWED_KINDS.includes(o.kind as IntentKind)) {
          throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "intent.kind out of vocabulary", {
            got: o.kind,
          });
        }
        if (typeof o.confidence !== "number") {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "intent.confidence must be a number",
            { got: o.confidence },
          );
        }
        if (typeof o.reason !== "string") {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "intent.reason must be a string",
            { got: o.reason },
          );
        }
      },
      malformedRetries: 1,
      temperature: 0,
    },
  );
  return {
    kind: rsp.value.kind as IntentKind,
    confidence: rsp.value.confidence as number,
    reason: sanitizeDerivedText(rsp.value.reason),
    servedBy: rsp.servedBy,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MemosError(ERROR_CODES.LLM_TIMEOUT, label, { timeoutMs: ms })),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Expose rule metadata for the frontend / audit. */
export function listHeuristicRules(): ReadonlyArray<{ id: string; kind: IntentKind; label: string }> {
  return HEURISTIC_RULES.map((r) => ({ id: r.id, kind: r.kind, label: r.label }));
}
