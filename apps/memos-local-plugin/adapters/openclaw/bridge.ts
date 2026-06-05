/**
 * OpenClaw ↔ MemoryCore bridge.
 *
 * Responsibilities (mirrors V7 §0.2 + §2.6 + §2.4.6):
 *   1. `before_prompt_build` → call `memoryCore.onTurnStart`, return a
 *      `prependContext` block with retrieved memory.
 *   2. `agent_end`          → derive a `TurnResultDTO` from messages,
 *      call `memoryCore.onTurnEnd`.
 *   3. `before_tool_call`   → start a tool-outcome timer per toolCallId.
 *   4. `after_tool_call`    → emit `recordToolOutcome` with duration +
 *      success flag so decision-repair can fire.
 *   5. `session_start` / `session_end` → open/close core session.
 *
 * This module imports *only* TypeScript types from `./openclaw-api.ts`.
 * It never pulls in `openclaw/plugin-sdk` at runtime; the host provides
 * the `OpenClawPluginApi` instance at plugin-load time.
 *
 * Shape fidelity: the handler signatures match
 * `openclaw/src/plugins/hook-types.ts::PluginHookHandlerMap`. When
 * OpenClaw updates the SDK, only `openclaw-api.ts` needs to be adjusted.
 */
import type {
  AgentKind,
  EpisodeId,
  RetrievalResultDTO,
  RuntimeNamespace,
  SessionId,
  ToolCallDTO,
  TurnInputDTO,
  TurnResultDTO,
} from "../../agent-contract/dto.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";

import type {
  AfterToolCallEvent,
  AgentEndEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  BeforeToolCallEvent,
  HostLogger,
  PluginHookAgentContext,
  PluginHookSessionContext,
  PluginHookSubagentContext,
  PluginHookToolContext,
  SessionEndEvent,
  SessionStartEvent,
  SubagentEndedEvent,
  SubagentSpawnedEvent,
  ToolResultPersistEvent,
} from "./openclaw-api.js";

// ─── Message flattening ────────────────────────────────────────────────────
//
// The wire format `agent_end` ships is `pi-agent-core::AgentMessage[]`,
// which is a discriminated union over `pi-ai::Message`:
//   - `role: "user"`        — content `string | (TextContent|ImageContent)[]`
//   - `role: "assistant"`   — content `(TextContent | ThinkingContent | ToolCall)[]`
//   - `role: "toolResult"`  — { toolCallId, toolName, content: (Text|Image)[], isError }
//
// We also accept legacy OpenAI-style payloads that older tests / hosts
// emit:
//   - `role: "tool" | "tool_result" | "tool_response"` for tool results
//     with `tool_call_id` + flat string `content`
//   - assistant with a top-level `tool_calls: [{id, function:{name,arguments}}]`
//
// `flattenMessages` returns one `FlatMessage` per *atomic* event so the
// chronology survives intact: a single assistant message with thinking +
// 2 tool calls becomes 4 entries (text → thinking → toolCall × 2). This
// keeps the conversation log honest and lets `extractTurn` rebuild the
// canonical `CapturedTurn` without losing any of the model's output.

const TOOL_RESULT_ROLES = new Set([
  "toolResult",      // pi-ai canonical
  "toolresult",      // lower-case gateway/UI normalizer variants
  "tool",            // OpenAI legacy
  "tool_result",     // some Anthropic SDKs / older bridges
  "tool_response",   // older variants
]);
const ASSISTANT_ROLES = new Set(["assistant", "model"]);

export interface FlatMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "thinking" | "system";
  /** Plain-text body. Empty for tool-call / pure-thinking entries. */
  content: string;
  toolName?: string;
  toolCallId?: string;
  /** For `tool_call` entries — parsed arguments. */
  toolInput?: unknown;
  /** Flag set on tool_result entries when the tool itself errored. */
  isError?: boolean;
  errorCode?: string;
  ts?: number;
}

/**
 * Flatten an OpenClaw `AgentMessage[]` (pi-ai shape) into a fully
 * role-typed event list.
 *
 * Failure modes are deliberate no-ops: malformed entries are skipped
 * silently. Anything truly unrecognised does NOT silently get coerced
 * into "user" — that was the bug that caused tool stdout to be stored
 * as user_text. Unknown roles are simply ignored.
 */
export function flattenMessages(input: unknown[] | undefined): FlatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: FlatMessage[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const rawRole = typeof m.role === "string" ? m.role : "";
    if (!rawRole) continue;
    const ts = pickTimestamp(m);

    // ─── User ─────────────────────────────────────────────────────────
    if (rawRole === "user") {
      const text = stripOpenClawUserEnvelope(extractTextContent(m.content));
      out.push({ role: "user", content: text.trim(), ts });
      continue;
    }

    // ─── Tool result (pi-ai `toolResult` / OpenAI `tool` legacy) ──────
    if (TOOL_RESULT_ROLES.has(rawRole)) {
      const toolName =
        (typeof m.toolName === "string" ? m.toolName : undefined) ??
        (typeof m.name === "string" ? m.name : undefined);
      const toolCallId =
        (typeof m.toolCallId === "string" ? m.toolCallId : undefined) ??
        (typeof m.tool_call_id === "string" ? m.tool_call_id : undefined);
      const isError =
        typeof m.isError === "boolean" ? m.isError : undefined;
      const errorCode =
        typeof m.errorCode === "string" ? m.errorCode : undefined;
      out.push({
        role: "tool_result",
        content: extractTextContent(m.content).trim(),
        toolName,
        toolCallId,
        isError,
        errorCode,
        ts,
      });
      continue;
    }

    // ─── Assistant (pi-ai content blocks + OpenAI `tool_calls` legacy) ──
    if (ASSISTANT_ROLES.has(rawRole)) {
      // pi-ai shape: content is an array of {type: "text"|"thinking"|"toolCall"} blocks.
      const blocks = Array.isArray(m.content) ? m.content : [];
      let textBuf = "";
      let thinkingBuf = "";
      const inlineToolCalls: FlatMessage[] = [];
      for (const blk of blocks) {
        if (!blk || typeof blk !== "object") continue;
        const b = blk as Record<string, unknown>;
        const type = typeof b.type === "string" ? b.type : "";
        if (type === "text" && typeof b.text === "string") {
          textBuf += (textBuf ? "\n" : "") + b.text;
        } else if (type === "thinking" && typeof b.thinking === "string") {
          thinkingBuf += (thinkingBuf ? "\n\n" : "") + b.thinking;
        } else if (isToolCallBlockType(type)) {
          inlineToolCalls.push({
            role: "tool_call",
            content: "",
            toolName: typeof b.name === "string" ? b.name : "unknown",
            toolCallId: pickToolCallId(b, m),
            toolInput: pickToolInput(b),
            ts,
          });
        } else if (!type && typeof b.text === "string") {
          // Legacy Anthropic-style block lacking an explicit `type`
          // but carrying a `text` field. Treat as text so older
          // adapters / fixtures keep working.
          textBuf += (textBuf ? "\n" : "") + b.text;
        }
        // ImageContent / unknown content blocks are ignored — we only
        // surface text-shaped data in the chat log.
      }

      // Permissive fallback: some pi-ai builds and older OpenAI shapes
      // store assistant text directly as a string.
      if (!textBuf && typeof m.content === "string") {
        textBuf = m.content;
      }

      // Emit the in-message order: thinking comes before text in
      // pi-ai's stream (the model thinks, then writes), so put it
      // first. Tool calls always come after text in our log because
      // they're the action the model decided to take.
      if (thinkingBuf.trim()) {
        out.push({ role: "thinking", content: thinkingBuf.trim(), ts });
      }
      if (textBuf.trim()) {
        out.push({ role: "assistant", content: textBuf.trim(), ts });
      }
      for (const tc of inlineToolCalls) out.push(tc);

      // OpenAI-legacy fallback only: when the message has NO pi-ai
      // inline tool calls but does have a top-level `tool_calls` array
      // (pure OpenAI Function-Calling shape). When both shapes coexist
      // (as OpenClaw's pi-ai bundled OpenAI adapter does), pi-ai
      // already populated `content[].toolCall`, so re-reading the
      // top-level field would emit each call twice — which in turn
      // causes `extractTurn`'s `pendingCalls.set(key, …)` to clobber
      // the first stub's `thinkingBefore` with an empty second stub.
      if (inlineToolCalls.length === 0 && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (!fn) continue;
          const name = typeof fn.name === "string" ? fn.name : "unknown";
          let parsed: unknown = undefined;
          if (typeof fn.arguments === "string") {
            try {
              parsed = JSON.parse(fn.arguments);
            } catch {
              parsed = fn.arguments;
            }
          } else if (typeof fn.arguments === "object") {
            parsed = fn.arguments;
          }
          out.push({
            role: "tool_call",
            content: "",
            toolName: name,
            toolCallId: typeof tc.id === "string" ? tc.id : undefined,
            toolInput: parsed,
            ts,
          });
        }
      }
      continue;
    }

    if (rawRole === "system") {
      out.push({
        role: "system",
        content: extractTextContent(m.content).trim(),
        ts,
      });
      continue;
    }

    // Unrecognised role — drop silently. NEVER coerce to "user"; that
    // was the bug where tool stdout got captured as user input because
    // an unknown role landed in the user slot.
  }

  return out;
}

