/**
 * LLM-driven L2 policy induction.
 *
 * Given a candidate bucket (≥ N distinct episodes' worth of evidence traces
 * sharing a PatternSignature), call the `l2.induction` prompt and build a
 * `PolicyRow` draft. If the draft passes cheap validation we persist it as a
 * new row with `status = 'candidate'`; gain updates can later promote it.
 *
 * Pure induction logic — no candidate-pool or events writes. Callers handle
 * that.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import {
  detectDominantLanguage,
  languageSteeringLine,
} from "../../llm/prompts/index.js";
import { L2_INDUCTION_PROMPT } from "../../llm/prompts/l2-induction.js";
import type { LlmClient } from "../../llm/index.js";
import type { Logger } from "../../logger/types.js";
import { sanitizeDerivedMarkdown, sanitizeDerivedMarkdownList, sanitizeDerivedText } from "../../safety/content.js";
import type {
  EmbeddingVector,
  EpisodeId,
  PolicyId,
  PolicyRow,
  TraceId,
  TraceRow,
} from "../../types.js";
import { ids } from "../../id.js";
import { centroid } from "./similarity.js";
import type { InductionDraft, InductionDraftResult } from "./types.js";

export interface InduceInput {
  /** Traces that back the induction (one from each episode; may contain duplicates). */
  evidenceTraces: readonly TraceRow[];
  /** Episode ids these traces came from — must be the distinct set. */
  episodeIds: readonly EpisodeId[];
  /** Human-readable signature for the bucket — appears in prompts. */
  signatureLabel: string;
  charCap: number;
}

