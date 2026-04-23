/**
 * Pure data layer for the Tasks drawer's conversation log.
 *
 * Kept JSX-free so it can be unit tested without a Preact renderer.
 * The rendering side (`tasks-chat.tsx`) consumes these types and the
 * `flattenChat` output to draw bubbles.
 */

// ─── Public DTOs ─────────────────────────────────────────────────────────

export interface TimelineToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  startedAt?: number;
  endedAt?: number;
  thinkingBefore?: string | null;
}

export interface TimelineTrace {
  id: string;
  ts: number;
  userText: string;
  agentText: string;
  /**
   * Raw LLM-native thinking emitted this turn (e.g. Claude extended
   * thinking, pi-ai `ThinkingContent`). Surfaces as a separate bubble
   * in the conversation log because it's part of what the model
   * actually said, not a synthetic post-hoc note.
   */
  agentThinking?: string | null;
  /**
   * MemOS-produced reflection used to compute α + V. Carried so the
   * trace drawer can render it in its own panel — but `flattenChat`
   * deliberately ignores it: the conversation log is the user↔agent
   * exchange, not the plugin's scoring scratchpad.
   */
  reflection?: string | null;
  value: number;
  toolCalls?: TimelineToolCall[];
}

export type ChatRole = "user" | "assistant" | "tool" | "thinking";

export interface ChatMsg {
  role: ChatRole;
  /** Plain-text body for `user` / `assistant` / `thinking`. */
  text: string;
  ts: number;
  /** Stable id (trace id + suffix) — drives Preact key + DOM ids. */
  key: string;
  /** Trace id this message originates from (so we can deep-link later). */
  traceId: string;
  // Tool-only fields:
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolDurationMs?: number;
  errorCode?: string;
}

// ─── flattenChat: trace[] → ChatMsg[] ────────────────────────────────────

const TOOL_INPUT_PREVIEW_CHARS = 1_200;
const TOOL_OUTPUT_PREVIEW_CHARS = 1_600;

/**
 * Convert a list of L1 traces into a linear chat log.
 *
 * Per-trace ordering — strictly the user↔agent exchange the user can
 * recognise, in pi-ai's natural emission order:
 *
 *   1. `user`       — the user query that opened the step (if non-empty).
 *   2. Interleaved `thinking` + `tool` blocks — each tool call's
 *      `thinkingBefore` is rendered as a thinking bubble directly
 *      before its tool, faithfully mirroring the model's think→act loop.
 *   3. `assistant`  — the assistant's final text reply (if non-empty).
 *
 * `trace.reflection` is **deliberately not** turned into a chat bubble.
 * Reflection is the MemOS plugin's own post-hoc note used to compute
 * α + R_human backprop — an internal scoring signal, not part of the
 * user↔agent conversation. The trace drawer surfaces it under a
 * dedicated "Reflection" panel.
 *
 * The function never throws on malformed input — missing fields are
 * dropped silently, unknown JSON is best-effort serialised, and tool
 * calls without a `startedAt` fall back to the trace's own `ts` for
 * sorting + display.
 */
export function flattenChat(traces: readonly TimelineTrace[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const tr of traces) {
    const u = (tr.userText ?? "").trim();
    if (u) {
      out.push({
        role: "user",
        text: u,
        ts: tr.ts,
        key: `${tr.id}:user`,
        traceId: tr.id,
      });
    }

    const tools = [...(tr.toolCalls ?? [])].sort(
      (a, b) => (a.startedAt ?? tr.ts) - (b.startedAt ?? tr.ts),
    );

    // When there are no tool calls, agentThinking (if present) appears
    // as a standalone thinking bubble. When tools exist, the per-tool
    // `thinkingBefore` fields carry the interleaved reasoning instead.
    if (tools.length === 0) {
      const thinking = (tr.agentThinking ?? "").trim();
      if (thinking) {
        out.push({
          role: "thinking",
          text: thinking,
          ts: tr.ts,
          key: `${tr.id}:thinking`,
          traceId: tr.id,
        });
      }
    }

    tools.forEach((tc, idx) => {
      const tb = (tc.thinkingBefore ?? "").trim();
      if (tb) {
        out.push({
          role: "thinking",
          text: tb,
          ts: tc.startedAt ?? tr.ts,
          key: `${tr.id}:thinking:${idx}`,
          traceId: tr.id,
        });
      }

      const inputStr = serializeToolPayload(tc.input);
      const outputStr = serializeToolPayload(tc.output);
      const dur =
        tc.startedAt != null && tc.endedAt != null && tc.endedAt > tc.startedAt
          ? tc.endedAt - tc.startedAt
          : undefined;
      out.push({
        role: "tool",
        text: tc.name,
        ts: tc.startedAt ?? tr.ts,
        key: `${tr.id}:tool:${idx}`,
        traceId: tr.id,
        toolName: tc.name,
        toolInput: inputStr ? clip(inputStr, TOOL_INPUT_PREVIEW_CHARS) : undefined,
        toolOutput: outputStr ? clip(outputStr, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
        toolDurationMs: dur,
        errorCode: tc.errorCode,
      });
    });

    const a = (tr.agentText ?? "").trim();
    if (a) {
      out.push({
        role: "assistant",
        text: a,
        ts: tr.ts,
        key: `${tr.id}:assistant`,
        traceId: tr.id,
      });
    }
  }
  return out;
}

function serializeToolPayload(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
