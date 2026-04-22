/**
 * `alpha-scorer` — grade a reflection with the `REFLECTION_SCORE_PROMPT`
 * (defined in `core/llm/prompts/reflection.ts`).
 *
 * Implements V7 eq. 5:
 *    α_t = judge(state_t, action_t, outcome_t, reflection_t)
 *    usable = α ≥ 0.4 ∧ non-tautological
 *    if ¬usable then α ← 0
 *
 * We parse a `{alpha: number, usable: boolean, reason?: string}` JSON
 * response, clamp α to [0, 1], and force α = 0 when `usable=false`.
 *
 * Failures (LLM unavailable, malformed JSON) return a neutral
 * `{alpha: null, usable: false}` — the caller decides what to do
 * (capture.ts falls back to α=0 so nothing is trained on ungraded data).
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { REFLECTION_SCORE_PROMPT } from "../llm/prompts/reflection.js";
import { rootLogger } from "../logger/index.js";
import type { NormalizedStep, ReflectionScore } from "./types.js";

export interface AlphaInput {
  step: NormalizedStep;
  reflectionText: string;
}

export interface AlphaOutput {
  alpha: number;
  usable: boolean;
  reason: string | null;
  model: string;
}

export async function scoreReflection(
  llm: LlmClient,
  input: AlphaInput,
): Promise<AlphaOutput> {
  const log = rootLogger.child({ channel: "core.capture.alpha" });

  const thinking = (input.step.agentThinking ?? "").trim();
  const userPayload = [
    `STATE:`,
    input.step.userText.slice(0, 1_200) || "(none)",
    ``,
    `THINKING:`,
    thinking ? thinking.slice(0, 1_500) : "(none — model did not emit thinking this step)",
    ``,
    `ACTION:`,
    input.step.agentText.slice(0, 1_500) || "(none)",
    input.step.toolCalls.length > 0
      ? `\nTOOL_CALLS:\n${input.step.toolCalls
          .map((t) =>
            t.errorCode
              ? `- ${t.name}(${summarizeInput(t.input)}) → ERROR[${t.errorCode}] ${truncate(outputOf(t), 300)}`
              : `- ${t.name}(${summarizeInput(t.input)}) → ${truncate(outputOf(t), 300)}`,
          )
          .join("\n")}`
      : "\nTOOL_CALLS: (none)",
    ``,
    `OUTCOME:`,
    // Use the last 1 tool output as the "outcome" signal if present.
    lastToolOutcome(input.step),
    ``,
    `REFLECTION:`,
    input.reflectionText.slice(0, 1_500),
  ]
    .filter(Boolean)
    .join("\n");

  const rsp = await llm.completeJson<{
    alpha: unknown;
    usable: unknown;
    reason?: unknown;
  }>(
    [
      { role: "system", content: REFLECTION_SCORE_PROMPT.system },
      { role: "user", content: userPayload },
    ],
    {
      op: `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`,
      schemaHint: `{"alpha": 0..1, "usable": true|false, "reason": "short string"}`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        if (typeof o.alpha !== "number") {
          throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "alpha must be number", {
            got: o.alpha,
          });
        }
        if (typeof o.usable !== "boolean") {
          throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "usable must be boolean", {
            got: o.usable,
          });
        }
      },
      malformedRetries: 1,
      temperature: 0,
    },
  );

  const rawAlpha = rsp.value.alpha as number;
  const usable = Boolean(rsp.value.usable);
  const alpha = clamp01(rawAlpha);
  const finalAlpha = usable ? alpha : 0;
  const reason = typeof rsp.value.reason === "string" ? (rsp.value.reason as string) : null;

  log.debug("alpha.scored", {
    key: input.step.key,
    alpha: finalAlpha,
    usable,
    rawAlpha,
    model: rsp.servedBy,
  });

  return { alpha: finalAlpha, usable, reason, model: rsp.servedBy };
}

export function disabledScore(text: string | null, source: ReflectionScore["source"]): ReflectionScore {
  return {
    text,
    alpha: text ? 0.5 : 0,
    usable: text !== null,
    source,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
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

function outputOf(t: { output?: unknown }): string {
  if (t.output === undefined || t.output === null) return "";
  if (typeof t.output === "string") return t.output;
  try {
    return JSON.stringify(t.output);
  } catch {
    return String(t.output);
  }
}

function lastToolOutcome(step: NormalizedStep): string {
  const last = step.toolCalls[step.toolCalls.length - 1];
  if (!last) return "(assistant-only step)";
  return (last.errorCode ? `ERROR[${last.errorCode}] ` : "") + truncate(outputOf(last), 600);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