function isToolCallBlockType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "functioncall" ||
    normalized === "function_call"
  );
}

function pickToolCallId(
  block: Record<string, unknown>,
  message?: Record<string, unknown>,
): string | undefined {
  return firstString(
    block.id,
    block.toolCallId,
    block.tool_call_id,
    block.callId,
    block.call_id,
    block.toolUseId,
    block.tool_use_id,
    message?.toolCallId,
    message?.tool_call_id,
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function pickToolInput(block: Record<string, unknown>): unknown {
  if ("arguments" in block) return block.arguments;
  if ("args" in block) return block.args;
  if ("input" in block) return block.input;
  if (typeof block.partialJson === "string") {
    try {
      return JSON.parse(block.partialJson);
    } catch {
      return block.partialJson;
    }
  }
  if (typeof block.partialArgs === "string") {
    try {
      return JSON.parse(block.partialArgs);
    } catch {
      return block.partialArgs;
    }
  }
  return undefined;
}

/**
 * Extract the visible text from a `Message.content` value, supporting
 * both the pi-ai shapes (string OR `(TextContent|ImageContent)[]`) and
 * older Anthropic-style content blocks (`{ text }` or `{ content }`).
 * Image / non-text blocks are ignored — they're not meaningful in a
 * text-shaped chat log.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") {
      out += (out ? "\n" : "") + b.text;
    } else if (typeof b.content === "string") {
      out += (out ? "\n" : "") + b.content;
    }
  }
  return out;
}

function pickTimestamp(m: Record<string, unknown>): number | undefined {
  const candidates = [m.ts, m.timestamp, m.time, m.createdAt];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string") {
      const parsed = Date.parse(c);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Strip OpenClaw-specific envelopes from a user message before capture.
 *
 * OpenClaw wraps inbound user text in up to three layers that are
 * **runtime metadata** and must not leak into stored memories:
 *
 *   1. `<memos_context>...</memos_context>` — our own prompt injection,
 *      echoed back to us on the next `agent_end`.
 *   2. `Sender (untrusted metadata):\n\`\`\`json\n{...}\n\`\`\`` — the
 *      untrusted sender envelope OpenClaw wraps around inbound channel
 *      messages.
 *   3. `[Thu 2026-03-05 15:23 GMT+8] ` — the host-applied timestamp
 *      prefix on the first line.
 *
 * We peel them off in that order; each layer is optional. The
 * implementation mirrors the legacy `memos-local-openclaw` adapter
 * byte-for-byte so captured rows look identical to the older plugin.
 */
/**
 * System-level sentinel prefixes OpenClaw injects into the user slot
 * that are NOT real user input and must never be captured as memory.
 * We mirror `memos-local-openclaw`'s `BOOT_CHECK_RE` /
 * `SYSTEM_BOILERPLATE_RE` filters one-to-one.
 */
const OPENCLAW_BOOT_SIGNATURES: readonly string[] = [
  "You are running a boot check",
  "Read HEARTBEAT.md if it exists",
  "## Memory system — ACTION REQUIRED",
  "Bootstrap files like SOUL.md",
  "A new session was started via /new",
  "A new session was started via /reset",
  "BEGIN_QUOTED_NOTES",
  // V7 — heartbeat / cron / async-exec wakeup prompts. OpenClaw
  // synthesises these as if they were user input so the agent comes
  // out of idle and processes the side-channel event. They are NOT
  // user-typed content; capturing them as an L1 trace pollutes the
  // Memories panel and creates phantom episodes (one per heartbeat).
  // Source signatures live in OpenClaw `infra/heartbeat-events-filter.ts`
  // and `auto-reply/reply/session-reset-prompt.ts`.
  "An async command you ran earlier has completed",
  "A scheduled reminder has been triggered",
  "A scheduled cron event was triggered",
  "Run the following periodic tasks",
  "When reading HEARTBEAT.md",
];

const OPENCLAW_SENTINEL_REPLIES = new Set([
  "NO_REPLY",
  "HEARTBEAT_OK",
  "HEARTBEAT_CHECK",
]);

const OPENCLAW_INBOUND_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

/**
 * Return `true` when a user-slot message is actually OpenClaw
 * runtime bootstrap / boot-check / sentinel reply and should be
 * dropped entirely (not captured, not passed to retrieval).
 */
export function isOpenClawBootstrapMessage(raw: string): boolean {
  const text = raw.trim();
  if (text.length === 0) return true;
  if (OPENCLAW_SENTINEL_REPLIES.has(text)) return true;
  if (isOpenClawSubagentAnnouncementPrompt(text)) return false;
  for (const sig of OPENCLAW_BOOT_SIGNATURES) {
    if (text.startsWith(sig)) return true;
    if (text.includes(sig)) {
      // Some bootstrap sentinels appear mid-blob (e.g. the bootstrap
      // prelude that later embeds "A new session was started"). If
      // the blob is long and contains no trailing human-typed line,
      // treat the whole thing as bootstrap.
      if (text.length > 400 && !looksLikeHumanTail(text)) return true;
    }
  }
  return false;
}

function isOpenClawSubagentAnnouncementPrompt(raw: string): boolean {
  const text = raw.trim();
  return text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
    text.includes("A completed subagent task is ready for user delivery");
}

/**
 * Returns true when the blob looks like it ends with a short
 * human-typed line — in that case we keep the tail (see
 * `stripOpenClawUserEnvelope`). Heuristic: the last non-empty line is
 * ≤ 200 chars AND doesn't look like a system directive.
 */
function looksLikeHumanTail(text: string): boolean {
  const lines = text.split(/\n+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l) continue;
    if (l.length > 200) return false;
    if (
      l.startsWith("Current time:") ||
      l.startsWith("Reply with ONLY") ||
      l.startsWith("[Untrusted")
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function stripOpenClawUserEnvelope(raw: string): string {
  let text = raw;

  // 1. <memos_context> / <memory_context> wrappers — these are our own
  // echoed prompt injection. Drop the whole block, keep surrounding
  // text. The legacy adapter removes both spellings.
  for (const tag of ["memos_context", "memory_context"]) {
    const open = text.indexOf(`<${tag}>`);
    if (open !== -1) {
      const close = text.indexOf(`</${tag}>`);
      if (close !== -1) {
        text = (text.slice(0, open) + text.slice(close + tag.length + 3)).trim();
      } else {
        text = text.slice(0, open).trim();
      }
    }
  }

  // 2. Block-level memory injections the host re-serialises at the
  // top of the user message (old MemOS plugins did this). Mirror the
  // legacy stripMemoryInjection regex set.
  text = text.replace(
    /=== MemOS LONG-TERM MEMORY[\s\S]*?(?:MANDATORY[^\n]*\n?|(?=\n{2,}))/gi,
    "",
  );
  text = text.replace(
    /\[MemOS Auto-Recall\][^\n]*\n(?:(?:\d+\.\s+\[(?:USER|ASSISTANT)[^\n]*\n?)*)/gi,
    "",
  );
  text = text.replace(
    /## Memory system\n+No memories were automatically recalled[^\n]*(?:\n[^\n]*memos_search[^\n]*)*/gi,
    "",
  );

  // 3. Drop `Sender (untrusted metadata):` and siblings, along with
  // their fenced-json payload.
  for (const sentinel of OPENCLAW_INBOUND_SENTINELS) {
    const idx = text.indexOf(sentinel);
    if (idx === -1) continue;
    const before = text.slice(0, idx);
    const after = text.slice(idx + sentinel.length);
    // Drop the ```json...``` block that always follows.
    const jsonOpen = after.indexOf("```json");
    let tail: string;
    if (jsonOpen !== -1) {
      const jsonClose = after.indexOf("```", jsonOpen + 7);
      tail = jsonClose !== -1 ? after.slice(jsonClose + 3) : after;
    } else {
      // No fence: drop until first blank line.
      const blank = after.indexOf("\n\n");
      tail = blank !== -1 ? after.slice(blank + 2) : "";
    }
    text = (before + "\n" + tail).trim();
  }

  // 4. Leading timestamp like "[Thu 2026-03-05 15:23 GMT+8] "
  text = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[^\]]+\]\s*/, "");

  // 5. Inline envelope tags OpenClaw leaves behind.
  text = text.replace(/\[message_id:\s*[a-f0-9-]+\]/gi, "");
  text = text.replace(/\[\[reply_to_current\]\]/gi, "");

  // 6. Line-level OpenClaw side-channel injections. OpenClaw appends
  // accumulated system events to the top of synthesised user prompts,
  // each line prefixed with `System (untrusted): [ts] …` (see
  // `openclaw/src/auto-reply/reply/session-system-events.ts`). It also
  // appends a `Current time: …` footer (`appendCronStyleCurrentTimeLine`)
  // and an `[Untrusted …]` envelope on inbound messages. Drop these
  // lines wholesale — they're never user-typed content, and leaving
  // them in pollutes the Memories panel + tricks the relation
  // classifier into thinking the user actually said them.
  text = text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines so paragraph breaks survive
      if (/^System(?:\s+\(untrusted\))?:/.test(t)) return false;
      if (/^Current time:/i.test(t)) return false;
      if (/^\[Untrusted\b/.test(t)) return false;
      if (/^When reading HEARTBEAT\.md/i.test(t)) return false;
      return true;
    })
    .join("\n");

  return text.trim();
}

// ─── Turn extraction ───────────────────────────────────────────────────────

export interface CapturedTurn {
  userText: string;
  agentText: string;
  /**
   * LLM-native thinking captured this turn (Claude extended-thinking,
   * pi-ai `ThinkingContent`, …). Belongs to the conversation log,
   * NOT to the plugin's reflection / scoring path.
   */
  agentThinking?: string;
  toolCalls: ToolCallDTO[];
  reflection?: string;
}

/**
 * Derive a single `user → assistant` turn from the tail of the message
 * list. Algorithm:
 *
 *   1. Walk backward to the last `user` message — that's the prompt
 *      this turn answers. Anything older is from prior turns.
 *   2. Everything after that user message belongs to this turn:
 *      assistant text, model thinking blocks, tool calls (assistant
 *      side), and the matching tool results (independent role).
 *   3. Pair `tool_call` (issued by assistant) with `tool_result`
 *      (separate role) by `toolCallId`; fall back to `toolName` when
 *      the host doesn't pass an id.
 *
 * The function never throws — malformed entries are dropped silently
 * so a single bad message can't poison the whole capture.
 */
export function extractTurn(messages: FlatMessage[], now: number): CapturedTurn | null {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;

  const userText = messages[lastUserIdx].content.trim();
  const tail = messages.slice(lastUserIdx + 1);

  type PendingToolCall = Partial<ToolCallDTO> & { _id?: string };
  const pendingCalls = new Map<string, PendingToolCall[]>();
  const toolCalls: ToolCallDTO[] = [];

  const enqueuePendingCall = (key: string, stub: PendingToolCall): void => {
    const queue = pendingCalls.get(key);
    if (queue) {
      queue.push(stub);
    } else {
      pendingCalls.set(key, [stub]);
    }
  };
  const takePendingCall = (key: string): PendingToolCall | undefined => {
    const queue = pendingCalls.get(key);
    if (!queue || queue.length === 0) return undefined;
    const stub = queue.shift();
    if (queue.length === 0) pendingCalls.delete(key);
    return stub;
  };

  // Two separate buffers accumulate content not yet assigned to a tool.
  //
  // `pendingThinking`: Claude extended-thinking blocks (`ThinkingContent`)
  // `pendingAssistant`: regular model text (`TextContent`)
  //
  // When a `tool_call` arrives, BOTH buffers are flushed together into
  // that tool's `thinkingBefore` — this is the reasoning (structured OR
  // natural language) the model did before deciding to invoke the tool.
  //
  // After all messages are processed, whatever remains in the buffers
  // forms the final output: `pendingAssistant` → `agentText` (the
  // reply) and `pendingThinking` → `agentThinking` (model reasoning
  // shown in a dedicated bubble for non-tool turns).
  let pendingThinking: string[] = [];
  let pendingAssistant: string[] = [];

  for (const m of tail) {
    if (m.role === "assistant") {
      if (m.content) pendingAssistant.push(m.content);
      continue;
    }
    if (m.role === "thinking") {
      if (m.content) pendingThinking.push(m.content);
      continue;
    }
    if (m.role === "tool_call" && m.toolName) {
      const parts = [...pendingThinking, ...pendingAssistant];
      const thinkingBefore = parts.join("\n\n").trim() || undefined;
      pendingThinking = [];
      pendingAssistant = [];

      const key = m.toolCallId ?? m.toolName;
      enqueuePendingCall(key, {
        _id: m.toolCallId,
        name: m.toolName,
        input: m.toolInput,
        startedAt: m.ts ?? now,
        thinkingBefore,
      });
      continue;
    }
    if (m.role === "tool_result") {
      const key = m.toolCallId ?? m.toolName ?? "";
      const stub = key ? takePendingCall(key) : undefined;
      const errorCode = stub
        ? m.errorCode ?? (m.isError ? "tool_error" : undefined)
        : m.errorCode ?? (m.isError ? "tool_error" : undefined);
      toolCalls.push({
        name: stub?.name ?? m.toolName ?? "unknown",
        input: stub?.input,
        output: m.content || undefined,
        errorCode,
        toolCallId: stub?._id ?? m.toolCallId,
        startedAt: stub?.startedAt ?? (m.ts ?? now),
        endedAt: m.ts ?? now,
        thinkingBefore: stub?.thinkingBefore,
      });
      continue;
    }
  }

  for (const queue of pendingCalls.values()) {
    for (const stub of queue) {
      if (!stub.name) continue;
      toolCalls.push({
        name: stub.name,
        input: stub.input,
        output: undefined,
        toolCallId: stub._id,
        startedAt: stub.startedAt ?? now,
        endedAt: now,
        thinkingBefore: stub.thinkingBefore,
      });
    }
  }

  const agentThinking = pendingThinking.join("\n\n").trim();
  return {
    userText,
    agentText: pendingAssistant.join("\n\n").trim(),
    agentThinking: agentThinking || undefined,
    toolCalls,
  };
}

function mergeToolCalls(
  captured: readonly ToolCallDTO[],
  observed: readonly ToolCallDTO[],
): ToolCallDTO[] {
  if (observed.length === 0) return [...captured];
  const out = captured.map((tc) => ({ ...tc }));
  for (const obs of observed) {
    const idx = out.findIndex((existing) => toolCallsMatch(existing, obs));
    if (idx >= 0) {
      out[idx] = mergeToolCall(out[idx]!, obs);
    } else {
      out.push({ ...obs });
    }
  }
  return out.sort((a, b) => {
    const at = a.startedAt ?? a.endedAt ?? 0;
    const bt = b.startedAt ?? b.endedAt ?? 0;
    return at - bt;
  });
}

function mergeToolCall(existing: ToolCallDTO, observed: ToolCallDTO): ToolCallDTO {
  return {
    ...observed,
    ...existing,
    input: existing.input ?? observed.input,
    output: existing.output ?? observed.output,
    errorCode: existing.errorCode ?? observed.errorCode,
    toolCallId: existing.toolCallId ?? observed.toolCallId,
    startedAt: existing.startedAt ?? observed.startedAt,
    endedAt: existing.endedAt ?? observed.endedAt,
    thinkingBefore: existing.thinkingBefore ?? observed.thinkingBefore,
    assistantTextBefore: existing.assistantTextBefore ?? observed.assistantTextBefore,
  };
}

function toolCallsMatch(a: ToolCallDTO, b: ToolCallDTO): boolean {
  if (a.toolCallId && b.toolCallId) return a.toolCallId === b.toolCallId;
  if (a.toolCallId || b.toolCallId) return false;
  return a.name === b.name && stableStringify(a.input) === stableStringify(b.input);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─── Session identity ──────────────────────────────────────────────────────

/**
 * Map OpenClaw `(agentId, sessionKey)` → stable core `SessionId`.
 *
 * OpenClaw regenerates `sessionId` on `/new` and `/reset`. That would
 * reset our V7 §0.1 "follow-up vs new task" tracking. `sessionKey` is
 * the durable identifier (per conversation thread), so we key on it.
 */
export function bridgeSessionId(agentId: string, sessionKey: string): SessionId {
  return `openclaw::${agentId}::${sessionKey}`;
}

function namespaceFromAgentCtx(ctx: {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
}): RuntimeNamespace {
  const profileId = (ctx.agentId || "main").trim() || "main";
  const workspacePath = ctx.workspaceDir || ctx.agentDir || undefined;
  return {
    agentKind: "openclaw",
    profileId,
    profileLabel: profileId,
    workspacePath,
    sessionKey: ctx.sessionKey,
  };
}

/**
 * Ephemeral OpenClaw sub-agents (slug generator, boot-check probes,
 * approval prompts, …) open their own run inside the same plugin host
 * and carry a conventional `temp:*` sessionKey. They are NOT user
 * conversations — capturing them pollutes the Tasks panel with empty
 * "未命名任务" rows, skews L2 induction, and costs LLM calls on
 * reflection / relation classification.
 *
 * Source of truth: `openclaw/src/hooks/llm-slug-generator.ts#67` sets
 * `sessionKey: "temp:slug-generator"`. Other internal runners may use
 * the same `temp:*` prefix going forward, so we filter the whole
 * namespace.
 */
export function isEphemeralSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  return sessionKey.startsWith("temp:");
}

function isExplicitOneShotSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":explicit:");
}

