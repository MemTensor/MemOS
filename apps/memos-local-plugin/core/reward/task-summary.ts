/**
 * `task-summary` — builds the compact "what the agent tried to do" blurb
 * that the R_human scorer feeds to the LLM.
 *
 * V7 §0.6 scoring anchor: when a single episode spans multiple user
 * turns (the `merge_follow_ups` mode, default), the goal is NOT just
 * the first user message. Each follow-up is its own sub-goal the
 * agent has to address; the scorer needs the full chain to judge
 * whether the agent tracked the user's evolving intent. The previous
 * build pinned `USER_QUERY` to only the first user turn, which caused
 * multi-topic episodes (e.g. 上海天气 → 穿衣 → 带伞 → 北京天气) to be
 * marked as R<0 just because the final assistant reply did not match
 * the *opening* query — a false negative that kept real tasks out of
 * the L2/Skill pipeline.
 *
 * So we now emit a chronological USER_ASKS / AGENT_REPLIES block
 * covering every user turn paired with the agent's corresponding reply
 * (plus a per-step action summary for tool-call context). The scorer's
 * rubric is updated in parallel to judge "did the agent address every
 * user ask, especially the most recent one?" — see
 * `core/llm/prompts/reward.ts`.
 *
 * The result is clipped to `cfg.summaryMaxChars` with a head+tail
 * strategy — identical to `capture/normalizer.ts` — so the most recent
 * user↔agent exchange survives truncation (we keep the tail because
 * "did it end well?" matters most).
 */

import { rootLogger } from "../logger/index.js";
import type { TraceRow } from "../types.js";
import type { EpisodeSnapshot } from "../session/types.js";
import type { RewardConfig, TaskSummary } from "./types.js";

const TRUNC_MARKER = "\n…[truncated]…\n";

export interface SummaryInput {
  episode: EpisodeSnapshot;
  traces: readonly TraceRow[];
  cfg: Pick<RewardConfig, "summaryMaxChars">;
  evaluator?: {
    reflectionProvider?: string;
    reflectionModel?: string;
    scorerProvider?: string;
    scorerModel?: string;
  };
}

export function buildTaskSummary(input: SummaryInput): TaskSummary {
  const log = rootLogger.child({ channel: "core.reward.task-summary" });
  const { episode, traces, cfg } = input;

  // Anchor DTO fields prefer the live in-memory snapshot (it holds
  // the full user/assistant turn chain), then fall back to persisted
  // traces if the snapshot was evicted — without this fallback, an
  // evicted snapshot would poison R_human: empty summary → rHuman ≈ 0
  // → V stays flat → L2 pool never crosses `minTraceValue`.
  const userQuery = firstUserText(episode) ?? firstUserTextFromTraces(traces) ?? "(no user text)";
  const outcome = lastAgentText(episode) ?? lastAgentTextFromTraces(traces) ?? "(no agent text)";

  // For the multi-turn pairs block we prefer the episode snapshot's
  // `turns` — it faithfully preserves EVERY user turn in the merged
  // episode (including mid-topic pivots), not just the ones that
  // made it into traces. Trace-based pairs are the fallback for when
  // episode.turns is unavailable (evicted from memory).
  const pairs =
    episode.turns.length > 0
      ? episodeToPairs(episode)
      : traces.map(traceToPair).filter((p) => p !== null) as ExchangePair[];

  const pairsText = pairs.length > 0
    ? pairs.map((p, i) => formatPair(p, i)).join("\n\n")
    : "(no recorded exchanges)";

  const agentActions = traces.map(traceOneLiner).filter(Boolean).join("\n");
  const hostContext = formatHostAgentContext(episode, input.evaluator);

  const body = [
    hostContext ? `HOST_AGENT_CONTEXT:` : "",
    hostContext,
    hostContext ? `` : "",
    `USER_ASKS_AND_AGENT_REPLIES (${pairs.length}, in order):`,
    pairsText,
    ``,
    `AGENT_STEPS (${traces.length}):`,
    agentActions.length > 0 ? agentActions : "(no recorded steps)",
    ``,
    `MOST_RECENT_USER_ASK:`,
    oneLine(pairs.length > 0 ? pairs[pairs.length - 1]!.userText : userQuery, 500),
    ``,
    `MOST_RECENT_AGENT_REPLY:`,
    oneLine(pairs.length > 0 ? pairs[pairs.length - 1]!.agentText : outcome, 800),
  ].join("\n");

  const { text, truncated } = clampText(body, cfg.summaryMaxChars);

  if (truncated) {
    log.debug("summary.truncated", {
      episodeId: episode.id,
      originalLen: body.length,
      maxChars: cfg.summaryMaxChars,
    });
  }

  return {
    episodeId: episode.id,
    sessionId: episode.sessionId,
    hostContext,
    userQuery: oneLine(userQuery, 500),
    agentActions,
    outcome: oneLine(outcome, 800),
    text,
    truncated,
  };
}

