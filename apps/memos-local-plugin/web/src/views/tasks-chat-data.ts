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
  assistantTextBefore?: string | null;
}

export interface TimelineTrace {
  id: string;
  ts?: number;
  turnId?: number;
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
  ts?: number;
  /** Stable id (trace id + suffix) — drives Preact key + DOM ids. */
  key: string;
  /** Trace id this message originates from (so we can deep-link later). */
  traceId: string;
  // Tool-only fields:
  toolName?: string;
  /** Visible assistant narration emitted before this tool call. */
  toolAssistantTextBefore?: string;
  /** Model reasoning immediately before this tool call. */
  toolThinking?: string;
  toolInput?: string;
  toolOutput?: string;
  toolDurationMs?: number;
  errorCode?: string;
  /**
   * V7 §0.1 / pi-agent-core "parallel" tool execution mode — when the
   * model emits ≥2 toolCalls in a single assistant message, the
   * executor fires them concurrently. The viewer wraps such siblings
   * in a single "并行批" card so users can tell parallel from serial
   * apart at a glance.
   *
   * Set on every member of a parallel batch (size ≥ 2). Single-tool
   * "batches" leave these fields undefined so the renderer skips the
   * wrapper. Computed by `assignParallelBatches` after `flattenChat`.
   *
   * The key is shared across all siblings (= `batch:${first.key}`)
   * so the renderer can `groupBy(key)` and emit one wrapper per run.
   */
  parallelBatchKey?: string;
  /** Number of tools in the batch this message belongs to (≥ 2). */
  parallelBatchSize?: number;
  /**
   * Wall-clock span of the batch in ms = `max(endedAt) - min(startedAt)`.
   * Surfaced in the batch header so users can see the parallelism
   * payoff: "3 个工具 · 总耗时 24ms" beats "12+8+24 = 44ms 串行".
   */
  parallelBatchTotalMs?: number;
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
 *   2. `tool` blocks — each tool call carries `assistantTextBefore`
 *      (visible pre-tool narration) and `thinkingBefore` (model
 *      reasoning) so the renderer can show the full think/say→act loop
 *      inside the corresponding tool card.
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
 * calls without a `startedAt` stay untimed in the UI.
 */
export function flattenChat(traces: readonly TimelineTrace[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const tr of traces) {
    const u = (tr.userText ?? "").trim();
    if (u) {
      out.push({
        role: "user",
        text: u,
        ts: tr.turnId ?? tr.ts,
        key: `${tr.id}:user`,
        traceId: tr.id,
      });
    }

    const tools = [...(tr.toolCalls ?? [])].sort((a, b) => {
      const at = a.startedAt ?? Number.POSITIVE_INFINITY;
      const bt = b.startedAt ?? Number.POSITIVE_INFINITY;
      return at - bt;
    });

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
      const assistantBefore = (tc.assistantTextBefore ?? "").trim();
      const tb = (tc.thinkingBefore ?? "").trim();
      const inputStr = serializeToolPayload(tc.input);
      const outputStr = serializeToolPayload(tc.output);
      const dur =
        tc.startedAt != null && tc.endedAt != null && tc.endedAt > tc.startedAt
          ? tc.endedAt - tc.startedAt
          : undefined;
      out.push({
        role: "tool",
        text: tc.name,
        ts: tc.startedAt,
        key: `${tr.id}:tool:${idx}`,
        traceId: tr.id,
        toolName: tc.name,
        toolAssistantTextBefore: assistantBefore || undefined,
        toolThinking: tb || undefined,
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
  // Walk the flattened list in a second pass and stamp parallel-batch
  // metadata onto runs of consecutive `tool` messages. Done after the
  // whole list is built so the heuristic can compare each tool to its
  // visible neighbour, regardless of which trace it came from.
  assignParallelBatches(out);
  return out;
}

// ─── assignParallelBatches: detect parallel tool batches ────────────────

/**
 * Threshold for "two tool calls came from the same assistant LLM message".
 *
 * pi-agent-core's parallel executor fires preflight serially then
 * launches all eligible tools via `runnableCalls.map(...)` (no await),
 * so siblings start within a few ms of each other in practice. A
 * sequential pair, by contrast, requires a full LLM round-trip
 * (typically 500ms — many seconds) between the previous tool's
 * completion and the next tool's start.
 *
 * 500ms gives generous headroom for the parallel side (slow preflight
 * with user-grant prompts can take ~100-200ms) while still being
 * far short of a real LLM round-trip on any provider we support.
 */
const PARALLEL_BATCH_GAP_MS = 500;

/**
 * Detect runs of consecutive `tool` messages that came from the same
 * assistant LLM message and stamp `parallelBatch*` metadata on every
 * member. Runs of size 1 are left untouched so the renderer doesn't
 * wrap solo tools.
 *
 * Detection rule (paired-comparison, walks the flattened list):
 *
 *   - `messages[i]` and `messages[i+1]` are both `tool`, and the next
 *     tool has no pre-tool assistant text / thinking (either means the
 *     model spoke up between the two tools, which can only happen in
 *     a new LLM turn).
 *   - `messages[i+1].ts - messages[i].ts < PARALLEL_BATCH_GAP_MS`
 *   - The calls' execution windows overlap. Fast sequential helper
 *     calls can start within a few ms of each other, but their next
 *     start lands after the previous end; those should stay serial.
 *
 * Mutates `messages` in place — cheap and avoids an extra allocation
 * pass since the function is called from `flattenChat` which already
 * owns the array.
 */
export function assignParallelBatches(messages: ChatMsg[]): void {
  let i = 0;
  while (i < messages.length) {
    if (messages[i]!.role !== "tool") {
      i++;
      continue;
    }
    // Find the longest run [i..j] of consecutive tool entries that
    // satisfy the start-spread test.
    let j = i;
    while (
      j + 1 < messages.length &&
      messages[j + 1]!.role === "tool" &&
      !messages[j + 1]!.toolAssistantTextBefore &&
      !messages[j + 1]!.toolThinking &&
      messages[j]!.ts != null &&
      messages[j + 1]!.ts != null &&
      messages[j + 1]!.ts - messages[j]!.ts < PARALLEL_BATCH_GAP_MS &&
      toolsOverlap(messages[j]!, messages[j + 1]!)
    ) {
      j++;
    }
    if (j > i) markBatch(messages, i, j);
    i = j + 1;
  }
}

function toolsOverlap(a: ChatMsg, b: ChatMsg): boolean {
  if (a.ts == null || b.ts == null) return false;
  if (a.toolDurationMs == null || b.toolDurationMs == null) return false;
  return b.ts < a.ts + a.toolDurationMs;
}

function markBatch(messages: ChatMsg[], from: number, to: number): void {
  const size = to - from + 1;
  if (size < 2) return;
  const key = `batch:${messages[from]!.key}`;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (let k = from; k <= to; k++) {
    const m = messages[k]!;
    if (m.ts == null) continue;
    minStart = Math.min(minStart, m.ts);
    maxEnd = Math.max(maxEnd, m.ts + (m.toolDurationMs ?? 0));
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return;
  const totalMs = Math.max(0, maxEnd - minStart);
  for (let k = from; k <= to; k++) {
    const m = messages[k]!;
    m.parallelBatchKey = key;
    m.parallelBatchSize = size;
    m.parallelBatchTotalMs = totalMs;
  }
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
