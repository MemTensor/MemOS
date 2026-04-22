/**
 * `capture/embedder` — a thin wrapper that decides what text to embed for
 * each trace and calls the `Embedder` facade in one batch call.
 *
 * Why a wrapper?
 *   - We want TWO vectors per row (vec_summary / vec_action). The embedder
 *     takes a flat list; here we interleave step-pairs in an order the
 *     caller can decode.
 *   - Embedding failure MUST NOT block the capture write — we log and
 *     insert `null` vectors. Vector search will just skip them.
 */

import { MemosError } from "../../agent-contract/errors.js";
import type { Embedder } from "../embedding/index.js";
import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector } from "../types.js";
import type { NormalizedStep } from "./types.js";

export interface VecPair {
  summary: EmbeddingVector | null;
  action: EmbeddingVector | null;
}

export async function embedSteps(
  embedder: Embedder,
  steps: readonly NormalizedStep[],
  /**
   * Optional per-step summaries to embed for `vec_summary`. When
   * omitted we fall back to `summaryText(step)` — the raw user text —
   * which preserves the pre-5.x behaviour. Callers that have already
   * produced an LLM summary (see `core/capture/summarizer.ts`) should
   * pass it here so retrieval matches against the same compact form
   * the viewer displays.
   */
  summaryOverrides?: readonly string[],
): Promise<VecPair[]> {
  const log = rootLogger.child({ channel: "core.capture.embed" });
  if (steps.length === 0) return [];

  const summaryTexts = steps.map((s, i) => {
    const override = summaryOverrides?.[i]?.trim();
    if (override) return override;
    return summaryText(s);
  });
  const actionTexts = steps.map(actionText);
  // Pack summary first then action — both in the same batch to amortize
  // HTTP round trips when the provider is remote.
  const inputs = [
    ...summaryTexts.map((t) => ({ text: t || "(empty)", role: "document" as const })),
    ...actionTexts.map((t) => ({ text: t || "(empty)", role: "document" as const })),
  ];

  try {
    const vecs = await embedder.embedMany(inputs);
    const out: VecPair[] = new Array(steps.length);
    for (let i = 0; i < steps.length; i++) {
      out[i] = {
        summary: vecs[i] ?? null,
        action: vecs[i + steps.length] ?? null,
      };
    }
    return out;
  } catch (err) {
    log.warn("embed.failed_all", { err: errDetail(err), stepCount: steps.length });
    return steps.map(() => ({ summary: null, action: null }));
  }
}

function summaryText(step: NormalizedStep): string {
  // V7 §3.2: vec_summary indexes "state" — what happened BEFORE the action.
  // For memory probes (Tier 2 recall), the embedded summary is what we
  // match against the next episode's user text.
  return step.userText.trim();
}

function actionText(step: NormalizedStep): string {
  // vec_action indexes the agent's decision: its text + tool-call semantics.
  const toolSig = step.toolCalls
    .map((t) => `${t.name}(${safeStringify(t.input).slice(0, 300)})`)
    .join("; ");
  return [step.agentText.trim(), toolSig].filter((s) => s.length > 0).join("\n---\n");
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
