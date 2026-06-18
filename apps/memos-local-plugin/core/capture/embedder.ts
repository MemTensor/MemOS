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

export interface EmbedStepTextOptions {
  stateTexts?: readonly string[];
  actionTexts?: readonly string[];
  summaryOnly?: boolean;
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
  summaryOverridesOrOpts?: readonly string[] | EmbedStepTextOptions,
  opts: { summaryOnly?: boolean } = {},
): Promise<VecPair[]> {
  const log = rootLogger.child({ channel: "core.capture.embed" });
  if (steps.length === 0) return [];

  const legacyOverrides = Array.isArray(summaryOverridesOrOpts);
  const textOpts: EmbedStepTextOptions | undefined = legacyOverrides
    ? undefined
    : summaryOverridesOrOpts as EmbedStepTextOptions | undefined;
  const summaryOverrides: readonly string[] | undefined = legacyOverrides
    ? summaryOverridesOrOpts as readonly string[]
    : undefined;
  const embedOpts: { summaryOnly?: boolean } = textOpts ?? opts;
  const summaryTexts = steps.map((s, i) => {
    const stateText = textOpts?.stateTexts?.[i]?.trim();
    if (stateText) return stateText;
    const override = summaryOverrides?.[i]?.trim();
    if (override) return override;
    return summaryText(s);
  });
  const actionTexts = steps.map((s, i) => {
    const explicit = textOpts?.actionTexts?.[i]?.trim();
    if (explicit) return explicit;
    return actionText(s);
  });
  if (embedOpts.summaryOnly) {
    try {
      const vecs = await embedder.embedMany(
        summaryTexts.map((t) => ({ text: t || "(empty)", role: "document" as const })),
      );
      return steps.map((_, i) => ({ summary: vecs[i] ?? null, action: null }));
    } catch (err) {
      log.warn("embed.failed_all", { err: errDetail(err), stepCount: steps.length });
      return steps.map(() => ({ summary: null, action: null }));
    }
  }
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
  return buildStateText(step);
}

function actionText(step: NormalizedStep): string {
  return buildActionText(step);
}

export function buildStateText(step: NormalizedStep): string {
  const parts: string[] = [];
  const user = compactText(step.userText);
  if (user) parts.push(`[user]\n${user}`);

  const observations = step.toolCalls
    .map((tool) => {
      const output = compactText(safeStringify(tool.output));
      const signals = extractObservationSignals(output);
      const chunks = [`tool:${tool.name}`];
      if (signals.length > 0) chunks.push(signals.join("\n"));
      if (signals.length === 0) {
        const input = compactText(safeStringify(tool.input)).slice(0, 180);
        if (input) chunks.push(`input:${input}`);
      }
      return chunks.join("\n");
    })
    .filter((s) => s.trim().length > 0);
  if (observations.length > 0) parts.push(`[observed]\n${observations.join("\n---\n")}`);

  if (parts.length === 0) {
    const tool = step.toolCalls[0];
    if (tool) {
      const input = compactText(safeStringify(tool.input)).slice(0, 180);
      parts.push(`[state unavailable] tool:${tool.name}${input ? ` input:${input}` : ""}`);
    } else {
      const agent = compactText(step.agentText).slice(0, 180);
      parts.push(agent || "[state unavailable]");
    }
  }

  return redactForEmbedding(parts.join("\n\n"));
}

export function buildActionText(step: NormalizedStep): string {
  // vec_action indexes the agent's decision: its text + tool-call semantics.
  const toolSig = step.toolCalls
    .map((t) => `${t.name}(${safeStringify(t.input).slice(0, 300)})`)
    .join("; ");
  return redactForEmbedding([compactText(step.agentText), toolSig].filter((s) => s.length > 0).join("\n---\n"));
}

export function redactForEmbedding(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]+\b(?![-_])/g, "[REDACTED_KEY]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;}]+/gi, "$1=[REDACTED]");
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractObservationSignals(output: string): string[] {
  if (!output) return [];
  const signals: string[] = [];
  for (const line of output.split(/\\n|(?<=\.)\s+/).map((s) => s.trim())) {
    if (!line) continue;
    if (/error|failed|failure|cannot|not found|timeout|exception/i.test(line)) {
      signals.push(line.slice(0, 240));
    }
  }
  const paths = output.match(/(?:~|\/|\.\.?\/)[A-Za-z0-9._~/-]+/g) ?? [];
  for (const path of paths.slice(0, 4)) signals.push(path);
  return Array.from(new Set(signals)).slice(0, 6);
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
