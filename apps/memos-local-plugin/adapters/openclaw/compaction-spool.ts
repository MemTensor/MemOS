import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const COMPACTION_TRACE_SPOOL_SCHEMA_VERSION = 1;
export const COMPACTION_TRACE_SPOOL_DIR_NAME = "openclaw-compaction-trace-spool";
export const COMPACTION_TRACE_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
export const COMPACTION_TRACE_WARN_BYTES = 8 * 1024 * 1024;

export interface CompactionTraceSegmentRef {
  path: string;
  seq: number;
  messageCount: number;
  bytes: number;
}

interface CompactionTraceSegmentFile {
  schemaVersion: number;
  sessionId: string;
  runId?: string;
  seq: number;
  createdAt: number;
  messages: unknown[];
}

export function defaultCompactionSpoolDir(): string {
  return path.join(tmpdir(), COMPACTION_TRACE_SPOOL_DIR_NAME);
}

export function writeCompactionSegmentSync(input: {
  dir: string;
  sessionId: string;
  runId?: string;
  seq: number;
  createdAt: number;
  messages: unknown[];
}): CompactionTraceSegmentRef {
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  chmodSync(input.dir, 0o700);
  const safeSessionId = input.sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
  const filePath = path.join(
    input.dir,
    `${safeSessionId}-${String(input.seq).padStart(6, "0")}-${randomUUID()}.json`,
  );
  const tmpPath = `${filePath}.tmp`;
  const body = JSON.stringify({
    schemaVersion: COMPACTION_TRACE_SPOOL_SCHEMA_VERSION,
    sessionId: input.sessionId,
    runId: input.runId,
    seq: input.seq,
    createdAt: input.createdAt,
    messages: input.messages,
  } satisfies CompactionTraceSegmentFile);
  writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
  return {
    path: filePath,
    seq: input.seq,
    messageCount: input.messages.length,
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

export function readCompactionSegmentMessagesSync(
  ref: CompactionTraceSegmentRef,
): unknown[] {
  const parsed = JSON.parse(readFileSync(ref.path, "utf8")) as Partial<CompactionTraceSegmentFile>;
  if (parsed.schemaVersion !== COMPACTION_TRACE_SPOOL_SCHEMA_VERSION) return [];
  return Array.isArray(parsed.messages) ? parsed.messages : [];
}

export function removeCompactionSegmentSync(ref: CompactionTraceSegmentRef): void {
  rmSync(ref.path, { force: true });
}

export function cleanupOrphanCompactionSegmentsSync(input: {
  dir: string;
  now: number;
  ttlMs?: number;
}): number {
  const ttlMs = input.ttlMs ?? COMPACTION_TRACE_ORPHAN_TTL_MS;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(input.dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") && !entry.endsWith(".json.tmp")) continue;
    const filePath = path.join(input.dir, entry);
    try {
      const stat = statSync(filePath);
      if (input.now - stat.mtimeMs <= ttlMs) continue;
      rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      /* best-effort orphan cleanup */
    }
  }
  return removed;
}
