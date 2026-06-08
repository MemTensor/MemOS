/**
 * `task-summary` — builds the compact "what the agent tried to do" blurb
 * that the R_human scorer feeds to the LLM.
 *
 * V7 §0.6 scoring anchor: when a single episode spans multiple user
 * turns (the `merge_follow_ups` mode, default), the scorer needs both
 * a stable mission anchor and the chronological turn chain. The mission
 * tells `goal_achievement` what task is being graded; the turn chain
 * tells process/user-satisfaction scoring whether later turns were
 * corrections, verifier output, reflections, or a genuine task reset.
 *
 * So we emit EPISODE_MISSION plus a chronological USER_ASKS /
 * AGENT_REPLIES block covering every user turn paired with the agent's
 * corresponding reply (plus a per-step action summary for tool-call
 * context). See `core/llm/prompts/reward.ts` for the matching rubric.
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
    ? pairs.map((p, i) => formatPair(p, i, i === pairs.length - 1)).join("\n\n")
    : "(no recorded exchanges)";

  const agentActions = traces.map(traceOneLiner).filter(Boolean).join("\n");
  const hostContext = formatHostAgentContext(episode, input.evaluator);

  // EPISODE_MISSION: the canonical goal of this episode.
  // Prefer an explicitly updated canonicalGoal (set when the user
  // genuinely re-defines the task), then initialUserText recorded at
  // episode start, then the first user turn as last-resort fallback.
  // This is the stable anchor used by the reward scorer to evaluate
  // goal_achievement — independent of what the most recent user turn says.
  const missionText =
    (typeof episode.meta?.canonicalGoal === "string" && episode.meta.canonicalGoal.trim().length > 0)
      ? episode.meta.canonicalGoal.trim()
      : (typeof episode.meta?.initialUserText === "string" && episode.meta.initialUserText.trim().length > 0)
        ? episode.meta.initialUserText.trim()
        : userQuery;

  const body = [
    hostContext ? `HOST_AGENT_CONTEXT:` : "",
    hostContext,
    hostContext ? `` : "",
    `EPISODE_MISSION:`,
    oneLine(missionText, 800),
    ``,
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
    clampAgentText(pairs.length > 0 ? pairs[pairs.length - 1]!.agentText : outcome),
    ``,
    formatExecutionOutcome(traces),
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

function formatPair(p: ExchangePair, idx: number, isLast = false): string {
  const lines: string[] = [`[${idx + 1}] USER: ${oneLine(p.userText, 300)}`];
  if (p.toolHint) lines.push(`    TOOLS: ${p.toolHint}`);
  const agentSnippet = isLast ? clampAgentText(p.agentText) : oneLine(p.agentText, 400);
  lines.push(`    AGENT: ${agentSnippet}`);
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

const AGENT_TEXT_MAX = 5000;
const AGENT_TEXT_HEAD = 2000;
const AGENT_TEXT_TAIL = 3000;

function clampAgentText(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= AGENT_TEXT_MAX) return trimmed;
  return trimmed.slice(0, AGENT_TEXT_HEAD) + "\n......\n" + trimmed.slice(trimmed.length - AGENT_TEXT_TAIL);
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

// ─── execution outcome ───────────────────────────────────────────────────────

interface ExecutionOutcome {
  totalToolCalls: number;
  successCount: number;
  errorCount: number;
  lastToolResult: "SUCCESS" | "ERROR" | "NONE";
  lastToolName: string | null;
  lastErrorCode: string | null;
  taskCompletedByTool: "yes" | "no" | "unknown";
}

function buildExecutionOutcome(traces: readonly TraceRow[]): ExecutionOutcome {
  let totalToolCalls = 0;
  let successCount = 0;
  let errorCount = 0;

  const sorted = [...traces].sort((a, b) => a.ts - b.ts);

  let lastTraceWithTools: TraceRow | null = null;
  for (const trace of sorted) {
    const calls = (trace.toolCalls ?? []) as Array<{ name?: string; errorCode?: string }>;
    if (calls.length > 0) lastTraceWithTools = trace;
    for (const c of calls) {
      totalToolCalls++;
      if (c.errorCode) errorCount++;
      else successCount++;
    }
  }

  if (!lastTraceWithTools) {
    return {
      totalToolCalls: 0, successCount: 0, errorCount: 0,
      lastToolResult: "NONE", lastToolName: null, lastErrorCode: null,
      taskCompletedByTool: "unknown",
    };
  }

  const calls = (lastTraceWithTools.toolCalls ?? []) as Array<{ name?: string; errorCode?: string }>;
  const lastCall = calls[calls.length - 1]!;
  const lastToolResult: "SUCCESS" | "ERROR" = lastCall.errorCode ? "ERROR" : "SUCCESS";

  return {
    totalToolCalls,
    successCount,
    errorCount,
    lastToolResult,
    lastToolName: lastCall.name ?? null,
    lastErrorCode: lastCall.errorCode ?? null,
    taskCompletedByTool: lastToolResult === "SUCCESS" ? "yes" : "no",
  };
}

function formatExecutionOutcome(traces: readonly TraceRow[]): string {
  const o = buildExecutionOutcome(traces);
  const lines = ["EXECUTION_OUTCOME:"];
  if (o.totalToolCalls === 0) {
    lines.push("  total_tool_calls: 0");
    lines.push("  last_tool_result: NONE");
    lines.push("  task_completed_by_tool: unknown");
  } else {
    lines.push(`  total_tool_calls: ${o.totalToolCalls}  (success: ${o.successCount}, error: ${o.errorCount})`);
    const toolLabel = o.lastToolName ? `  [tool: ${o.lastToolName}]` : "";
    const errLabel = o.lastErrorCode ? `, code: ${o.lastErrorCode}` : "";
    lines.push(`  last_tool_result: ${o.lastToolResult}${toolLabel}${errLabel}`);
    lines.push(`  task_completed_by_tool: ${o.taskCompletedByTool}`);
  }
  return lines.join("\n");
}
