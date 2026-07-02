import type { ConversationMessage, Role, Logger } from "../types";

const SKIP_ROLES: Set<Role> = new Set(["system"]);

const SYSTEM_BOILERPLATE_RE = /^A new session was started via \/new or \/reset\b/;

// Boot-check / memory-system injection patterns that should never be stored.
const BOOT_CHECK_RE = /^(?:You are running a boot check|Read HEARTBEAT\.md if it exists|## Memory system — ACTION REQUIRED)/;

/**
 * Returns true for sentinel reply values that carry no user-facing content.
 */
function isSentinelReply(text: string): boolean {
  const t = text.trim();
  return t === "NO_REPLY" || t === "HEARTBEAT_OK" || t === "HEARTBEAT_CHECK";
}

const SELF_TOOLS = new Set([
  "memory_search",
  "memory_timeline",
  "memory_get",
  "memory_viewer",
  "memory_write_public",
  "skill_search",
  "skill_publish",
  "skill_unpublish",
]);

// OpenClaw inbound metadata sentinels — these are AI-facing prefixes,
// not user content. Must be stripped before storing as memory.
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
];

const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

const ENVELOPE_PREFIX_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[A-Z]{3}[+-]\d{1,2}\]\s*/;

const ENVELOPE_EXTRACT_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+([A-Z]{3}[+-]\d{1,2})\]/;

/**
 * Extract writable messages from a conversation turn.
 *
 * Stores the user's actual text — strips only OpenClaw's injected metadata
 * prefixes (Sender info, conversation context, etc.) which are not user content.
 * Only skips: system prompts and our own memory tool results (prevents loop).
 */
export function captureMessages(
  messages: Array<{ role: string; content: string; toolName?: string }>,
  sessionKey: string,
  turnId: string,
  evidenceTag: string,
  log: Logger,
  owner?: string,
  userSearchTime?: number,
): ConversationMessage[] {
  const now = Date.now();
  const result: ConversationMessage[] = [];
  let lastTimestamp = 0;

  for (const msg of messages) {
    const role = msg.role as Role;
    if (SKIP_ROLES.has(role)) continue;
    if (!msg.content || msg.content.trim().length === 0) continue;

    // Skip sentinel replies and boot-check prompts for ALL roles.
    if (isSentinelReply(msg.content)) {
      log.debug(`Skipping sentinel reply`);
      continue;
    }
    if (BOOT_CHECK_RE.test(msg.content.trim())) {
      log.debug(`Skipping boot-check injection: ${msg.content.slice(0, 60)}...`);
      continue;
    }

    if (role === "tool" && msg.toolName && SELF_TOOLS.has(msg.toolName)) {
      log.debug(`Skipping self-tool result: ${msg.toolName}`);
      continue;
    }

    if (role === "user" && SYSTEM_BOILERPLATE_RE.test(msg.content.trim())) {
      log.debug(`Skipping system boilerplate: ${msg.content.slice(0, 60)}...`);
      continue;
    }

    let content = msg.content;
    if (role === "user") {
      content = stripInboundMetadata(content);
    } else {
      content = stripThinkingTags(content);
      content = stripEvidenceWrappers(content, evidenceTag);
    }
    if (!content.trim()) continue;

    let ts: number;
    if (role === "user" && userSearchTime && userSearchTime > 0) {
      ts = userSearchTime;
    } else {
      ts = now;
    }
    if (ts <= lastTimestamp) ts = lastTimestamp + 1;
    lastTimestamp = ts;

    result.push({
      role,
      content,
      timestamp: ts,
      turnId,
      sessionKey,
      toolName: role === "tool" ? msg.toolName : undefined,
      owner: owner ?? "agent:main",
    });
  }

  log.debug(`Captured ${result.length}/${messages.length} messages for session=${sessionKey} turn=${turnId} owner=${owner ?? "agent:main"}`);
  return result;
}

