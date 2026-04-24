/**
 * `step-extractor` — the first stage of the capture pipeline.
 *
 * Converts an `EpisodeSnapshot` (from `core/session`) into a list of
 * `StepCandidate`s.
 *
 * V7 §0.1 granularity: one step ≈ one agent decision point:
 *   - A tool call (model thinking → tool input → tool output) is ONE step.
 *   - The final text response to the user is a SEPARATE step.
 *   - A pure assistant reply with no tool calls is ONE step (unchanged).
 *
 * For a turn where the agent called 5 tools then responded, the
 * extractor produces 6 sub-steps (5 tool + 1 response). Each tool
 * sub-step carries:
 *   - `userText`  = the original user message (shared context / state)
 *   - `agentText` = "" (the action is the tool call itself)
 *   - `toolCalls` = [single ToolCallDTO with input + output]
 *   - `agentThinking` = model thinking (first sub-step only, since
 *     the host provides thinking as a single blob)
 *   - `meta.turnId` = the user turn's `ts`. Stable identifier shared
 *     by every sub-step that came from the same user message — the
 *     viewer uses it to collapse the row of sub-steps back into a
 *     single "one round = one memory" card while the algorithm pipe-
 *     line keeps operating on the step-level traces.
 *
 * This matches the algorithm spec `f(1)_{k,t} = (s, a, o, ρ, r)` where
 * each tool invocation is an independent action `a` with its own
 * observation `o`, reflection `ρ`, and value `r`.
 *
 * The extractor is purely in-memory — no DB, no LLM.
 */

import type { ToolCallDTO } from "../../agent-contract/dto.js";
import { rootLogger } from "../logger/index.js";
import type { EpisodeSnapshot, EpisodeTurn } from "../session/types.js";
import type { EpochMs } from "../types.js";
import type { StepCandidate } from "./types.js";

