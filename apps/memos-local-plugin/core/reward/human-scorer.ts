/**
 * `human-scorer` — V7 §0.6 / §2.4.2 R_human pipeline.
 *
 * Takes a task summary + user feedback list and produces a signed scalar
 * R_human ∈ [-1, 1] plus per-axis sub-scores.
 *
 * Two scoring modes:
 *
 *   1. LLM mode (default): call `REWARD_R_HUMAN_PROMPT` with the summary
 *      and the user's raw text, parse `{goal_achievement, process_quality,
 *      user_satisfaction, label, reason}`, clamp each axis, and compute
 *      R_human as a weighted mean.
 *
 *   2. Heuristic fallback: map explicit-channel polarity directly to a
 *      fixed sub-score, or derive a very conservative score from implicit
 *      polarity + magnitude. Used when `cfg.llmScoring=false`, no LLM is
 *      wired, or the LLM throws.
 *
 * Weighted mean (V7 §0.6): we default to
 *     R_human = 0.45·goal_achievement
 *             + 0.30·process_quality
 *             + 0.25·user_satisfaction
 *
 * and clamp to [-1, 1]. The weights are documented in the viewer's reward
 * panel; changing them is a backwards-incompatible rubric change, so bump
 * the prompt `version` if you adjust.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { REWARD_R_HUMAN_PROMPT } from "../llm/prompts/reward.js";
import { rootLogger } from "../logger/index.js";
import type { HumanScore, HumanScoreInput, RewardConfig, UserFeedback } from "./types.js";

const AXIS_WEIGHTS = {
  goal_achievement: 0.45,
  process_quality: 0.3,
  user_satisfaction: 0.25,
} as const;

export interface ScoreOpts {
  /** If omitted, we force heuristic mode. */
  llm?: LlmClient | null;
  cfg: Pick<RewardConfig, "llmScoring">;
}

export async function scoreHuman(input: HumanScoreInput, opts: ScoreOpts): Promise<HumanScore> {
  const log = rootLogger.child({ channel: "core.reward.r-human" });

  const hasLlm = Boolean(opts.cfg.llmScoring && opts.llm);
  if (!hasLlm) {
    const reason = !opts.cfg.llmScoring
      ? "llmScoring disabled in config"
      : "llm client is null (provider not attached?)";
    log.warn("score.llm_unavailable", {
      episodeId: input.episodeSummary.episodeId,
      reason,
      feedbackCount: input.feedback.length,
      fallback: "heuristic",
    });
    const h = heuristicScore(input.feedback);
    return h;
  }

  try {
    const scored = await llmScore(input, opts.llm!);
    log.info("score.llm", {
      episodeId: input.episodeSummary.episodeId,
      rHuman: scored.rHuman,
      axes: scored.axes,
      model: scored.model,
    });
    return scored;
  } catch (err) {
    log.warn("score.llm_failed", {
      episodeId: input.episodeSummary.episodeId,
      err: errDetail(err),
    });
    const fallback = heuristicScore(input.feedback);
    return { ...fallback, source: "heuristic" };
  }
}

// ─── LLM path ──────────────────────────────────────────────────────────────

async function llmScore(input: HumanScoreInput, llm: LlmClient): Promise<HumanScore> {
  const feedbackText = formatFeedback(input.feedback);
  const userPayload = [
    `TASK_SUMMARY:`,
    input.episodeSummary.text,
    ``,
    `FEEDBACK:`,
    feedbackText || "(no user feedback yet)",
  ].join("\n");

  const rsp = await llm.completeJson<{
    goal_achievement: unknown;
    process_quality: unknown;
    user_satisfaction: unknown;
    label?: unknown;
    reason?: unknown;
  }>(
    [
      { role: "system", content: REWARD_R_HUMAN_PROMPT.system },
      { role: "user", content: userPayload },
    ],
    {
      op: `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`,
      schemaHint: `{"goal_achievement":-1..1,"process_quality":-1..1,"user_satisfaction":-1..1,"label":"…","reason":"…"}`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        for (const k of ["goal_achievement", "process_quality", "user_satisfaction"]) {
          if (typeof o[k] !== "number") {
            throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, `${k} must be a number`, { got: o[k] });
          }
        }
      },
      malformedRetries: 1,
      temperature: 0,
    },
  );

  const goal = clamp(rsp.value.goal_achievement as number, -1, 1);
  const proc = clamp(rsp.value.process_quality as number, -1, 1);
  const sat = clamp(rsp.value.user_satisfaction as number, -1, 1);
  const reason = typeof rsp.value.reason === "string" ? (rsp.value.reason as string) : null;

  const rHuman = combine(goal, proc, sat);

  return {
    rHuman,
    axes: { goalAchievement: goal, processQuality: proc, userSatisfaction: sat },
    reason,
    source: "llm",
    model: rsp.servedBy,
  };
}

// ─── Heuristic path ────────────────────────────────────────────────────────

export function heuristicScore(feedback: readonly UserFeedback[]): HumanScore {
  if (feedback.length === 0) {
    return {
      rHuman: 0,
      axes: { goalAchievement: 0, processQuality: 0, userSatisfaction: 0 },
      reason: "no user feedback",
      source: "heuristic",
      model: null,
    };
  }
  const explicit = feedback.find((f) => f.channel === "explicit") ?? feedback[0]!;
  // polarity → user_satisfaction mapping; we don't try to score goal/process
  // without an LLM (would require understanding the task).
  const sat = mapPolarity(explicit.polarity, explicit.magnitude);
  const rHuman = clamp(sat, -1, 1);
  return {
    rHuman,
    axes: { goalAchievement: 0, processQuality: 0, userSatisfaction: sat },
    reason: `heuristic polarity=${explicit.polarity} magnitude=${explicit.magnitude.toFixed(2)}`,
    source: explicit.channel === "explicit" ? "explicit" : "heuristic",
    model: null,
  };
}

function mapPolarity(polarity: UserFeedback["polarity"], magnitude: number): number {
  const base =
    polarity === "positive" ? 0.7 : polarity === "negative" ? -0.7 : polarity === "neutral" ? 0 : 0;
  // magnitude ∈ [0, 1]; we treat 1 as "strongly held" and scale from ±0.3 → ±1.
  const scale = 0.3 + 0.7 * clamp(magnitude, 0, 1);
  return clamp(base * scale * (1 / 0.7), -1, 1);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function formatFeedback(feedback: readonly UserFeedback[]): string {
  const lines: string[] = [];
  for (const f of feedback.slice(0, 8)) {
    const text = (f.text ?? f.rationale ?? "").trim();
    if (!text) continue;
    lines.push(`- [${f.channel}/${f.polarity}] ${text.slice(0, 800)}`);
  }
  return lines.join("\n");
}

function combine(goal: number, proc: number, sat: number): number {
  const raw =
    AXIS_WEIGHTS.goal_achievement * goal +
    AXIS_WEIGHTS.process_quality * proc +
    AXIS_WEIGHTS.user_satisfaction * sat;
  return clamp(raw, -1, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