export interface InduceDeps {
  llm: LlmClient | null;
  log: Logger;
  /** When provided, run after JSON parse but before we accept the draft. */
  validate?: (d: InductionDraft) => void;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the induction LLM call and validate the draft. Returns a tagged union
 * — callers can decide whether to persist.
 */
export async function induceDraft(
  input: InduceInput,
  deps: InduceDeps,
): Promise<InductionDraftResult> {
  const { llm, log } = deps;
  if (!llm) {
    log.warn("l2.induce.llm_unavailable", {
      signatureLabel: input.signatureLabel,
      evidenceCount: input.evidenceTraces.length,
      fallback: "skipped",
    });
    return { ok: false, reason: "llm_disabled" };
  }

  const userPayload = packTraces(input.evidenceTraces, input.charCap, input.signatureLabel);

  // Match the induced policy's title/trigger/action/rationale to the
  // dominant language of the evidence bucket — Chinese users expect
  // their own L2 memories in 中文, English users expect English.
  const evidenceLang = detectDominantLanguage(
    input.evidenceTraces.flatMap((t) => [t.userText, t.agentText, t.reflection]),
  );

  try {
    const rsp = await llm.completeJson<{
      title: unknown;
      trigger: unknown;
      action?: unknown;
      procedure?: unknown;
      verification?: unknown;
      rationale?: unknown;
      caveats?: unknown;
      confidence?: unknown;
      support_trace_ids?: unknown;
    }>(
      [
        { role: "system", content: L2_INDUCTION_PROMPT.system },
        { role: "system", content: languageSteeringLine(evidenceLang) },
        { role: "user", content: userPayload },
      ],
      {
        op: `l2.${L2_INDUCTION_PROMPT.id}.v${L2_INDUCTION_PROMPT.version}`,
        temperature: 0.1,
        malformedRetries: 1,
        schemaHint: `{"title":"...","trigger":"...","procedure":"...","verification":"...","rationale":"...","caveats":["..."],"confidence":0..1,"support_trace_ids":["tr_..."]}`,
        validate: (v) => {
          const o = v as Record<string, unknown>;
          for (const k of ["title", "trigger"]) {
            if (typeof o[k] !== "string" || !(o[k] as string).trim()) {
              throw new MemosError(
                ERROR_CODES.LLM_OUTPUT_MALFORMED,
                `l2.induction: '${k}' must be a non-empty string`,
                { got: o[k] },
              );
            }
          }
          if (
            typeof o.procedure !== "string" &&
            typeof o.action !== "string"
          ) {
            throw new MemosError(
              ERROR_CODES.LLM_OUTPUT_MALFORMED,
              `l2.induction: 'procedure' (or legacy 'action') must be a string`,
              { got: o.procedure ?? o.action },
            );
          }
        },
      },
    );

    const draft = normaliseDraft(rsp.value, input.evidenceTraces.map((t) => t.id));
    if (deps.validate) deps.validate(draft);
    return { ok: true, draft };
  } catch (err) {
    log.warn("induce.llm_failed", {
      signature: input.signatureLabel,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "llm_failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convert a validated draft into a ready-to-persist `PolicyRow`.
 * Gain/support are zero-initialised — the gain step fills them in.
 */
export function buildPolicyRow(args: {
  draft: InductionDraft;
  episodeIds: readonly EpisodeId[];
  evidenceTraces: readonly TraceRow[];
  inducedBy: string; // prompt id + version
  now?: number;
  id?: PolicyId;
}): PolicyRow {
  const now = args.now ?? Date.now();
  const vec = centroid(args.evidenceTraces.map((t) => t.vecSummary ?? t.vecAction ?? null));
  return {
    id: (args.id ?? (ids.policy() as PolicyId)),
    title: args.draft.title.slice(0, 120),
    trigger: args.draft.trigger,
    procedure: args.draft.procedure,
    verification: args.draft.verification,
    boundary: args.draft.boundary,
    support: 0,
    gain: 0,
    status: "candidate",
    sourceEpisodeIds: Array.from(new Set(args.episodeIds)),
    inducedBy: args.inducedBy,
    // Fresh policy starts without learned guidance — populated by the
    // decision-repair pipeline as user feedback / failure bursts arrive.
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: vec as EmbeddingVector | null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function packTraces(
  traces: readonly TraceRow[],
  charCap: number,
  label: string,
): string {
  const header = `PATTERN_SIGNATURE: ${label}\nTRACES (one per block):`;
  const blocks: string[] = [];
  let budget = Math.max(400, charCap - header.length - 100);
  for (const t of traces) {
    const block = [
      `---`,
      `id: ${t.id}`,
      `episode: ${t.episodeId}`,
      `tags: ${(t.tags ?? []).join(",") || "-"}`,
      `user: ${truncate(t.userText, 200)}`,
      `agent: ${truncate(t.agentText, 300)}`,
      `tools: ${formatTools(t.toolCalls)}`,
      `reflection: ${truncate(t.reflection ?? "-", 300)}`,
      `V: ${t.value.toFixed(2)}  alpha: ${t.alpha.toFixed(2)}`,
    ].join("\n");
    if (block.length > budget) {
      blocks.push(block.slice(0, budget));
      break;
    }
    blocks.push(block);
    budget -= block.length;
  }
  return `${header}\n${blocks.join("\n")}`;
}

function formatTools(calls: TraceRow["toolCalls"] | undefined): string {
  if (!calls || calls.length === 0) return "-";
  return calls
    .slice(0, 3)
    .map((c) => {
      const out =
        typeof c.output === "string" ? truncate(c.output, 80) : JSON.stringify(c.output ?? "").slice(0, 80);
      return `${c.name ?? "?"}(${truncate(JSON.stringify(c.input ?? ""), 40)}) → ${out}`;
    })
    .join("; ");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function normaliseDraft(value: Record<string, unknown>, traceIds: readonly TraceId[]): InductionDraft {
  const procedure =
    typeof value.procedure === "string"
      ? (value.procedure as string)
      : typeof value.action === "string"
      ? (value.action as string)
      : "";
  const caveats = Array.isArray(value.caveats)
    ? sanitizeDerivedMarkdownList((value.caveats as unknown[]).filter((c): c is string => typeof c === "string"))
    : [];
  const confidence = typeof value.confidence === "number" ? value.confidence : 0.5;
  const supportTraceIds = Array.isArray(value.support_trace_ids)
    ? (value.support_trace_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    title: sanitizeDerivedText(value.title),
    trigger: sanitizeDerivedMarkdown(value.trigger),
    procedure: sanitizeDerivedMarkdown(procedure),
    verification: typeof value.verification === "string" ? sanitizeDerivedMarkdown(value.verification) : "",
    boundary: typeof value.boundary === "string" ? sanitizeDerivedMarkdown(value.boundary) : "",
    rationale: typeof value.rationale === "string" ? sanitizeDerivedMarkdown(value.rationale) : "",
    caveats,
    confidence: Math.max(0, Math.min(1, confidence)),
    supportTraceIds: supportTraceIds.length > 0 ? (supportTraceIds as TraceId[]) : Array.from(traceIds),
  };
}