/**
 * Strip OpenClaw-injected inbound metadata blocks from user messages.
 *
 * These blocks have the shape:
 *   Sender (untrusted metadata):
 *   ```json
 *   { "label": "...", "id": "..." }
 *   ```
 *
 * Also strips the envelope timestamp prefix like "[Tue 2026-03-03 21:58 GMT+8] "
 */
export function stripInboundMetadata(text: string): string {
  let cleaned = stripMemoryInjection(text);
  cleaned = stripEnvelopePrefix(cleaned);

  // Strip OpenClaw envelope tags: [message_id: ...], [[reply_to_current]], etc.
  cleaned = cleaned.replace(/\[message_id:\s*[a-f0-9-]+\]/gi, "");
  cleaned = cleaned.replace(/\[\[reply_to_current\]\]/gi, "");

  if (!SENTINEL_FAST_RE.test(cleaned)) {
    return stripEnvelopePrefix(cleaned).trim();
  }

  const lines = cleaned.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inMetaBlock && INBOUND_META_SENTINELS.some((s) => s === trimmed)) {
      if (lines[i + 1]?.trim() === "```json") {
        inMetaBlock = true;
        inFencedJson = false;
        continue;
      }
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && trimmed === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson && trimmed === "```") {
        inMetaBlock = false;
        inFencedJson = false;
        continue;
      }
      continue;
    }

    result.push(line);
  }

  return stripEnvelopePrefix(result.join("\n")).trim();
}

/** Strip <think…>…</think> blocks emitted by DeepSeek-style reasoning models. */
const THINKING_TAG_RE = /<think[\s>][\s\S]*?<\/think>\s*/gi;

/** Unwrap <final>…</final> tags from MiniMax-style models (keep content, strip tags). */
const FINAL_TAG_RE = /<\/?final\s*>/gi;

function stripThinkingTags(text: string): string {
  return text.replace(THINKING_TAG_RE, "").replace(FINAL_TAG_RE, "").trim();
}