// ─── Prompt injection rendering ────────────────────────────────────────────

const CONTEXT_OPEN = "<memos_context>";
const CONTEXT_CLOSE = "</memos_context>";
const OPENCLAW_CONTEXT_CHAR_CAP = 6_000;
const BEFORE_PROMPT_SOFT_TIMEOUT_MS = Number.parseInt(
  process.env.MEMOS_BEFORE_PROMPT_SOFT_TIMEOUT_MS ?? "12000",
  10,
);
const AGENT_END_BINDING_CAP_MS = Math.min(
  60_000,
  BEFORE_PROMPT_SOFT_TIMEOUT_MS * 5,
);
const TOOL_FAILURE_REPAIR_HINT =
  "This tool has failed multiple times in a row. You may want to call `memos_search` for relevant past experience before deciding what to do next.";
const TOOL_FAILURE_HINT_THRESHOLD = 3;

/**
 * Render the retrieval result as a prompt-prependable block.
 *
 * Callers may opt into a short cold-start hint when the store has no
 * hits. The automatic OpenClaw before-prompt path disables that hint so
 * no-hit turns continue with the user's prompt instead of injecting
 * extra context.
 */
export function renderContextBlock(
  packet: RetrievalResultDTO | null,
  opts: { hintWhenEmpty?: boolean } = {},
): string {
  if (!packet) return "";
  const rendered = typeof packet.injectedContext === "string" ? packet.injectedContext.trim() : "";
  if (rendered) {
    return `${CONTEXT_OPEN}\n${rendered}\n${CONTEXT_CLOSE}`;
  }
  if (opts.hintWhenEmpty === false) return "";
  // Cold-start hint for interactive sessions. The automatic OpenClaw
  // before-prompt path disables this hint; task-specific guardrails can
  // still be added without pretending an empty memory store has matches.
  const hint = [
    "No prior memories matched this query — the store may simply be cold.",
    "Call `memos_search` only if you have a specific reason to expect",
    "relevant past context; otherwise continue with the current task.",
  ].join(" ");
  return `${CONTEXT_OPEN}\n${hint}\n${CONTEXT_CLOSE}`;
}

