/**
 * `batch-scorer` — windowed binary path-relevance scoring for one episode
 * window. Always invoked through `capture.ts :: runEpisodeBatchScoring`,
 * which owns the primary/degrade window topology and retry ladder.
 *
 * Wire format ↔ prompt:
 *   Send `{ host_context?, task_context?, steps: [{idx, state, thinking,
 *           action, tool_calls, outcome}] }`.
 *   Receive `{ scores: [{idx, alpha: 0|1, relevance: "RELATED" |
 *           "IRRELEVANT", reason: str}] }`.
 *   See `core/llm/prompts/reflection.ts :: BATCH_REFLECTION_PROMPT`.
 *
 * Validation is strict: any non-{0,1} alpha or relevance outside
 * {RELATED, IRRELEVANT} raises `LLM_OUTPUT_MALFORMED` so the caller's
 * window retry ladder can take over.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { BATCH_REFLECTION_PROMPT } from "../llm/prompts/reflection.js";
import { rootLogger } from "../logger/index.js";
import { sanitizeDerivedText } from "../safety/content.js";
import type { NormalizedStep, ReflectionScore } from "./types.js";

export interface BatchScoreInput {
  step: NormalizedStep;
}

export interface BatchScoreOptions {
  episodeId?: string;
  phase?: string;
  taskSummary?: string | null;
  perFieldChars?: {
    state: number;
    action: number;
    outcome: number;
  };
}

export interface BatchScoreResult {
  /** Per-step `ReflectionScore`, one entry per input, in input order. */
  scores: ReflectionScore[];
  /** `servedBy` model id from the underlying LLM call. */
  model: string;
}

interface RawScoreEntry {
  idx: number;
  alpha: unknown;
  relevance: unknown;
  reason?: unknown;
}

interface BatchPayload {
  scores: RawScoreEntry[];
}

const DEFAULT_FIELD_CHARS = {
  state: 1_200,
  action: 1_500,
  outcome: 600,
  thinking: 1_500,
} as const;

export const BATCH_OP_TAG = `capture.${BATCH_REFLECTION_PROMPT.id}.v${BATCH_REFLECTION_PROMPT.version}`;

/**
 * One LLM call → binary relevance + α(0/1) for every input step.
 *
 * Throws `MemosError` with `LLM_OUTPUT_MALFORMED` when the LLM returns a
 * shape we cannot parse even after the facade's malformed-retry. Caller
 * (capture.ts) catches and falls back to per-step.
 *
 * Empty `inputs` → returns empty `scores` without invoking the LLM.
 */