function extractEnvelopeTimestamp(text: string): number | null {
  const m = ENVELOPE_EXTRACT_RE.exec(text);
  if (!m) return null;
  const [, date, time, tz] = m;
  const timeStr = time.includes(":") && time.split(":").length === 3 ? time : time + ":00";
  const offsetMatch = tz.match(/([+-])(\d{1,2})$/);
  const offsetStr = offsetMatch
    ? `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:00`
    : "+00:00";
  const iso = `${date}T${timeStr}${offsetStr}`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function stripEnvelopePrefix(text: string): string {
  return text.replace(ENVELOPE_PREFIX_RE, "");
}

/**
 * Strip memory-system injections that get prepended to user messages:
 * - <memory_context>...</memory_context>
 * - === MemOS LONG-TERM MEMORY ... ===\n...MANDATORY...
 * - [MemOS Auto-Recall] Found N relevant memories:...
 * - ## Memory system\n\nNo memories were automatically recalled...
 */
function stripMemoryInjection(text: string): string {
  let cleaned = text;

  // <memory_context>...</memory_context>
  const mcStart = cleaned.indexOf("<memory_context>");
  if (mcStart !== -1) {
    const mcEnd = cleaned.indexOf("</memory_context>");
    if (mcEnd !== -1) {
      cleaned = cleaned.slice(0, mcStart) + cleaned.slice(mcEnd + "</memory_context>".length);
    } else {
      cleaned = cleaned.slice(0, mcStart);
    }
    cleaned = cleaned.trim();
  }

  // === MemOS LONG-TERM MEMORY (retrieved from past conversations) ===\n...\nMANDATORY...
  cleaned = cleaned.replace(
    /=== MemOS LONG-TERM MEMORY[\s\S]*?(?:MANDATORY[^\n]*\n?|(?=\n{2,}))/gi,
    "",
  ).trim();

  // [MemOS Auto-Recall] Found N relevant memories:\n...
  cleaned = cleaned.replace(
    /\[MemOS Auto-Recall\][^\n]*\n(?:(?:\d+\.\s+\[(?:USER|ASSISTANT)[^\n]*\n?)*)/gi,
    "",
  ).trim();

  // ## Memory system\n\nNo memories were automatically recalled...
  cleaned = cleaned.replace(
    /## Memory system\n+No memories were automatically recalled[^\n]*(?:\n[^\n]*memory_search[^\n]*)*/gi,
    "",
  ).trim();

  // ## Memory system — ACTION REQUIRED\n...
  cleaned = cleaned.replace(
    /## Memory system — ACTION REQUIRED[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}|\n\[Subagent)/,
    "",
  ).trim();

  // You are running a boot check. Follow BOOT.md instructions exactly.\n...
  cleaned = cleaned.replace(
    /^You are running a boot check[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}|\n\[Subagent)/m,
    "",
  ).trim();

  // Standalone NO_REPLY / HEARTBEAT_OK that leaked into user messages
  cleaned = cleaned.replace(/^\s*(?:NO_REPLY|HEARTBEAT_OK|HEARTBEAT_CHECK)\s*$/gm, "").trim();

  // Old format: ## Retrieved memories from past conversations\n\nCRITICAL INSTRUCTION:...
  const recallIdx = cleaned.indexOf("## Retrieved memories from past conversations");
  if (recallIdx !== -1) {
    const before = cleaned.slice(0, recallIdx);
    const after = cleaned.slice(recallIdx);
    const tsMatch = after.match(/\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}/);
    if (tsMatch && tsMatch.index != null) {
      cleaned = (before + after.slice(tsMatch.index)).trim();
    } else {
      cleaned = before.trim();
    }
  }

  // prependContext format: ## User's conversation history (from memory system)\n...
  // Ends at last "Current time:" line or last chunkId= line, whichever comes later.
  const prependIdx = cleaned.indexOf("## User's conversation history (from memory system)");
  if (prependIdx !== -1) {
    const before = cleaned.slice(0, prependIdx);
    const after = cleaned.slice(prependIdx);

    // Find the last anchor line that belongs to the injected block
    const currentTimeMatch = after.match(/Current time:[^\n]*/g);
    const chunkIdMatch = after.match(/chunkId="[^"]*"/g);
    let cutPos = 0;
    if (currentTimeMatch) {
      const lastCt = after.lastIndexOf(currentTimeMatch[currentTimeMatch.length - 1]);
      const lineEnd = after.indexOf("\n", lastCt);
      cutPos = Math.max(cutPos, lineEnd !== -1 ? lineEnd + 1 : after.length);
    }
    if (chunkIdMatch) {
      const lastCk = after.lastIndexOf(chunkIdMatch[chunkIdMatch.length - 1]);
      const lineEnd = after.indexOf("\n", lastCk);
      cutPos = Math.max(cutPos, lineEnd !== -1 ? lineEnd + 1 : after.length);
    }
    if (cutPos === 0) {
      // No anchors found; remove everything from the header onward
      cleaned = before.trim();
    } else {
      cleaned = (before + after.slice(cutPos)).trim();
    }
  }

  // New format: <memos_system_instruction>...</memos_system_instruction>\n\n📝 Related memories:...
  const memosTagIdx = cleaned.indexOf("<memos_system_instruction>");
  if (memosTagIdx !== -1) {
    const before = cleaned.slice(0, memosTagIdx);
    const after = cleaned.slice(memosTagIdx);
    const tsMatch = after.match(/\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}/);
    if (tsMatch && tsMatch.index != null) {
      cleaned = (before + after.slice(tsMatch.index)).trim();
    } else {
      cleaned = before.trim();
    }
  }

  return cleaned;
}

function stripEvidenceWrappers(text: string, evidenceTag: string): string {
  const tag = evidenceTag.trim();
  if (!tag) return text;

  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wrapperRe = new RegExp(`\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, "g");

  return text
    .replace(wrapperRe, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
