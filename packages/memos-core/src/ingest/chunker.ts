export type ChunkKind = "paragraph" | "code_block" | "error_stack" | "list" | "command";

export interface RawChunk {
  content: string;
  kind: ChunkKind;
}

const MAX_CHUNK_CHARS = 3000;
const MIN_CHUNK_CHARS = 40;
const IDEAL_CHUNK_CHARS = 1500;

const FENCED_CODE_RE = /^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm;

const FUNC_OPEN_RE =
  /^[ \t]*(?:(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:\([^)]*\)|[^=])*=>)|(?:def |class )|(?:func |fn |pub\s+fn )|(?:public |private |protected |static )+.*\{)\s*$/;
const BLOCK_CLOSE_RE = /^[ \t]*[}\]]\s*;?\s*$/;

const ERROR_STACK_RE =
  /(?:(?:Error|Exception|Traceback)[^\n]*\n(?:\s+at\s+[^\n]+\n?|.*File "[^\n]+\n?|.*line \d+[^\n]*\n?){2,})/gm;
const LIST_BLOCK_RE = /(?:^[\s]*[-*•]\s+.+\n?){3,}/gm;
const COMMAND_LINE_RE = /^(?:\$|>|#)\s+.+$/gm;

/**
 * Semantic-aware chunking:
 * 1. Extract fenced code blocks as whole units (never split inside)
 * 2. Detect unfenced code regions by brace-matching (functions/classes kept intact)
 * 3. Extract error stacks, list blocks, command lines as separate chunks
 * 4. Split remaining prose at paragraph boundaries (double newline)
 * 5. Merge short adjacent chunks
 */
export function chunkText(text: string): RawChunk[] {
  let remaining = text;
  const slots: Array<{ placeholder: string; content: string; kind: ChunkKind }> = [];
  let counter = 0;

  function ph(content: string, kind: ChunkKind = "paragraph"): string {
    const tag = `\x00SLOT_${counter++}\x00`;
    slots.push({ placeholder: tag, content: content.trim(), kind });
    return tag;
  }

  remaining = remaining.replace(FENCED_CODE_RE, (m) => ph(m, "code_block"));
  remaining = extractBraceBlocks(remaining, ph);

  const structuralKinds: Array<[RegExp, ChunkKind]> = [
    [ERROR_STACK_RE, "error_stack"],
    [LIST_BLOCK_RE, "list"],
    [COMMAND_LINE_RE, "command"],
  ];
  for (const [re, kind] of structuralKinds) {
    remaining = remaining.replace(re, (m) => ph(m, kind));
  }

  const raw: RawChunk[] = [];
  const sections = remaining.split(/\n{2,}/);

  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;

    if (trimmed.includes("\x00SLOT_")) {
      const parts = trimmed.split(/(\x00SLOT_\d+\x00)/);
      for (const part of parts) {
        const slot = slots.find((s) => s.placeholder === part);
        if (slot) {
          raw.push({ content: slot.content, kind: slot.kind });
        } else if (part.trim().length >= MIN_CHUNK_CHARS) {
          raw.push({ content: part.trim(), kind: "paragraph" });
        }
      }
    } else if (trimmed.length >= MIN_CHUNK_CHARS) {
      raw.push({ content: trimmed, kind: "paragraph" });
    }
  }

  for (const s of slots) {
    if (!raw.some((c) => c.content === s.content)) {
      raw.push({ content: s.content, kind: s.kind });
    }
  }

  const merged = mergeSmallChunks(raw);
  const final = splitOversized(merged);

  return final.length > 0 ? final : [{ content: text.trim(), kind: "paragraph" }];
}

/**
 * Detect function/class bodies that aren't inside fenced blocks.
 * Tracks brace depth to keep complete blocks together.
 */
function extractBraceBlocks(
  text: string,
  ph: (content: string, kind?: ChunkKind) => string,
): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let blockLines: string[] = [];
  let depth = 0;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("\x00SLOT_")) {
      if (inBlock) {
        blockLines.push(line);
      } else {
        result.push(line);
      }
      continue;
    }

    if (!inBlock && FUNC_OPEN_RE.test(line)) {
      inBlock = true;
      blockLines = [line];
      depth = countBraces(line);
      if (depth <= 0) depth = 1;
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
      depth += countBraces(line);
      if (depth <= 0 || (BLOCK_CLOSE_RE.test(line) && depth <= 0)) {
        const block = blockLines.join("\n");
        if (block.trim().length >= MIN_CHUNK_CHARS) {
          result.push(ph(block, "code_block"));
        } else {
          result.push(block);
        }
        inBlock = false;
        blockLines = [];
        depth = 0;
      }
    } else {
      result.push(line);
    }
  }

  if (blockLines.length > 0) {
    const block = blockLines.join("\n");
    if (block.trim().length >= MIN_CHUNK_CHARS) {
      result.push(ph(block, "code_block"));
    } else {
      result.push(block);
    }
  }

  return result.join("\n");
}

function countBraces(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === "{" || ch === "(") d++;
    else if (ch === "}" || ch === ")") d--;
  }
  return d;
}

function mergeSmallChunks(chunks: RawChunk[]): RawChunk[] {
  if (chunks.length <= 1) return chunks;
  const merged: RawChunk[] = [];
  let buf: RawChunk | null = null;

  for (const c of chunks) {
    if (!buf) {
      buf = { ...c };
      continue;
    }

    const bothSmall = buf.content.length < IDEAL_CHUNK_CHARS && c.content.length < IDEAL_CHUNK_CHARS;
    const mergedLen = buf.content.length + c.content.length + 2;

    if (bothSmall && mergedLen <= MAX_CHUNK_CHARS) {
      buf.content = buf.content + "\n\n" + c.content;
    } else {
      merged.push(buf);
      buf = { ...c };
    }
  }
  if (buf) merged.push(buf);
  return merged;
}

function splitOversized(chunks: RawChunk[]): RawChunk[] {
  const result: RawChunk[] = [];
  for (const c of chunks) {
    if (c.content.length <= MAX_CHUNK_CHARS) {
      result.push(c);
      continue;
    }
    result.push(...splitAtSentenceBoundary(c.content));
  }
  return result;
}

function splitAtSentenceBoundary(text: string): RawChunk[] {
  const sentences = text.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n{2,})/g) ?? [text];
  const result: RawChunk[] = [];
  let buf = "";

  for (const s of sentences) {
    if (buf.length + s.length > MAX_CHUNK_CHARS && buf.length > 0) {
      result.push({ content: buf.trim(), kind: "paragraph" });
      buf = "";
    }
    buf += s;
  }
  if (buf.trim().length >= MIN_CHUNK_CHARS) {
    result.push({ content: buf.trim(), kind: "paragraph" });
  }
  return result;
}