export function extractSteps(episode: EpisodeSnapshot): StepCandidate[] {
  const log = rootLogger.child({ channel: "core.capture.extractor" });
  const out: StepCandidate[] = [];
  const turns = episode.turns;
  if (turns.length === 0) return [];

  // Strategy: split on user-role turns (same as before).
  const segments: EpisodeTurn[][] = [];
  let current: EpisodeTurn[] = [];

  for (const turn of turns) {
    if (turn.role === "user" && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(turn);
  }
  if (current.length > 0) segments.push(current);

  for (const segTurns of segments) {
    out.push(...segmentToSteps(segTurns, episode));
  }

  if (out.length === 0) {
    log.debug("extractor.synthetic_step", { episodeId: episode.id });
    const firstUser = turns.find((t) => t.role === "user");
    if (firstUser) {
      out.push({
        key: `${episode.id}:0`,
        ts: firstUser.ts,
        userText: firstUser.content,
        agentText: "",
        agentThinking: null,
        toolCalls: [],
        rawReflection: null,
        depth: depthFromMeta(episode.meta),
        isSubagent: Boolean(episode.meta.isSubagent),
        meta: { synthetic: true, turnId: firstUser.ts },
      });
    }
  }

  return out;
}

// ─── Segment → sub-steps ────────────────────────────────────────────────────

/**
 * Convert one segment (user turn + tool/assistant turns) into sub-steps.
 *
 * When tool turns are present, each tool call becomes its own step so
 * the batch scorer can assign individual reflections and α scores —
 * matching the algorithm spec's per-decision-point granularity.
 */
function segmentToSteps(
  turns: EpisodeTurn[],
  episode: EpisodeSnapshot,
): StepCandidate[] {
  // ─── Classify turns ────────────────────────────────────────────
  const userTexts: string[] = [];
  const toolTurns: EpisodeTurn[] = [];
  let lastAssistant: EpisodeTurn | null = null;
  const thinkingParts: string[] = [];
  let rawReflection: string | null = null;
  let segMeta: Record<string, unknown> = {};
  // Stable id shared by every sub-step of the same user message.
  // Defaults to the first user turn's `ts`; falls back to the first
  // turn's `ts` for assistant-only segments (rare, but the synthetic
  // step path also relies on this).
  let turnId: EpochMs | null = null;

  for (const turn of turns) {
    switch (turn.role) {
      case "user":
        userTexts.push(turn.content);
        if (turnId === null) turnId = turn.ts;
        break;
      case "tool":
        toolTurns.push(turn);
        break;
      case "assistant": {
        lastAssistant = turn;
        const m = turn.meta as Record<string, unknown> | undefined;
        if (!rawReflection) {
          const r = m?.reflection;
          if (typeof r === "string" && r.trim()) rawReflection = r.trim();
        }
        const th = m?.agentThinking;
        if (typeof th === "string" && th.trim()) thinkingParts.push(th.trim());
        if (m) segMeta = { ...segMeta, ...m };
        break;
      }
      // system turns are intentionally skipped
    }
  }

  if (!lastAssistant) return [];

  const userText = joinNonEmpty(userTexts, "\n---\n");
  const depth = depthFromMeta({ ...episode.meta, ...segMeta });
  const isSubagent = Boolean(segMeta.isSubagent ?? episode.meta.isSubagent);
  const fullThinking = thinkingParts.join("\n\n").trim() || null;
  // Fallback if the segment had no user turn (assistant-only segment
  // produced by some adapters): anchor turnId on the first turn we
  // ever saw so downstream group_by still has something stable.
  const segTurnId: EpochMs = (turnId ?? turns[0]!.ts);

  // ─── No tool calls → single step ──────────────────────────────
  if (toolTurns.length === 0) {
    const assistantTexts = turns
      .filter((t) => t.role === "assistant")
      .map((t) => t.content);
    const agentText = joinNonEmpty(assistantTexts, "\n\n");
    const metaToolCalls = collectToolCallsFromMeta(turns);

    return [{
      key: `${episode.id}:${lastAssistant.ts}`,
      ts: lastAssistant.ts,
      userText,
      agentText,
      agentThinking: fullThinking,
      toolCalls: metaToolCalls,
      rawReflection,
      depth,
      isSubagent,
      meta: { ...segMeta, turnId: segTurnId },
    }];
  }

  // ─── Tool calls present → one sub-step per tool call ──────────
  const out: StepCandidate[] = [];
  const assistantText = lastAssistant.content.trim();
  const hasResponse = assistantText.length > 0;
  const total = toolTurns.length + (hasResponse ? 1 : 0);

  // Guard against duplicate timestamps when tool turns are added
  // in a tight synchronous loop (Date.now() has ms resolution).
  const usedTs = new Set<EpochMs>();
  function uniqueTs(base: EpochMs): EpochMs {
    let t = base;
    while (usedTs.has(t)) t = (t + 1) as EpochMs;
    usedTs.add(t);
    return t;
  }

  for (let i = 0; i < toolTurns.length; i++) {
    const tt = toolTurns[i]!;
    const tc = toolCallFromTurn(tt);
    if (!tc) continue;

    const ts = uniqueTs(tt.ts);
    out.push({
      key: `${episode.id}:${ts}:tool:${i}`,
      ts,
      // Only the first sub-step carries the user query; subsequent
      // sub-steps leave `userText` empty so the viewer's flattenChat
      // doesn't render the same user bubble N times. The turn's
      // provenance (episodeId) still links them together.
      userText: i === 0 ? userText : "",
      agentText: "",
      agentThinking: i === 0 ? fullThinking : null,
      toolCalls: [tc],
      rawReflection: null,
      depth,
      isSubagent,
      meta: {
        ...segMeta,
        subStep: true,
        subStepIdx: i,
        subStepTotal: total,
        turnId: segTurnId,
      },
    });
  }

  if (hasResponse) {
    const ts = uniqueTs(lastAssistant.ts);
    out.push({
      key: `${episode.id}:${ts}:response`,
      ts,
      userText: "",
      agentText: assistantText,
      agentThinking: null,
      toolCalls: [],
      rawReflection,
      depth,
      isSubagent,
      meta: {
        ...segMeta,
        subStep: true,
        subStepIdx: toolTurns.length,
        subStepTotal: total,
        turnId: segTurnId,
      },
    });
  }

  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fallback: collect tool calls from assistant `meta.toolCalls` for
 * adapters that don't write separate `role: "tool"` turns.
 */
function collectToolCallsFromMeta(turns: EpisodeTurn[]): ToolCallDTO[] {
  const tcs: ToolCallDTO[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const metaTcs = (turn.meta as Record<string, unknown> | undefined)?.toolCalls;
    if (!Array.isArray(metaTcs)) continue;
    for (const raw of metaTcs) {
      const tc = coerceToolCall(raw);
      if (tc) tcs.push(tc);
    }
  }
  return tcs;
}

function toolCallFromTurn(turn: EpisodeTurn): ToolCallDTO | null {
  const meta = (turn.meta ?? {}) as Record<string, unknown>;
  const name = typeof meta.tool === "string" ? meta.tool : typeof meta.name === "string" ? meta.name : "unknown_tool";
  const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : turn.ts;
  const endedAt = typeof meta.endedAt === "number" ? meta.endedAt : turn.ts;
  const input = meta.input ?? meta.args ?? undefined;
  const errorCode = typeof meta.errorCode === "string" ? meta.errorCode : undefined;
  const thinkingBefore = typeof meta.thinkingBefore === "string" ? meta.thinkingBefore : undefined;
  return {
    name,
    input,
    output: turn.content,
    errorCode,
    startedAt,
    endedAt,
    thinkingBefore,
  };
}

/**
 * Best-effort coercion of an `assistant.meta.toolCalls[i]` blob into a
 * `ToolCallDTO`. We accept the rich shape the orchestrator writes
 * (`{ name, input, output, errorCode, startedAt, endedAt }`) plus the
 * lossy raw shape some adapters surface (`{ tool, args, result }`).
 */
function coerceToolCall(raw: unknown): ToolCallDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name =
    typeof r.name === "string"
      ? r.name
      : typeof r.tool === "string"
      ? r.tool
      : null;
  if (!name) return null;
  const input = r.input ?? r.args ?? undefined;
  const output = r.output ?? r.result ?? undefined;
  const errorCode = typeof r.errorCode === "string" ? r.errorCode : undefined;
  const startedAt =
    typeof r.startedAt === "number" ? r.startedAt : Date.now();
  const endedAt = typeof r.endedAt === "number" ? r.endedAt : startedAt;
  const thinkingBefore = typeof r.thinkingBefore === "string" ? r.thinkingBefore : undefined;
  return { name, input, output, errorCode, startedAt, endedAt, thinkingBefore };
}

function depthFromMeta(meta: Record<string, unknown>): number {
  const raw = meta.depth ?? meta.traceDepth ?? meta.subagentDepth;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 0;
}

function joinNonEmpty(parts: readonly string[], sep: string): string {
  return parts.map((s) => s.trim()).filter((s) => s.length > 0).join(sep);
}
