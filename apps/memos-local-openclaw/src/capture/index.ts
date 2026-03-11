import type { ConversationMessage, Role, Logger } from "../types";

const SKIP_ROLES: Set<Role> = new Set(["system"]);

const SYSTEM_BOILERPLATE_RE = /^A new session was started via \/new or \/reset\b/;

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
): ConversationMessage[] {
  const now = Date.now();
  const result: ConversationMessage[] = [];

  for (const msg of messages) {
    const role = msg.role as Role;
    if (SKIP_ROLES.has(role)) continue;
    if (!msg.content || msg.content.trim().length === 0) continue;

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
      content = stripEvidenceWrappers(content, evidenceTag);
    }
    if (!content.trim()) continue;

    result.push({
      role,
      content,
      timestamp: now,
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
  let cleaned = stripEnvelopePrefix(text);

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

function stripEnvelopePrefix(text: string): string {
  return text.replace(ENVELOPE_PREFIX_RE, "");
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