export async function batchScoreReflections(
  llm: LlmClient,
  inputs: ReadonlyArray<BatchScoreInput>,
  opts: BatchScoreOptions,
): Promise<BatchScoreResult> {
  const log = rootLogger.child({ channel: "core.capture.batch" });
  if (inputs.length === 0) {
    return { scores: [], model: "none" };
  }
  const fieldChars = { ...DEFAULT_FIELD_CHARS, ...(opts.perFieldChars ?? {}) };

  const payload = {
    host_context: batchHostContext(inputs, llm),
    task_context: opts.taskSummary?.trim().slice(0, 1_200) || null,
    steps: inputs.map((input, i) => ({
      idx: i,
      state: clip(input.step.userText, fieldChars.state),
      thinking: clip(input.step.agentThinking ?? "", fieldChars.thinking),
      action: clip(input.step.agentText, fieldChars.action) || "(none)",
      tool_calls: input.step.toolCalls.map((t) => ({
        name: t.name,
        input: summarizeInput(t.input),
        output: clip(outputOf(t), 300),
        errorCode: t.errorCode ?? null,
      })),
      outcome: lastToolOutcome(input.step, fieldChars.outcome),
    })),
  };

  const rsp = await llm.completeJson<BatchPayload>(
    [
      { role: "system", content: BATCH_REFLECTION_PROMPT.system },
      { role: "user", content: JSON.stringify(payload) },
    ],
    {
      op: BATCH_OP_TAG,
      episodeId: opts.episodeId,
      phase: opts.phase,
      schemaHint:
        '{"scores": [{"idx": int, "alpha": 0|1, "relevance": "RELATED|IRRELEVANT", "reason": "str"}]}',
      validate: (v) => validateBatchPayload(v, inputs.length),
      malformedRetries: 1,
      temperature: 0,
    },
  );

  // Index entries by `idx` so a re-ordered (but otherwise valid) response
  // still maps back to the right step.
  const byIdx = new Map<number, RawScoreEntry>();
  for (const entry of rsp.value.scores) byIdx.set(Number(entry.idx), entry);

  const scores: ReflectionScore[] = inputs.map((input, i) => {
    const raw = byIdx.get(i);
    if (!raw) {
      return {
        text: "IRRELEVANT",
        alpha: 0,
        usable: false,
        source: "none",
      };
    }
    const alpha = clamp01(numOrZero(raw.alpha)) >= 0.5 ? 1 : 0;
    const relevance = raw.relevance === "RELATED" ? "RELATED" : "IRRELEVANT";
    const reason = typeof raw.reason === "string" ? sanitizeDerivedText(raw.reason) : null;
    return {
      text: relevance,
      alpha,
      usable: alpha === 1,
      reason,
      source: "synth",
      model: rsp.servedBy,
    };
  });

  log.debug("batch.scored", {
    steps: inputs.length,
    model: rsp.servedBy,
    durationMs: rsp.durationMs,
  });

  return { scores, model: rsp.servedBy };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function batchHostContext(
  inputs: ReadonlyArray<BatchScoreInput>,
  llm: LlmClient,
): Record<string, string> | undefined {
  const hints = inputs
    .map((input) => input.step.meta.contextHints)
    .find((value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    );
  const out: Record<string, string> = {
    reflectionProvider: llm.provider,
    reflectionModel: llm.model,
  };
  for (const key of ["agentIdentity", "hostProvider", "hostModel", "hostApiMode", "hostBaseUrl"]) {
    const value = hints?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function validateBatchPayload(v: unknown, expected: number): void {
  const o = v as { scores?: unknown };
  if (!o || !Array.isArray(o.scores)) {
    throw new MemosError(
      ERROR_CODES.LLM_OUTPUT_MALFORMED,
      "batch reflection: scores array missing",
      { got: typeof o },
    );
  }
  if (o.scores.length !== expected) {
    throw new MemosError(
      ERROR_CODES.LLM_OUTPUT_MALFORMED,
      "batch reflection: scores length mismatch",
      { expected, got: o.scores.length },
    );
  }
  for (const entry of o.scores as RawScoreEntry[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "batch reflection: non-object entry");
    }
    if (typeof entry.idx !== "number") {
      throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "batch reflection: idx must be number", {
        got: entry.idx,
      });
    }
    if (typeof entry.alpha !== "number" || !Number.isFinite(entry.alpha)) {
      throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "batch reflection: alpha must be number", {
        idx: entry.idx,
        got: entry.alpha,
      });
    }
    if (entry.alpha !== 0 && entry.alpha !== 1) {
      throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "batch reflection: alpha must be 0 or 1", {
        idx: entry.idx,
        got: entry.alpha,
      });
    }
    if (entry.relevance !== "RELATED" && entry.relevance !== "IRRELEVANT") {
      throw new MemosError(
        ERROR_CODES.LLM_OUTPUT_MALFORMED,
        "batch reflection: relevance must be RELATED or IRRELEVANT",
        { idx: entry.idx, got: entry.relevance },
      );
    }
  }
}

function lastToolOutcome(step: NormalizedStep, max: number): string {
  const last = step.toolCalls[step.toolCalls.length - 1];
  if (!last) return "(assistant-only step)";
  const head = last.errorCode ? `ERROR[${last.errorCode}] ` : "";
  return clip(head + outputOf(last), max);
}

function outputOf(t: { output?: unknown }): string {
  if (t.output === undefined || t.output === null) return "";
  if (typeof t.output === "string") return t.output;
  try {
    return JSON.stringify(t.output);
  } catch {
    return String(t.output);
  }
}

function summarizeInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, 200);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return String(v).slice(0, 200);
  }
}

function clip(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
