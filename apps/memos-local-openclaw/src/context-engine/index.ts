/**
 * MemOS Local Memory — Context Engine
 *
 * Injects recalled memories into assistant messages wrapped in <relevant-memories>
 * tags. OpenClaw's UI automatically strips these tags from assistant messages,
 * keeping the chat clean while providing full context to the LLM.
 *
 * Memory blocks are persisted into the session file so the prompt prefix remains
 * stable across turns, maximizing KV cache reuse.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal AgentMessage shape used by OpenClaw */
export interface AgentMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface SearchHit {
  score: number;
  summary: string;
  original_excerpt?: string;
  source: { role: string; ts?: number; sessionKey?: string };
  ref: { chunkId: string; sessionKey?: string; turnId?: string; seq?: number };
  taskId?: string | null;
  skillId?: string | null;
  origin?: string;
  ownerName?: string;
  groupName?: string;
}

export interface RecallSearchResult {
  hits: SearchHit[];
}

export interface RecallEngineLike {
  search(params: {
    query: string;
    maxResults: number;
    minScore: number;
    ownerFilter?: string[];
  }): Promise<RecallSearchResult>;
}

export interface PendingInjection {
  sessionKey: string;
  memoryBlock: string;
  isSynthetic: boolean;
}

export interface ContextEngineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export function getTextFromMessage(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
  }
  return "";
}

export function appendMemoryToMessage(msg: AgentMessage, memoryBlock: string): void {
  if (typeof msg.content === "string") {
    msg.content = msg.content + memoryBlock;
    return;
  }
  if (Array.isArray(msg.content)) {
    const lastText = [...msg.content].reverse().find((b) => b.type === "text");
    if (lastText && typeof lastText.text === "string") {
      lastText.text += memoryBlock;
    } else {
      msg.content.push({ type: "text", text: memoryBlock });
    }
    return;
  }
  msg.content = memoryBlock;
}

const MEMORY_TAG_RE = /\n?<relevant-memories>[\s\S]*?<\/relevant-memories>/g;

export function removeExistingMemoryBlock(msg: AgentMessage): void {
  if (typeof msg.content === "string") {
    msg.content = msg.content.replace(MEMORY_TAG_RE, "");
    return;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = block.text.replace(MEMORY_TAG_RE, "");
      }
    }
  }
}

export function messageHasMemoryBlock(msg: AgentMessage): boolean {
  return getTextFromMessage(msg).includes("<relevant-memories>");
}

// ---------------------------------------------------------------------------
// Memory block formatting
// ---------------------------------------------------------------------------

export function formatMemoryBlock(hits: SearchHit[]): string {
  const lines = hits
    .map(
      (h, i) =>
        `${i + 1}. [${h.source.role}] ${(h.original_excerpt ?? h.summary).slice(0, 200)}`,
    )
    .join("\n");
  return (
    `\n<relevant-memories>\n` +
    `[Memory context relevant to the next user message — injected by user's memory system, not part of assistant's original reply]\n\n` +
    `${lines}\n` +
    `</relevant-memories>`
  );
}

// ---------------------------------------------------------------------------
// Deduplication (shared with main plugin)
// ---------------------------------------------------------------------------

export function deduplicateHits<T extends { summary: string }>(hits: T[]): T[] {
  const kept: T[] = [];
  for (const hit of hits) {
    const dominated = kept.some((k) => {
      const a = k.summary.toLowerCase();
      const b = hit.summary.toLowerCase();
      if (a === b) return true;
      const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 1));
      const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 1));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      let overlap = 0;
      for (const w of wordsB) {
        if (wordsA.has(w)) overlap++;
      }
      return overlap / Math.min(wordsA.size, wordsB.size) > 0.7;
    });
    if (!dominated) kept.push(hit);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Session manager helpers (for maintain() persistence)
// ---------------------------------------------------------------------------

interface SessionBranchEntry {
  id: string;
  type: string;
  parentId?: string | null;
  message?: AgentMessage;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
  fromHook?: unknown;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: unknown;
  name?: string;
  targetId?: string;
  label?: string;
}

interface SessionManagerLike {
  getBranch(): SessionBranchEntry[];
  branch(parentId: string): void;
  resetLeaf(): void;
  appendMessage(msg: unknown): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: unknown,
  ): string;
  appendThinkingLevelChange(level: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCustomEntry(customType: string, data: unknown): string;
  appendCustomMessageEntry(
    customType: string,
    content: unknown,
    display: unknown,
    details?: unknown,
  ): string;
  appendSessionInfo(name: string): string;
  branchWithSummary(
    parentId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: unknown,
  ): string;
  appendLabelChange(targetId: string, label: string): string;
}

/**
 * Re-append a branch entry preserving its type. Mirrors the
 * `appendBranchEntry` pattern from OpenClaw's transcript-rewrite module.
 */
function reappendEntry(sm: SessionManagerLike, entry: SessionBranchEntry): string {
  switch (entry.type) {
    case "message":
      return sm.appendMessage(entry.message);
    case "compaction":
      return sm.appendCompaction(
        entry.summary ?? "",
        entry.firstKeptEntryId ?? "",
        entry.tokensBefore ?? 0,
        entry.details,
        entry.fromHook,
      );
    case "thinking_level_change":
      return sm.appendThinkingLevelChange(entry.thinkingLevel ?? "");
    case "model_change":
      return sm.appendModelChange(entry.provider ?? "", entry.modelId ?? "");
    case "custom":
      return sm.appendCustomEntry(entry.customType ?? "", entry.data);
    case "custom_message":
      return sm.appendCustomMessageEntry(
        entry.customType ?? "",
        entry.content,
        entry.display,
        entry.details,
      );
    case "session_info":
      return sm.appendSessionInfo(entry.name ?? "");
    case "branch_summary":
      return sm.branchWithSummary(
        entry.parentId ?? null,
        entry.summary ?? "",
        entry.details,
        entry.fromHook,
      );
    default:
      if (entry.targetId !== undefined && entry.label !== undefined) {
        return sm.appendLabelChange(entry.targetId, entry.label);
      }
      return sm.appendMessage(entry.message);
  }
}

/**
 * Insert a synthetic assistant message at the start of the session branch
 * (before any existing entries). Uses the branch-and-reappend pattern.
 */
export function insertSyntheticAssistantEntry(
  sm: SessionManagerLike,
  memoryBlock: string,
): boolean {
  const branch = sm.getBranch();
  if (branch.length === 0) return false;

  const firstEntry = branch[0];
  if (firstEntry.parentId) {
    sm.branch(firstEntry.parentId);
  } else {
    sm.resetLeaf();
  }

  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: memoryBlock }],
    timestamp: Date.now(),
    stopReason: "end_turn",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });

  for (const entry of branch) {
    reappendEntry(sm, entry);
  }
  return true;
}

/**
 * Find the target assistant entry for memory injection in the session branch.
 * Returns the last assistant entry that appears before the last user entry.
 */
export function findTargetAssistantEntry(
  branch: SessionBranchEntry[],
): SessionBranchEntry | null {
  let lastUserIdx = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "message" && branch[i].message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;

  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (branch[i].type === "message" && branch[i].message?.role === "assistant") {
      return branch[i];
    }
  }
  return null;
}
