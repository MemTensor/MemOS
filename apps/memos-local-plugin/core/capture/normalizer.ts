/**
 * `normalizer` — trim / clamp / dedup freshly extracted steps.
 *
 * Responsibilities (cheap, synchronous):
 *   1. Truncate userText / agentText above config.maxTextChars.
 *      We keep both the head AND the tail, joined with a marker, so both
 *      "what the user asked" and "how the assistant wrapped up" survive.
 *   2. Truncate per-tool-output above config.maxToolOutputChars. Input
 *      is capped separately (via JSON stringify length).
 *   3. Drop steps where BOTH userText and agentText are empty (unusable).
 *   4. Dedup adjacent identical agent-text steps (LLM occasionally double-
 *      emits on retry).
 *
 * No LLM, no I/O. Pure data transformation.
 */

import type { ToolCallDTO } from "../../agent-contract/dto.js";
import { rootLogger } from "../logger/index.js";
import type { CaptureConfig, NormalizedStep, StepCandidate } from "./types.js";

const TRUNC_MARKER = "\n\n…[truncated]…\n\n";

export function normalizeSteps(
  steps: readonly StepCandidate[],
  cfg: CaptureConfig,
): NormalizedStep[] {
  const log = rootLogger.child({ channel: "core.capture" });
  const out: NormalizedStep[] = [];
  for (const step of steps) {
    const { text: userText, truncated: uT } = clampText(step.userText, cfg.maxTextChars);
    const { text: agentText, truncated: aT } = clampText(step.agentText, cfg.maxTextChars);
    const { calls: toolCalls, truncated: toolT } = clampTools(step.toolCalls, cfg.maxToolOutputChars);

    if (userText.length === 0 && agentText.length === 0 && toolCalls.length === 0) {
      log.debug("normalize.skip_empty", { key: step.key });
      continue;
    }

    const last = out[out.length - 1];
    if (
      last &&
      last.agentText === agentText &&
      last.userText === userText &&
      sameToolCalls(last.toolCalls, toolCalls)
    ) {
      log.debug("normalize.skip_duplicate", { key: step.key });
      continue;
    }

    out.push({
      ...step,
      userText,
      agentText,
      toolCalls,
      truncated: uT || aT || toolT,
    });
  }
  return out;
}

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  // Keep head + tail with a clear marker. Both halves get 45% of the budget
  // so they never overlap the marker length.
  const budget = Math.max(200, maxChars - TRUNC_MARKER.length);
  const head = Math.ceil(budget * 0.55);
  const tail = Math.floor(budget * 0.45);
  return {
    text: text.slice(0, head).trimEnd() + TRUNC_MARKER + text.slice(text.length - tail).trimStart(),
    truncated: true,
  };
}

function clampTools(
  calls: readonly ToolCallDTO[],
  maxOutputChars: number,
): { calls: ToolCallDTO[]; truncated: boolean } {
  if (calls.length === 0) return { calls: [], truncated: false };
  let anyTrunc = false;
  const out = calls.map((c) => {
    const output = toDisplayOutput(c.output);
    if (output && output.length > maxOutputChars) {
      anyTrunc = true;
      return {
        ...c,
        output: output.slice(0, Math.floor(maxOutputChars * 0.55)) +
          TRUNC_MARKER +
          output.slice(output.length - Math.floor(maxOutputChars * 0.45)),
      };
    }
    return { ...c, output };
  });
  return { calls: out, truncated: anyTrunc };
}

function toDisplayOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Two tool-call arrays are "same" for dedup purposes when they have
 * the same length AND each call matches by name + input identity.
 * This prevents consecutive tool sub-steps (which share the same
 * userText and empty agentText) from being incorrectly deduped.
 */
function sameToolCalls(a: readonly ToolCallDTO[], b: readonly ToolCallDTO[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name) return false;
    if (inputFingerprint(a[i]!.input) !== inputFingerprint(b[i]!.input)) return false;
  }
  return true;
}

function inputFingerprint(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 200);
  try { return JSON.stringify(v).slice(0, 200); }
  catch { return String(v).slice(0, 200); }
}