function formatHostAgentContext(
  episode: EpisodeSnapshot,
  evaluator?: SummaryInput["evaluator"],
): string {
  const meta = episode.meta ?? {};
  const hints = isRecord(meta.contextHints) ? meta.contextHints : {};
  const fields: Array<[string, unknown]> = [
    ["agent", meta.agent],
    ["agentIdentity", hints.agentIdentity ?? meta.agentIdentity],
    ["hostProvider", hints.hostProvider ?? meta.hostProvider],
    ["hostModel", hints.hostModel ?? meta.hostModel],
    ["hostApiMode", hints.hostApiMode ?? meta.hostApiMode],
    ["reflectionProvider", evaluator?.reflectionProvider],
    ["reflectionModel", evaluator?.reflectionModel],
    ["scorerProvider", evaluator?.scorerProvider],
    ["scorerModel", evaluator?.scorerModel],
  ];
  const lines = fields
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}: ${oneLine(String(value), 240)}`);
  if (lines.length === 0) return "";
  lines.push(
    "gradingInstruction: Evaluate the host agent's answer in this host context; do not project the evaluator model's own identity, provider, or capabilities onto the host agent.",
  );
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface ExchangePair {
  userText: string;
  agentText: string;
  toolHint?: string;
}

function traceToPair(t: TraceRow): ExchangePair | null {
  const u = (t.userText ?? "").trim();
  const a = (t.agentText ?? "").trim();
  if (!u && !a) return null;
  const toolCalls = (t.toolCalls ?? []) as Array<{ name?: string; errorCode?: string }>;
  const toolHint = toolCalls.length > 0
    ? toolCalls
        .map((c) =>
          c.errorCode ? `${c.name ?? "tool"}[ERR:${c.errorCode}]` : c.name ?? "tool",
        )
        .join(", ")
    : undefined;
  return { userText: u, agentText: a, toolHint };
}

function formatPair(p: ExchangePair, idx: number): string {
  const lines: string[] = [`[${idx + 1}] USER: ${oneLine(p.userText, 300)}`];
  if (p.toolHint) lines.push(`    TOOLS: ${p.toolHint}`);
  lines.push(`    AGENT: ${oneLine(p.agentText, 400)}`);
  return lines.join("\n");
}

/**
 * Fallback when traces are empty: reconstruct exchange pairs by
 * walking the in-memory `episode.turns` (used for episodes that
 * finalized before any trace was persisted). We pair each user turn
 * with the next assistant turn — crude but good enough for scoring.
 */
function episodeToPairs(ep: EpisodeSnapshot): ExchangePair[] {
  const pairs: ExchangePair[] = [];
  let pendingUser: string | null = null;
  for (const turn of ep.turns) {
    if (turn.role === "user") {
      if (pendingUser != null) {
        // Two user turns with no assistant between — emit the first
        // with an empty reply so the LLM sees it.
        pairs.push({ userText: pendingUser, agentText: "" });
      }
      pendingUser = (turn.content ?? "").trim();
    } else if (turn.role === "assistant" && pendingUser != null) {
      pairs.push({
        userText: pendingUser,
        agentText: (turn.content ?? "").trim(),
      });
      pendingUser = null;
    }
  }
  if (pendingUser != null) {
    pairs.push({ userText: pendingUser, agentText: "" });
  }
  return pairs.filter((p) => p.userText.length > 0 || p.agentText.length > 0);
}

function firstUserText(ep: EpisodeSnapshot): string | null {
  const t = ep.turns.find((tt) => tt.role === "user" && tt.content.trim().length > 0);
  return t ? t.content.trim() : null;
}

function lastAgentText(ep: EpisodeSnapshot): string | null {
  for (let i = ep.turns.length - 1; i >= 0; i--) {
    const t = ep.turns[i]!;
    if (t.role === "assistant" && t.content.trim().length > 0) return t.content.trim();
  }
  return null;
}

/**
 * Trace-table fallbacks for when the in-memory episode snapshot has
 * been evicted. Traces are sorted by `ts` by the caller, so
 * `traces[0]` is the earliest turn and `traces[last]` is the latest.
 */
function firstUserTextFromTraces(traces: readonly TraceRow[]): string | null {
  for (const t of traces) {
    const s = (t.userText ?? "").trim();
    if (s.length > 0) return s;
  }
  return null;
}

function lastAgentTextFromTraces(traces: readonly TraceRow[]): string | null {
  for (let i = traces.length - 1; i >= 0; i--) {
    const s = (traces[i]!.agentText ?? "").trim();
    if (s.length > 0) return s;
  }
  return null;
}

function traceOneLiner(t: TraceRow, idx: number): string {
  const toolCalls = (t.toolCalls ?? []) as Array<{ name?: string; errorCode?: string }>;
  const actionHint =
    toolCalls.length > 0
      ? toolCalls
          .map((c) =>
            c.errorCode ? `${c.name ?? "tool"}[ERR:${c.errorCode}]` : c.name ?? "tool",
          )
          .join(", ")
      : (t.agentText ?? "").trim().slice(0, 120) || "(text only)";
  return `  ${idx + 1}. ${actionHint}`;
}

function oneLine(s: string, max: number): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clampText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const headLen = Math.floor((max - TRUNC_MARKER.length) * 0.55);
  const tailLen = max - TRUNC_MARKER.length - headLen;
  return {
    text: text.slice(0, headLen) + TRUNC_MARKER + text.slice(text.length - tailLen),
    truncated: true,
  };
}
