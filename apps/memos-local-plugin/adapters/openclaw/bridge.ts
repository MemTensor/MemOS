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
        } else if (type === "toolCall") {
          inlineToolCalls.push({
            role: "tool_call",
            content: "",
            toolName: typeof b.name === "string" ? b.name : "unknown",
            toolCallId: typeof b.id === "string" ? b.id : undefined,
            toolInput: b.arguments,
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
    /## Memory system\n+No memories were automatically recalled[^\n]*(?:\n[^\n]*memory_search[^\n]*)*/gi,
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

  const pendingCalls = new Map<string, Partial<ToolCallDTO> & { _id?: string }>();
  const toolCalls: ToolCallDTO[] = [];

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
      pendingCalls.set(key, {
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
      const stub = pendingCalls.get(key);
      const errorCode = stub
        ? m.errorCode ?? (m.isError ? "tool_error" : undefined)
        : m.errorCode ?? (m.isError ? "tool_error" : undefined);
      toolCalls.push({
        name: stub?.name ?? m.toolName ?? "unknown",
        input: stub?.input,
        output: m.content || undefined,
        errorCode,
        startedAt: stub?.startedAt ?? (m.ts ?? now),
        endedAt: m.ts ?? now,
        thinkingBefore: stub?.thinkingBefore,
      });
      if (key) pendingCalls.delete(key);
      continue;
    }
  }

  for (const stub of pendingCalls.values()) {
    if (!stub.name) continue;
    toolCalls.push({
      name: stub.name,
      input: stub.input,
      output: undefined,
      startedAt: stub.startedAt ?? now,
      endedAt: now,
      thinkingBefore: stub.thinkingBefore,
    });
  }

  const agentThinking = pendingThinking.join("\n\n").trim();
  return {
    userText,
    agentText: pendingAssistant.join("\n\n").trim(),
    agentThinking: agentThinking || undefined,
    toolCalls,
  };
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

/**
 * Render the retrieval result as a prompt-prependable block.
 *
 * When the store is cold (no hits), we still emit a short "memory
 * tools are available" hint — the legacy `memos-local-openclaw`
 * adapter does the same via `noRecallHint`, and without it the LLM
 * has no reason to call `memory_search` at the start of a
 * conversation. The hint is kept *small* so repeated turns don't
 * bloat the system prompt.
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
  // Cold-start hint — mirrors the legacy adapter's behaviour so the
  // model is nudged to reach for `memory_search` even on the first
  // turn of a fresh session.
  const hint = [
    "No prior memories matched this query — the store may simply be cold.",
    "You can still call `memory_search` (semantic) or `memory_timeline`",
    "(by episodeId) if you expect there to be relevant past context.",
  ].join(" ");
  return `${CONTEXT_OPEN}\n${hint}\n${CONTEXT_CLOSE}`;
}

// ─── Bridge factory ────────────────────────────────────────────────────────

export interface BridgeOptions {
  agent: AgentKind;
  core: MemoryCore;
  log: HostLogger;
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

export function createOpenClawBridge(opts: BridgeOptions): BridgeHandle {
  const now = opts.now ?? (() => Date.now());

  // Per-session cursor so we don't re-capture messages across turns.
  const messageCursor = new Map<SessionId, number>();
  // Per-session last-known user text (for tool-outcome context hashing).
  const lastUserTextBySession = new Map<SessionId, string>();
  // Per-session open episode id (populated by the core after onTurnStart).
  const openEpisodeBySession = new Map<SessionId, EpisodeId>();
  // Per-toolCallId start timestamps so `after_tool_call` can compute duration
  // when the host doesn't populate `durationMs`.
  const toolCallStartedAt = new Map<string, { ts: number; sessionId: SessionId }>();
  const spawnedSubagents = new Map<string, {
    event: SubagentSpawnedEvent;
    ctx: PluginHookSubagentContext;
    ts: number;
    parentSessionId?: SessionId;
    parentEpisodeId?: EpisodeId;
  }>();
  const pendingSubagentSessions = new Set<SessionId>();

  async function ensureSession(
    agentId: string | undefined,
    sessionKey: string | undefined,
  ): Promise<SessionId> {
    const effectiveAgent = agentId ?? "main";
    const effectiveKey = sessionKey ?? "default";
    const sid = bridgeSessionId(effectiveAgent, effectiveKey);
    await opts.core.openSession({ agent: opts.agent, sessionId: sid });
    return sid;
  }

  async function handleBeforePrompt(
    event: BeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<BeforePromptBuildResult | void> {
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

      const sessionId = await ensureSession(ctx.agentId, ctx.sessionKey);
      lastUserTextBySession.set(sessionId, prompt);

      const turn: TurnInputDTO = {
        agent: opts.agent,
        sessionId,
        userText: prompt,
        ts: now(),
        contextHints: {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          workspaceDir: ctx.workspaceDir,
        },
      };

      const packet = await opts.core.onTurnStart(turn);
      // The pipeline orchestrator (V7 §0.1) may have migrated the
      // session id (new-task → new session) or reopened a closed
      // episode (revision). We trust the ids returned in the packet,
      // not our own derivation, so `onTurnEnd` lands on the same row.
      const routedSessionId = (packet.query.sessionId ?? sessionId) as SessionId;
      const routedEpisodeId = packet.query.episodeId as EpisodeId | undefined;
      if (routedEpisodeId) {
        openEpisodeBySession.set(routedSessionId, routedEpisodeId);
        openEpisodeBySession.set(sessionId, routedEpisodeId);
      }

      opts.log.info("memos.onTurnStart", {
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: routedSessionId,
        episodeId: routedEpisodeId,
        hits: packet.hits.length,
        tierLatencyMs: packet.tierLatencyMs,
      });

      const block = renderContextBlock(packet, { hintWhenEmpty: true });
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
      const isSubagentAnnouncement = isOpenClawSubagentAnnouncementPrompt(turn.userText);
      const hasSubagentSpawn = turn.toolCalls.some((tc) => tc.name === "sessions_spawn");

      // Resolve (or lazily open) the target episode. Three cases:
      //   1. `before_prompt_build` already ran this turn → we have the
      //      routed episodeId in `openEpisodeBySession`.
      //   2. The host skipped `before_prompt_build` (e.g. /new with no
      //      prompt build) → create an episode on the fly so the write
      //      path has a real row to hang traces on.
      //   3. Any failure here falls back to opening a new episode —
      //      better to capture under a fresh id than to drop the turn.
      let episodeId = openEpisodeBySession.get(sessionId);
      if (!episodeId) {
        if (isSubagentAnnouncement) {
          opts.log.info("memos.agent_end.skipped", {
            reason: "subagent_announcement_without_parent_episode",
            sessionKey: ctx.sessionKey,
          });
          return;
        }
        await opts.core.openSession({ agent: opts.agent, sessionId });
        episodeId = await opts.core.openEpisode({
          sessionId,
          userMessage: turn.userText,
        });
        openEpisodeBySession.set(sessionId, episodeId);
      }

      const turnResult: TurnResultDTO = {
        agent: opts.agent,
        sessionId,
        episodeId,
        agentText: turn.agentText,
        agentThinking: turn.agentThinking,
        toolCalls: turn.toolCalls,
        reflection: turn.reflection,
        ts: now(),
      };

      const res = await opts.core.onTurnEnd(turnResult);
      opts.log.info("memos.onTurnEnd", {
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId,
        traceId: res.traceId,
        episodeId: res.episodeId,
        tools: turn.toolCalls.length,
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
        openEpisodeBySession.delete(sessionId);
      }

      if (isExplicitOneShotSessionKey(ctx.sessionKey) && !hasSubagentSpawn) {
        await opts.core.closeSession(sessionId);
        messageCursor.delete(sessionId);
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
    _event: BeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): void {
    if (!ctx.toolCallId) return;
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
    toolCallStartedAt.set(ctx.toolCallId, { ts: now(), sessionId });
  }

  async function handleAfterToolCall(
    event: AfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    try {
      const sessionId = bridgeSessionId(ctx.agentId ?? "main", ctx.sessionKey ?? "default");
      const started = ctx.toolCallId ? toolCallStartedAt.get(ctx.toolCallId) : undefined;
      if (ctx.toolCallId) toolCallStartedAt.delete(ctx.toolCallId);

      const endedAt = now();
      const durationMs =
        typeof event.durationMs === "number"
          ? event.durationMs
          : started
          ? Math.max(0, endedAt - started.ts)
          : 0;

      opts.core.recordToolOutcome({
        sessionId,
        episodeId: openEpisodeBySession.get(sessionId),
        tool: event.toolName,
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

  async function handleSessionStart(
    event: SessionStartEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    if (isEphemeralSessionKey(ctx.sessionKey)) return;
    try {
      await ensureSession(ctx.agentId, ctx.sessionKey);
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
      openEpisodeBySession.delete(sessionId);
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
      parentEpisodeId: parentSessionId ? openEpisodeBySession.get(parentSessionId) : undefined,
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
    handleSessionStart,
    handleSessionEnd,
    handleSubagentSpawned,
    handleSubagentEnded,
    trackedSessions: () => messageCursor.size,
    trackedToolCalls: () => toolCallStartedAt.size,
  };
}