async function withSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: true, value: await promise };
  }
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    new Promise<{ ok: false; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function capContextBlock(block: string): { block: string; truncated: boolean } {
  if (block.length <= OPENCLAW_CONTEXT_CHAR_CAP) {
    return { block, truncated: false };
  }
  const suffix = `\n\n[Memory context truncated to ${OPENCLAW_CONTEXT_CHAR_CAP} characters.]\n${CONTEXT_CLOSE}`;
  const prefix = block.startsWith(`${CONTEXT_OPEN}\n`) ? `${CONTEXT_OPEN}\n` : "";
  const bodyStart = prefix.length;
  const bodyBudget = Math.max(0, OPENCLAW_CONTEXT_CHAR_CAP - prefix.length - suffix.length);
  const body = block.slice(bodyStart, bodyStart + bodyBudget).trimEnd();
  return {
    block: `${prefix}${body}${suffix}`,
    truncated: true,
  };
}

// ─── Bridge factory ────────────────────────────────────────────────────────

export interface BridgeOptions {
  agent: AgentKind;
  core: MemoryCore;
  log: HostLogger;
  /** When true, keep retrieval enabled but skip turn-end capture entirely. */
  memoryAddDisabled?: boolean;
  /** Override the wall-clock source (tests). */
  now?: () => number;
}

export interface BridgeHandle {
  /** Handler for OpenClaw `before_prompt_build` hook. */
  handleBeforePrompt: (
    event: BeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<BeforePromptBuildResult | void>;

  /** Handler for OpenClaw `agent_end` hook. */
  handleAgentEnd: (event: AgentEndEvent, ctx: PluginHookAgentContext) => Promise<void>;

  /** Handler for `before_tool_call` — start duration tracking. */
  handleBeforeToolCall: (
    event: BeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => void;

  /** Handler for `after_tool_call` — record outcome. */
  handleAfterToolCall: (
    event: AfterToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<void>;

  /** Handler for `tool_result_persist` — append repeated-failure hint. */
  handleToolResultPersist: (
    event: ToolResultPersistEvent,
    ctx: PluginHookToolContext,
  ) => { message?: unknown } | void;

  /** Handler for `session_start`. */
  handleSessionStart: (
    event: SessionStartEvent,
    ctx: PluginHookSessionContext,
  ) => Promise<void>;

  /** Handler for `session_end`. */
  handleSessionEnd: (
    event: SessionEndEvent,
    ctx: PluginHookSessionContext,
  ) => Promise<void>;

  /** Handler for `subagent_spawned` — cache delegation metadata. */
  handleSubagentSpawned: (
    event: SubagentSpawnedEvent,
    ctx: PluginHookSubagentContext,
  ) => void;

  /** Handler for `subagent_ended` — clear cached delegation metadata. */
  handleSubagentEnded: (
    event: SubagentEndedEvent,
    ctx: PluginHookSubagentContext,
  ) => Promise<void>;

  /** Snapshot for tests. */
  trackedSessions: () => number;
  trackedToolCalls: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truthyEnv(name: string): boolean {
  const value = process.env[name];
  return value != null && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function toolFailureStreakKey(
  toolName: string,
  event: ToolResultPersistEvent,
  ctx: PluginHookToolContext,
): string {
  const run = ctx.runId ?? event.runId ?? ctx.sessionId ?? ctx.sessionKey ?? "global";
  return `${run}:${toolName}`;
}

function clearToolFailureStreaksForTurn(
  streaks: Map<string, number>,
  ctx: { runId?: string; sessionId?: string; sessionKey?: string },
): void {
  const prefix = `${ctx.runId ?? ctx.sessionId ?? ctx.sessionKey ?? "global"}:`;
  for (const key of streaks.keys()) {
    if (key.startsWith(prefix)) streaks.delete(key);
  }
}

function toolResultPersistFailed(event: ToolResultPersistEvent): boolean {
  if (event.error) return true;
  const msg = asRecord(event.message);
  if (msg) {
    if (msg.isError === true || msg.error === true) return true;
    if (typeof msg.error === "string" && msg.error.trim()) return true;
    const details = asRecord(msg.details);
    if (details?.isError === true || details?.error === true) return true;
    if (typeof details?.error === "string" && details.error.trim()) return true;
  }
  const result = asRecord(event.result);
  if (result?.isError === true || result?.error === true) return true;
  if (typeof result?.error === "string" && result.error.trim()) return true;
  return false;
}

function appendFailureHintToToolResultMessage(message: unknown): unknown {
  const msg = asRecord(message);
  if (!msg) return message;
  const content = msg.content;
  if (typeof content === "string") {
    if (content.includes(TOOL_FAILURE_REPAIR_HINT)) return message;
    return { ...msg, content: appendFailureHint(content) };
  }
  if (Array.isArray(content)) {
    let idx = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      const p = asRecord(content[i]);
      if (p?.type === "text" && typeof p.text === "string") {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const part = asRecord(content[idx])!;
      const text = String(part.text);
      if (text.includes(TOOL_FAILURE_REPAIR_HINT)) return message;
      const next = [...content];
      next[idx] = { ...part, text: appendFailureHint(text) };
      return { ...msg, content: next };
    }
    return { ...msg, content: [...content, { type: "text", text: TOOL_FAILURE_REPAIR_HINT }] };
  }
  return message;
}

function appendFailureHint(content: string): string {
  const trimmed = content.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${TOOL_FAILURE_REPAIR_HINT}`;
}

export function createOpenClawBridge(opts: BridgeOptions): BridgeHandle {
  const now = opts.now ?? (() => Date.now());

  // Per-session cursor so we don't re-capture messages across turns.
  const messageCursor = new Map<SessionId, number>();
  // Per-session last-known user text (for tool-outcome context hashing).
  const lastUserTextBySession = new Map<SessionId, string>();
  // Per-session latest episode binding (populated by the core after
  // onTurnStart). The keyed side map lets a delayed `agent_end` find and
  // clear its own turn without deleting a newer turn's mapping.
  type EpisodeBinding = {
    sessionId: SessionId;
    episodeId?: EpisodeId;
    seq: number;
    keys: string[];
    turnStart?: Promise<RetrievalResultDTO>;
    turnGeneration: number;
    runId?: string;
    userText?: string;
  };
  const latestEpisodeBySession = new Map<SessionId, EpisodeBinding>();
  const episodeBindingByTurnKey = new Map<string, EpisodeBinding>();
  const sessionTurnGeneration = new Map<SessionId, number>();
  let episodeBindingSeq = 0;
  // Per-toolCallId start timestamps so `after_tool_call` can compute duration
  // when the host doesn't populate `durationMs`.
  const toolCallStartedAt = new Map<string, {
    ts: number;
    sessionId: SessionId;
    runId?: string;
    toolName?: string;
    params?: Record<string, unknown>;
  }>();
  const toolFailureStreaks = new Map<string, number>();
  type ObservedToolCall = ToolCallDTO & { runId?: string; order: number };
  const observedToolCallsBySession = new Map<SessionId, ObservedToolCall[]>();
  let observedToolCallSeq = 0;
  const spawnedSubagents = new Map<string, {
    event: SubagentSpawnedEvent;
    ctx: PluginHookSubagentContext;
    ts: number;
    parentSessionId?: SessionId;
    parentEpisodeId?: EpisodeId;
  }>();
  const pendingSubagentSessions = new Set<SessionId>();

  function memoryWritesDisabled(): boolean {
    return opts.memoryAddDisabled ||
      truthyEnv("MEMOS_MEMORY_ADD_DISABLED") ||
      truthyEnv("EVOAGENTBENCH_MEMOS_DISABLE_ADD");
  }

  function rememberObservedToolCall(
    sessionId: SessionId,
    runId: string | undefined,
    tc: ToolCallDTO,
  ): void {
    const list = observedToolCallsBySession.get(sessionId) ?? [];
    list.push({ ...tc, runId, order: ++observedToolCallSeq });
    observedToolCallsBySession.set(sessionId, list.slice(-200));
  }

  function takeObservedToolCalls(
    sessionId: SessionId,
    runId: string | undefined,
  ): ToolCallDTO[] {
    const list = observedToolCallsBySession.get(sessionId) ?? [];
    if (list.length === 0) return [];

    const matched: ObservedToolCall[] = [];
    const rest: ObservedToolCall[] = [];
    for (const tc of list) {
      const sameRun = runId ? tc.runId === runId || !tc.runId : true;
      if (sameRun) matched.push(tc);
      else rest.push(tc);
    }

    if (rest.length > 0) observedToolCallsBySession.set(sessionId, rest);
    else observedToolCallsBySession.delete(sessionId);

    return matched
      .slice()
      .sort((a, b) => (a.startedAt ?? a.order) - (b.startedAt ?? b.order))
      .map(({ runId: _runId, order: _order, ...tc }) => tc);
  }

  async function ensureSession(
    agentId: string | undefined,
    sessionKey: string | undefined,
    namespace?: RuntimeNamespace,
  ): Promise<SessionId> {
    const effectiveAgent = agentId ?? "main";
    const effectiveKey = sessionKey ?? "default";
    const sid = bridgeSessionId(effectiveAgent, effectiveKey);
    await opts.core.openSession({
      agent: opts.agent,
      sessionId: sid,
      namespace,
      meta: namespace ? { namespace } : undefined,
    });
    return sid;
  }

  function turnBindingKeys(
    sessionId: SessionId,
    ctx: { runId?: string },
    userText?: string,
  ): string[] {
    const keys: string[] = [];
    if (ctx.runId) keys.push(`${sessionId}\0run\0${ctx.runId}`);
    const text = userText?.trim();
    if (text) keys.push(`${sessionId}\0user\0${text}`);
    return keys;
  }

  function bindingStillLive(binding: EpisodeBinding): boolean {
    for (const key of binding.keys) {
      if (episodeBindingByTurnKey.get(key)?.seq === binding.seq) return true;
    }
    return false;
  }

  function commitEpisodeId(
    binding: EpisodeBinding,
    pkt: RetrievalResultDTO,
  ): void {
    if (!bindingStillLive(binding)) return;
    const candidate = pkt.query?.episodeId as EpisodeId | undefined;
    if (!candidate) return;
    const routedSessionId = (pkt.query?.sessionId ?? binding.sessionId) as SessionId;
    if (opts.core.episodeExists(candidate)) {
      binding.episodeId = candidate;
    } else {
      const fallback = opts.core.resolveOpenEpisodeId(routedSessionId);
      if (fallback) binding.episodeId = fallback;
    }
    if (routedSessionId !== binding.sessionId) {
      for (const key of turnBindingKeys(
        routedSessionId,
        { runId: binding.runId },
        binding.userText,
      )) {
        episodeBindingByTurnKey.set(key, binding);
      }
    }
  }

  function rememberEpisodeBinding(input: {
    sessionId: SessionId;
    ctx: { runId?: string };
    userText: string | undefined;
    turnStart?: Promise<RetrievalResultDTO>;
    episodeId?: EpisodeId;
    turnGeneration: number;
    seq?: number;
  }): EpisodeBinding {
    if (!input.turnStart && input.episodeId === undefined) {
      throw new Error(
        "rememberEpisodeBinding: turnStart required when episodeId is pending",
      );
    }
    if (input.ctx.runId === undefined && input.userText?.trim()) {
      opts.log.warn("memos.binding.missing_run_id", {
        sessionId: input.sessionId,
      });
    }
    const seq = input.seq ?? ++episodeBindingSeq;
    const binding: EpisodeBinding = {
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      seq,
      keys: turnBindingKeys(input.sessionId, input.ctx, input.userText),
      turnStart: input.turnStart,
      turnGeneration: input.turnGeneration,
      runId: input.ctx.runId,
      userText: input.userText,
    };
    latestEpisodeBySession.set(input.sessionId, binding);
    for (const key of binding.keys) {
      episodeBindingByTurnKey.set(key, binding);
    }
    return binding;
  }

  function findEpisodeBinding(
    sessionId: SessionId,
    ctx: { runId?: string },
    userText: string | undefined,
    mode: "strict_run" | "legacy" = "legacy",
  ): EpisodeBinding | undefined {
    for (const key of turnBindingKeys(sessionId, ctx, userText)) {
      const binding = episodeBindingByTurnKey.get(key);
      if (binding) return binding;
    }
    if (mode === "strict_run") return undefined;
    return latestEpisodeBySession.get(sessionId);
  }

  function forgetEpisodeBinding(binding: EpisodeBinding | undefined): void {
    if (!binding) return;
    binding.turnStart = undefined;
    for (const key of binding.keys) {
      if (episodeBindingByTurnKey.get(key)?.seq === binding.seq) {
        episodeBindingByTurnKey.delete(key);
      }
    }
    if (latestEpisodeBySession.get(binding.sessionId)?.seq === binding.seq) {
      latestEpisodeBySession.delete(binding.sessionId);
    }
  }

  async function resolveEpisodeIdForTurnEnd(
    sessionId: SessionId,
    ctx: { runId?: string },
    userText: string,
  ): Promise<{ episodeId: EpisodeId; binding: EpisodeBinding | undefined } | null> {
    if (!ctx.runId) {
      opts.log.warn("memos.agent_end.missing_run_id", { sessionId });
    }
    const binding = findEpisodeBinding(sessionId, ctx, userText, "strict_run");

    if (binding?.episodeId && bindingStillLive(binding)) {
      if (opts.core.episodeExists(binding.episodeId)) {
        return { episodeId: binding.episodeId, binding };
      }
    }

    if (binding?.turnStart) {
      const awaited = await withSoftTimeout(binding.turnStart, AGENT_END_BINDING_CAP_MS);
      if (awaited.ok) {
        commitEpisodeId(binding, awaited.value);
        const id = binding.episodeId;
        if (id && opts.core.episodeExists(id)) {
          return { episodeId: id, binding };
        }
      } else {
        opts.log.warn("memos.agent_end.turn_start_await_timeout", {
          sessionId,
          timeoutMs: AGENT_END_BINDING_CAP_MS,
        });
      }
    }

    const opened = await opts.core.openEpisode({
      sessionId,
      userMessage: userText,
    });
    const canonical = opts.core.reconcileEpisodeId(sessionId, opened);
    if (canonical && opts.core.isEpisodeWritable(canonical)) {
      return { episodeId: canonical, binding };
    }
    return null;
  }

  function forgetSessionBindings(sessionId: SessionId): void {
    latestEpisodeBySession.delete(sessionId);
    for (const [key, binding] of episodeBindingByTurnKey.entries()) {
      if (binding.sessionId === sessionId) episodeBindingByTurnKey.delete(key);
    }
  }

  function currentEpisodeId(sessionId: SessionId): EpisodeId | undefined {
    const id = latestEpisodeBySession.get(sessionId)?.episodeId;
    if (!id) return undefined;
    return opts.core.isEpisodeWritable(id) ? id : undefined;
  }

  async function handleBeforePrompt(
    event: BeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<BeforePromptBuildResult | void> {
    const startedAt = now();
    try {
      // Ephemeral sub-agents (slug generator, internal probes) share
      // the plugin host and would otherwise open a throwaway episode
      // that never gets finalized — surfacing as a phantom
      // "未命名任务" in the Tasks viewer. Bounce them out before any
      // state is allocated.
      if (isEphemeralSessionKey(ctx.sessionKey)) {
        opts.log.debug("memos.onTurnStart.skipped_ephemeral", {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        return;
      }
      // Strip OpenClaw's envelope before the text leaks anywhere
      // downstream (retrieval query, stored episode.initialTurn, capture
      // userText). Without this, every captured memory would carry the
      // "[Thu … GMT+8]" prefix and the "Sender (untrusted metadata)"
      // block — exactly the bug the user hit.
      const rawPrompt = (event.prompt ?? "").trim();
      // V7 parity with legacy adapter: don't create episodes for
      // OpenClaw boot checks / bootstrap preludes / sentinel replies.
      // They're not user input, and retrieving against them wastes a
      // tier-2 query and pollutes the viewer.
      if (isOpenClawBootstrapMessage(rawPrompt)) {
        opts.log.debug("memos.onTurnStart.skipped_bootstrap", {
          sessionKey: ctx.sessionKey,
          head: rawPrompt.slice(0, 60),
        });
        return;
      }
      if (isOpenClawSubagentAnnouncementPrompt(rawPrompt)) {
        opts.log.debug("memos.onTurnStart.skipped_subagent_announcement", {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        return;
      }
      const prompt = stripOpenClawUserEnvelope(rawPrompt);
      if (!prompt) return;

      const namespace = namespaceFromAgentCtx(ctx);
      const readOnlyTurnStart = memoryWritesDisabled();
      const sessionId = readOnlyTurnStart
        ? bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default")
        : await ensureSession(ctx.agentId, ctx.sessionKey, namespace);
      clearToolFailureStreaksForTurn(toolFailureStreaks, {
        runId: ctx.runId,
        sessionId: ctx.sessionId ?? sessionId,
        sessionKey: ctx.sessionKey,
      });
      lastUserTextBySession.set(sessionId, prompt);

      const turn: TurnInputDTO = {
        agent: opts.agent,
        namespace,
        sessionId,
        userText: prompt,
        ts: now(),
        contextHints: {
          agentId: ctx.agentId,
          namespace,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          workspaceDir: ctx.workspaceDir,
          __memosReadOnlyTurnStart: readOnlyTurnStart,
        },
      };

      const turnGeneration = (sessionTurnGeneration.get(sessionId) ?? 0) + 1;
      sessionTurnGeneration.set(sessionId, turnGeneration);

      const turnStartPromise = opts.core.onTurnStart(turn);
      const binding = rememberEpisodeBinding({
        sessionId,
        ctx,
        userText: prompt,
        turnStart: turnStartPromise,
        turnGeneration,
      });

      turnStartPromise
        .then((packet) => {
          commitEpisodeId(binding, packet);
        })
        .catch((err) => {
          opts.log.warn("memos.onTurnStart.late_failure", {
            err: err instanceof Error ? err.message : String(err),
          });
        });

      const turnStartResult = await withSoftTimeout(
        turnStartPromise,
        BEFORE_PROMPT_SOFT_TIMEOUT_MS,
      );
      const packet = turnStartResult.ok ? turnStartResult.value : null;
      if (!turnStartResult.ok) {
        opts.log.warn("memos.onTurnStart.soft_timeout", {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          timeoutMs: BEFORE_PROMPT_SOFT_TIMEOUT_MS,
        });
      } else if (packet) {
        commitEpisodeId(binding, packet);
      }

      const routedSessionId = (packet?.query.sessionId ?? sessionId) as SessionId;
      const routedEpisodeId =
        binding.episodeId ??
        (packet?.query.episodeId as EpisodeId | undefined);

      const renderedBlock = renderContextBlock(packet, {
        // Avoid making OpenClaw do a second tool-driven search when
        // auto-recall found nothing. A no-hit turn should simply
        // continue with the user's prompt; tools remain available if
        // the model independently decides to use them.
        hintWhenEmpty: false,
      });
      const { block, truncated } = capContextBlock(renderedBlock);
      const durationMs = now() - startedAt;

      opts.log.info("memos.onTurnStart", {
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: routedSessionId,
        episodeId: routedEpisodeId,
        hits: packet?.hits.length ?? 0,
        tierLatencyMs: packet?.tierLatencyMs ?? { tier1: 0, tier2: 0, tier3: 0 },
        durationMs,
        contextChars: block.length,
        injected: block.length > 0,
        truncated,
        softTimedOut: !turnStartResult.ok,
      });
      opts.log.info(
        `memos.onTurnStart returned hits=${packet?.hits.length ?? 0} ` +
          `durationMs=${durationMs} contextChars=${block.length} ` +
          `injected=${block.length > 0 ? "yes" : "no"} ` +
          `truncated=${truncated ? "yes" : "no"} ` +
          `softTimedOut=${turnStartResult.ok ? "no" : "yes"}`,
      );

      if (!block) return;
      return { prependContext: block + "\n\n" };
    } catch (err) {
      opts.log.warn("memos.onTurnStart.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  async function handleAgentEnd(
    event: AgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) {
      // Mirror `handleBeforePrompt` — slug-generator & co. don't get a
      // trace / episode, so there's nothing to persist here either.
      return;
    }
    if (memoryWritesDisabled()) {
      opts.log.info("memos.agent_end.skipped", {
        reason: "memory_add_disabled",
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
      return;
    }
    const namespace = namespaceFromAgentCtx(ctx);
    const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
    const allMessages = Array.isArray(event.messages) ? event.messages : [];

    // Always acknowledge the hook at INFO level so the user can
    // confirm agent_end fired at all (without this, bugs like "my
    // memories never got written" are impossible to triage from the
    // gateway log alone).
    opts.log.info("memos.agent_end.received", {
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      success: event.success,
      messageCount: allMessages.length,
      hasError: !!event.error,
    });


    try {
      // Legacy adapter parity: even when `success === false` we still
      // enqueue the user's message (and whatever the assistant managed
      // to produce) so the capture / reward chain has a complete
      // record for decision-repair. The legacy plugin never dropped
      // failed turns and neither should we.
      if (allMessages.length === 0) {
        opts.log.info("memos.agent_end.skipped", { reason: "no_messages" });
        return;
      }

      // Process only messages appended since the last call — OpenClaw
      // ships the full transcript with every `agent_end`, not the delta.
      // We subtract one from the cursor so the overlap rule catches a
      // multi-part assistant reply spanning the boundary.
      const cursor = messageCursor.get(sessionId) ?? 0;
      const novel =
        cursor >= allMessages.length
          ? allMessages.slice()
          : allMessages.slice(Math.max(0, cursor - 1));
      messageCursor.set(sessionId, allMessages.length);

      const flat = flattenMessages(novel);
      const turn = extractTurn(flat, now());
      if (!turn || !turn.userText) {
        // Elevated to WARN so unexpected skips show up in the gateway
        // log. `flat.length` / `novel.length` help diagnose whether the
        // envelope stripper or the role detector is at fault.
        opts.log.warn("memos.agent_end.skipped", {
          reason: "no_user_turn",
          novel: novel.length,
          flat: flat.length,
          firstRole: flat[0]?.role,
          hasUserText: !!turn?.userText,
        });
        return;
      }

      // V7 parity with legacy adapter: suppress system-level bootstrap
      // turns and boot checks. `extractTurn` strips the envelope but
      // doesn't know these are sentinel system messages dressed up as
      // user turns. Without this guard, every `/new` /// `/reset`
      // creates a bogus episode with a multi-paragraph "Bootstrap
      // files like SOUL.md…" body — exactly what the user saw in the
      // Memories panel.
      if (isOpenClawBootstrapMessage(turn.userText)) {
        opts.log.info("memos.agent_end.skipped", {
          reason: "bootstrap_turn",
          head: turn.userText.slice(0, 60),
        });
        return;
      }
      const toolCalls = mergeToolCalls(
        turn.toolCalls,
        takeObservedToolCalls(sessionId, ctx.runId),
      );
      const isSubagentAnnouncement = isOpenClawSubagentAnnouncementPrompt(turn.userText);
      const hasSubagentSpawn = toolCalls.some((tc) => tc.name === "sessions_spawn");

      if (isSubagentAnnouncement) {
        const probe = findEpisodeBinding(
          sessionId,
          ctx,
          turn.userText,
          "strict_run",
        );
        if (!probe?.episodeId && !probe?.turnStart) {
          opts.log.info("memos.agent_end.skipped", {
            reason: "subagent_announcement_without_parent_episode",
            sessionKey: ctx.sessionKey,
          });
          return;
        }
      }

      await opts.core.openSession({
        agent: opts.agent,
        sessionId,
        namespace,
        meta: { namespace },
      });

      const resolved = await resolveEpisodeIdForTurnEnd(
        sessionId,
        ctx,
        turn.userText,
      );
      if (!resolved) {
        opts.log.warn("memos.agent_end.skipped", {
          reason: "no_writable_episode",
          sessionKey: ctx.sessionKey,
        });
        return;
      }
      const { episodeId } = resolved;
      let binding = resolved.binding;
      if (!binding) {
        binding = rememberEpisodeBinding({
          sessionId,
          ctx,
          userText: turn.userText,
          episodeId,
          turnGeneration: sessionTurnGeneration.get(sessionId) ?? 0,
        });
      }

      const turnResult: TurnResultDTO = {
        agent: opts.agent,
        namespace,
        sessionId,
        episodeId,
        agentText: turn.agentText,
        agentThinking: turn.agentThinking,
        toolCalls,
        reflection: turn.reflection,
        contextHints: { namespace },
        ts: now(),
      };

      const res = await opts.core.onTurnEnd(turnResult);
      opts.log.info("memos.onTurnEnd", {
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId,
        traceId: res.traceId,
        episodeId: res.episodeId,
        tools: toolCalls.length,
        success: event.success,
        durationMs: event.durationMs,
      });

      // Close the episode mapping so the next turn opens a fresh one
      // (V7 §0.1 routes multi-turn continuation through the relation
      // classifier, not through stickiness in this cache).
      if (hasSubagentSpawn) {
        pendingSubagentSessions.add(sessionId);
      } else {
        pendingSubagentSessions.delete(sessionId);
        forgetEpisodeBinding(binding);
      }

      if (isExplicitOneShotSessionKey(ctx.sessionKey) && !hasSubagentSpawn) {
        await opts.core.closeSession(sessionId);
        messageCursor.delete(sessionId);
        forgetSessionBindings(sessionId);
        observedToolCallsBySession.delete(sessionId);
        lastUserTextBySession.delete(sessionId);
      }
    } catch (err) {
      opts.log.warn("memos.onTurnEnd.failed", {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  function handleBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): void {
    const toolCallId = ctx.toolCallId ?? event.toolCallId;
    if (!toolCallId) return;
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
    toolCallStartedAt.set(toolCallId, {
      ts: now(),
      sessionId,
      runId: ctx.runId ?? event.runId,
      toolName: ctx.toolName ?? event.toolName,
      params: event.params,
    });
  }

  async function handleAfterToolCall(
    event: AfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    if (memoryWritesDisabled()) return;
    try {
      const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
      const toolCallId = ctx.toolCallId ?? event.toolCallId;
      const started = toolCallId ? toolCallStartedAt.get(toolCallId) : undefined;
      if (toolCallId) toolCallStartedAt.delete(toolCallId);

      const endedAt = now();
      const durationMs =
        typeof event.durationMs === "number"
          ? event.durationMs
          : started
          ? Math.max(0, endedAt - started.ts)
          : 0;
      const toolName = event.toolName || started?.toolName || ctx.toolName || "unknown";
      const startedAt = started?.ts;
      rememberObservedToolCall(sessionId, ctx.runId ?? event.runId ?? started?.runId, {
        name: toolName,
        input: event.params ?? started?.params,
        output: event.result,
        errorCode: event.error,
        toolCallId,
        startedAt,
        endedAt,
      });

      opts.core.recordToolOutcome({
        sessionId,
        episodeId: currentEpisodeId(sessionId),
        tool: toolName,
        success: !event.error,
        errorCode: event.error,
        durationMs,
        ts: endedAt,
      });
    } catch (err) {
      opts.log.debug("memos.tool.outcome.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleToolResultPersist(
    event: ToolResultPersistEvent,
    ctx: PluginHookToolContext,
  ): { message?: unknown } | void {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    const toolName = event.toolName || ctx.toolName || "unknown";
    const key = toolFailureStreakKey(toolName, event, ctx);
    if (!toolResultPersistFailed(event)) {
      toolFailureStreaks.delete(key);
      return;
    }

    const nextCount = (toolFailureStreaks.get(key) ?? 0) + 1;
    toolFailureStreaks.set(key, nextCount);
    if (nextCount < TOOL_FAILURE_HINT_THRESHOLD) return;

    const message = appendFailureHintToToolResultMessage(event.message);
    if (message === event.message) return;
    return { message };
  }

  async function handleSessionStart(
    event: SessionStartEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    if (memoryWritesDisabled()) return;
    try {
      await ensureSession(ctx.agentId, ctx.sessionKey, namespaceFromAgentCtx(ctx));
      opts.log.debug("memos.session.started", {
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
        resumedFrom: event.resumedFrom,
      });
    } catch (err) {
      opts.log.warn("memos.session.start.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSessionEnd(
    event: SessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    if (memoryWritesDisabled()) return;
    try {
      const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
      if (pendingSubagentSessions.has(sessionId)) {
        opts.log.debug("memos.session.end.deferred_for_subagent", {
          sessionId,
          sessionKey: ctx.sessionKey,
          reason: event.reason,
        });
        return;
      }
      await opts.core.closeSession(sessionId);
      messageCursor.delete(sessionId);
      forgetSessionBindings(sessionId);
      observedToolCallsBySession.delete(sessionId);
      lastUserTextBySession.delete(sessionId);
      opts.log.debug("memos.session.ended", {
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
        reason: event.reason,
        messageCount: event.messageCount,
      });
    } catch (err) {
      opts.log.warn("memos.session.end.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleSubagentSpawned(
    event: SubagentSpawnedEvent,
    ctx: PluginHookSubagentContext,
  ): void {
    const key = event.runId || event.childSessionKey || ctx.childSessionKey;
    if (!key) return;
    const parentAgentId = (ctx as { agentId?: string }).agentId ?? event.agentId ?? "main";
    const parentSessionKey = ctx.requesterSessionKey ?? (ctx as { sessionKey?: string }).sessionKey;
    const parentSessionId = parentSessionKey
      ? bridgeSessionId(parentAgentId, parentSessionKey)
      : undefined;
    spawnedSubagents.set(key, {
      event,
      ctx,
      ts: now(),
      parentSessionId,
      parentEpisodeId: parentSessionId ? currentEpisodeId(parentSessionId) : undefined,
    });
    if (parentSessionId) pendingSubagentSessions.add(parentSessionId);
    opts.log.debug("memos.subagent.spawned", {
      runId: event.runId,
      childSessionKey: event.childSessionKey,
      requesterSessionKey: ctx.requesterSessionKey,
      label: event.label,
      mode: event.mode,
    });
  }

  async function handleSubagentEnded(
    event: SubagentEndedEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<void> {
    try {
      const cached =
        (event.runId ? spawnedSubagents.get(event.runId) : undefined) ??
        spawnedSubagents.get(event.targetSessionKey);
      if (event.runId) spawnedSubagents.delete(event.runId);
      spawnedSubagents.delete(event.targetSessionKey);
      opts.log.info("memos.subagent.ended", {
        sessionId: cached?.parentSessionId,
        episodeId: cached?.parentEpisodeId,
        childSessionKey: event.targetSessionKey,
        outcome: event.outcome,
        reason: event.reason,
      });
    } catch (err) {
      opts.log.warn("memos.subagent.end.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    handleBeforePrompt,
    handleAgentEnd,
    handleBeforeToolCall,
    handleAfterToolCall,
    handleToolResultPersist,
    handleSessionStart,
    handleSessionEnd,
    handleSubagentSpawned,
    handleSubagentEnded,
    trackedSessions: () => messageCursor.size,
    trackedToolCalls: () => toolCallStartedAt.size,
  };
}
