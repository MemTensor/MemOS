/**
 * V7 §2.4.6 — gather evidence for a decision-repair synthesis.
 *
 * Given a context hash + sessionId (and, optionally, an episodeId), we need
 * two sets of traces:
 *
 *   - **HIGH_VALUE**: recent traces in the same session with value > 0 whose
 *     agentText overlaps with the failing context. These drive the
 *     `preference` field.
 *   - **LOW_VALUE**: recent traces in the same session with value ≤ 0 (or
 *     explicit failure markers). These drive the `anti_pattern` field.
 *
 * The gather is a cheap SQL scan — no vector math — because the traces
 * we're interested in are always very recent. The orchestrator caps the
 * evidence at `evidenceLimit` per class.
 */

import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { SessionId, TraceRow } from "../types.js";
import type { FeedbackConfig } from "./types.js";

export interface EvidenceInput {
  sessionId: SessionId;
  /** Optional token to match inside trace agentText/userText/reflection. */
  keyword?: string;
  limit?: number;
}

export interface EvidenceResult {
  highValue: TraceRow[];
  lowValue: TraceRow[];
}

export interface EvidenceDeps {
  repos: Repos;
  config: FeedbackConfig;
  log: Logger;
}

export function gatherRepairEvidence(
  input: EvidenceInput,
  deps: EvidenceDeps,
): EvidenceResult {
  const cap = input.limit ?? deps.config.evidenceLimit;
  const needle = input.keyword?.toLowerCase().trim() ?? "";

  // Pull a generous recent batch and split by value sign. Limiting at the
  // SQL layer is fine because the caller passes a small `limit`.
  const recent = deps.repos.traces.list({
    sessionId: input.sessionId,
    limit: Math.max(cap * 6, 24),
  });

  if (recent.length === 0) {
    return { highValue: [], lowValue: [] };
  }

  // Two-pass: first try with the keyword filter; if BOTH lists come back
  // empty, relax and rescan without the filter. This keeps the happy path
  // relevance-aware while still producing useful evidence when the
  // keyword is a normalized tool ID ("pip.install") that doesn't appear
  // verbatim in the natural-language trace text. If only one side is
  // empty we keep the filtered result — the synthesizer is designed to
  // fall back to template output in that case without needing extra
  // context.
  const firstPass = partition(recent, cap, needle);
  const firstPassEmpty =
    firstPass.highValue.length === 0 && firstPass.lowValue.length === 0;
  if (!needle || !firstPassEmpty) {
    deps.log.debug("evidence.gathered", {
      sessionId: input.sessionId,
      highValue: firstPass.highValue.length,
      lowValue: firstPass.lowValue.length,
      hadKeyword: Boolean(needle),
      relaxed: false,
    });
    return firstPass;
  }
  const relaxed = partition(recent, cap, "");
  deps.log.debug("evidence.gathered", {
    sessionId: input.sessionId,
    highValue: relaxed.highValue.length,
    lowValue: relaxed.lowValue.length,
    hadKeyword: Boolean(needle),
    relaxed: true,
  });
  return relaxed;
}

function partition(
  traces: readonly TraceRow[],
  cap: number,
  needle: string,
): EvidenceResult {
  const highValue: TraceRow[] = [];
  const lowValue: TraceRow[] = [];
  for (const trace of traces) {
    if (needle && !traceContains(trace, needle)) continue;
    if (trace.value > 0) {
      if (highValue.length < cap) highValue.push(trace);
    } else if (trace.value < 0 || isFailureLike(trace)) {
      if (lowValue.length < cap) lowValue.push(trace);
    }
    if (highValue.length >= cap && lowValue.length >= cap) break;
  }
  return { highValue, lowValue };
}

function traceContains(trace: TraceRow, needle: string): boolean {
  const blob =
    `${trace.userText}\n${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase();
  return blob.includes(needle);
}

function isFailureLike(trace: TraceRow): boolean {
  const blob = `${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase();
  return (
    /(error|failed|failure|exception|traceback|timeout|retry)/.test(blob) ||
    trace.toolCalls.some((call) => Boolean(call.errorCode))
  );
}

/**
 * Truncate a trace trio to roughly `maxChars` preserving the tail (the
 * most recent lines) — the error messages we want to learn from usually
 * live at the end of the agentText.
 */
export function capTrace(trace: TraceRow, maxChars: number): TraceRow {
  if (maxChars <= 0) return trace;
  return {
    ...trace,
    userText: tail(trace.userText, maxChars),
    agentText: tail(trace.agentText, maxChars),
    reflection: trace.reflection ? tail(trace.reflection, maxChars) : trace.reflection,
  };
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `...${s.slice(s.length - n)}`;
}
