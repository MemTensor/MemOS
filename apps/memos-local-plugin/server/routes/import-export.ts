/**
 * Export + import endpoints.
 *
 *   GET  /api/v1/export          → stream a JSON bundle of every trace,
 *                                    policy, world model, and skill in
 *                                    the local store.
 *   POST /api/v1/import          → accept a JSON bundle and insert
 *                                    non-colliding rows.
 *   GET  /api/v1/import/hermes-native/scan
 *                                → count ~/.hermes/memories/MEMORY.md
 *                                    entries when running as Hermes.
 *   POST /api/v1/import/hermes-native/run
 *                                → import a batch from that file.
 *   GET  /api/v1/import/openclaw-native/scan
 *                                → count OpenClaw agent session JSONL
 *                                    messages when running as OpenClaw.
 *   POST /api/v1/import/openclaw-native/run
 *                                → import a batch from those JSONL files.
 *
 * The bundle shape is symmetric (what comes out can go back in) so
 * users can round-trip between devices without tooling. Binary blobs
 * (embeddings) are deliberately dropped on export — we can't
 * re-normalise them after transport.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TraceDTO } from "../../agent-contract/dto.js";
import type { ServerOptions } from "../types.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";
import { writeJson } from "../middleware/io.js";

const NATIVE_IMPORT_DEFAULT_BATCH = 25;
const NATIVE_IMPORT_MAX_BATCH = 200;

export function registerImportExportRoutes(
  routes: Routes,
  deps: ServerDeps,
  options: ServerOptions = {},
): void {
  const isHermes = options.agent === "hermes";
  const isOpenClaw = !options.agent || options.agent === "openclaw";

  routes.set("GET /api/v1/export", async (ctx) => {
    const bundle = await deps.core.exportBundle();
    // Hint to the browser that this is a download.
    ctx.res.setHeader(
      "content-disposition",
      `attachment; filename="memos-export-${new Date(bundle.exportedAt)
        .toISOString()
        .slice(0, 10)}.json"`,
    );
    writeJson(ctx.res, 200, bundle);
    return;
  });

  routes.set("POST /api/v1/import", async (ctx) => {
    // The frontend uses `FormData` with field `bundle` (a File). We
    // accept EITHER multipart OR raw JSON body, detected from the
    // content-type header.
    // IMPORTANT: do NOT lowercase the full header — the boundary value
    // is case-sensitive and lowercasing it breaks matching against
    // the body where the original-case boundary appears verbatim.
    const ct = ctx.req.headers["content-type"] ?? "";
    let bundle: Parameters<typeof deps.core.importBundle>[0] | null = null;

    const ctLower = ct.toLowerCase();
    if (ctLower.startsWith("application/json")) {
      bundle = parseJson(ctx);
    } else if (ctLower.startsWith("multipart/form-data")) {
      const parsed = parseMultipartBundle(ct, ctx.body);
      if (!parsed) {
        // Fallback: try parsing the raw body as JSON directly (some
        // environments strip multipart wrappers or the boundary detection
        // can fail on edge-case formatting).
        try {
          bundle = JSON.parse(ctx.body.toString("utf8"));
        } catch {
          writeError(ctx, 400, "invalid_argument", "missing 'bundle' file field");
          return;
        }
      } else {
        try {
          bundle = JSON.parse(parsed);
        } catch (err) {
          writeError(ctx, 400, "invalid_argument", "bundle is not valid JSON");
          return;
        }
      }
    } else {
      // Last resort: try parsing as JSON regardless of content-type
      try {
        bundle = JSON.parse(ctx.body.toString("utf8"));
      } catch {
        writeError(
          ctx,
          415,
          "unsupported_media_type",
          "content-type must be application/json or multipart/form-data",
        );
        return;
      }
    }

    if (!bundle || typeof bundle !== "object") {
      writeError(ctx, 400, "invalid_argument", "bundle must be a JSON object");
      return;
    }
    return await deps.core.importBundle(bundle);
  });

  routes.set("GET /api/v1/import/hermes-native/scan", async () => {
    const path = hermesNativeMemoryPath();
    if (!isHermes) {
      return {
        found: false,
        agent: options.agent ?? "openclaw",
        path,
        total: 0,
        error: "Hermes native memory import is only available from a Hermes viewer.",
      };
    }
    return await scanHermesNativeMemories(path);
  });

  routes.set("POST /api/v1/import/hermes-native/run", async (ctx) => {
    const path = hermesNativeMemoryPath();
    if (!isHermes) {
      writeError(
        ctx,
        404,
        "not_found",
        "Hermes native memory import is only available from a Hermes viewer.",
      );
      return;
    }

    const body = parseJson<{ offset?: unknown; limit?: unknown }>(ctx);
    const offset = coerceNonNegativeInt(body.offset, 0);
    const limit = coerceBatchLimit(body.limit);

    try {
      const source = await readHermesNativeMemories(path);
      const total = source.memories.length;
      const batch = source.memories.slice(offset, offset + limit);
      if (batch.length === 0) {
        return {
          agent: "hermes",
          path,
          total,
          offset,
          nextOffset: Math.min(offset, total),
          imported: 0,
          skipped: 0,
          done: offset >= total,
        };
      }

      const traces = buildHermesNativeTraces(batch, {
        offset,
        total,
        mtimeMs: source.mtimeMs,
      });
      const result = await deps.core.importBundle({
        version: 1,
        traces,
        policies: [],
        worldModels: [],
        skills: [],
      });
      const nextOffset = Math.min(offset + batch.length, total);
      return {
        agent: "hermes",
        path,
        total,
        offset,
        nextOffset,
        imported: result.imported,
        skipped: result.skipped,
        done: nextOffset >= total,
      };
    } catch (err) {
      writeError(ctx, 404, "not_found", (err as Error).message);
      return;
    }
  });

  routes.set("GET /api/v1/import/openclaw-native/scan", async () => {
    const path = openClawNativeSessionsPath();
    if (!isOpenClaw) {
      return {
        found: false,
        agent: options.agent ?? "hermes",
        path,
        total: 0,
        files: 0,
        sessions: 0,
        error: "OpenClaw native memory import is only available from an OpenClaw viewer.",
      };
    }
    return await scanOpenClawNativeSessions(path);
  });

  routes.set("POST /api/v1/import/openclaw-native/run", async (ctx) => {
    const path = openClawNativeSessionsPath();
    if (!isOpenClaw) {
      writeError(
        ctx,
        404,
        "not_found",
        "OpenClaw native memory import is only available from an OpenClaw viewer.",
      );
      return;
    }

    const body = parseJson<{ offset?: unknown; limit?: unknown }>(ctx);
    const offset = coerceNonNegativeInt(body.offset, 0);
    const limit = coerceBatchLimit(body.limit);

    try {
      const source = await readOpenClawNativeMessages(path);
      const total = source.messages.length;
      const batch = source.messages.slice(offset, offset + limit);
      if (batch.length === 0) {
        return {
          agent: "openclaw",
          path,
          total,
          offset,
          nextOffset: Math.min(offset, total),
          imported: 0,
          skipped: 0,
          done: offset >= total,
        };
      }

      const traces = buildOpenClawNativeTraces(batch);
      const result = await deps.core.importBundle({
        version: 1,
        traces,
        policies: [],
        worldModels: [],
        skills: [],
      });
      const nextOffset = Math.min(offset + batch.length, total);
      return {
        agent: "openclaw",
        path,
        total,
        offset,
        nextOffset,
        imported: result.imported,
        skipped: result.skipped,
        done: nextOffset >= total,
      };
    } catch (err) {
      writeError(ctx, 404, "not_found", (err as Error).message);
      return;
    }
  });
}

/**
 * Minimal multipart parser — we only want the first part named
 * `bundle`, as a UTF-8 string. A full implementation would hand off
 * to a library, but we avoid that here to keep the dependency graph
 * small.
 */
function parseMultipartBundle(contentType: string, body: Buffer): string | null {
  const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/i);
  if (!boundaryMatch) return null;
  // The boundary in the content-type header may or may not start with
  // dashes. In the body, each boundary line is always prefixed with "--".
  // We try both: `--<boundary>` and the raw boundary as-is.
  let raw = boundaryMatch[2]!;
  let boundaryBuf = Buffer.from(`--${raw}`);
  if (body.indexOf(boundaryBuf) < 0) {
    // The header already included the dashes (e.g. "boundary=----Webkit...")
    // so `--` + `----Webkit` = `------Webkit` which won't match.
    // Try using the raw boundary directly.
    boundaryBuf = Buffer.from(raw);
    if (body.indexOf(boundaryBuf) < 0) return null;
  }

  const crlfcrlf = Buffer.from("\r\n\r\n");

  let offset = 0;
  while (offset < body.length) {
    const bStart = body.indexOf(boundaryBuf, offset);
    if (bStart < 0) break;
    let partStart = bStart + boundaryBuf.length;
    // Skip CRLF after the boundary line
    if (partStart + 2 <= body.length &&
        body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
      partStart += 2;
    }
    const nextBoundary = body.indexOf(boundaryBuf, partStart);
    const partEnd = nextBoundary >= 0 ? nextBoundary : body.length;
    const part = body.subarray(partStart, partEnd);

    const headerEnd = part.indexOf(crlfcrlf);
    if (headerEnd < 0) { offset = partEnd; continue; }
    const headers = part.subarray(0, headerEnd).toString("utf8");
    if (!/name="bundle"/i.test(headers)) { offset = partEnd; continue; }

    let payload = part.subarray(headerEnd + 4);
    if (payload.length >= 2 &&
        payload[payload.length - 2] === 0x0d &&
        payload[payload.length - 1] === 0x0a) {
      payload = payload.subarray(0, payload.length - 2);
    }
    return payload.toString("utf8");
  }
  return null;
}

function hermesNativeMemoryPath(): string {
  return join(homedir(), ".hermes", "memories", "MEMORY.md");
}

function openClawHome(): string {
  return process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
}

function openClawNativeSessionsPath(): string {
  return join(openClawHome(), "agents");
}

interface HermesNativeScanResult {
  found: boolean;
  agent: "hermes";
  path: string;
  total: number;
  bytes?: number;
  error?: string;
}

async function scanHermesNativeMemories(path: string): Promise<HermesNativeScanResult> {
  try {
    const source = await readHermesNativeMemories(path);
    return {
      found: true,
      agent: "hermes",
      path,
      total: source.memories.length,
      bytes: source.bytes,
    };
  } catch (err) {
    return {
      found: false,
      agent: "hermes",
      path,
      total: 0,
      error: (err as Error).message,
    };
  }
}

async function readHermesNativeMemories(path: string): Promise<{
  memories: string[];
  bytes: number;
  mtimeMs: number;
}> {
  const info = await stat(path);
  const raw = await readFile(path, "utf8");
  return {
    memories: splitHermesNativeMemories(raw),
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  };
}

function splitHermesNativeMemories(raw: string): string[] {
  const out: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) out.push(text);
    current = [];
  };

  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.trim() === "§") {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return out;
}

function buildHermesNativeTraces(
  memories: readonly string[],
  opts: { offset: number; total: number; mtimeMs: number },
): TraceDTO[] {
  const baseTs = Number.isFinite(opts.mtimeMs) ? Math.floor(opts.mtimeMs) : Date.now();
  return memories.map((memory, i) => {
    const index = opts.offset + i;
    const hash = createHash("sha256")
      .update(`${index}\0${memory}`)
      .digest("hex")
      .slice(0, 24);
    const ts = Math.max(0, baseTs - Math.max(1, opts.total - index) * 1000);
    return {
      id: `tr_hm_${hash}` as never,
      episodeId: `ep_hm_${hash}` as never,
      sessionId: "se_hermes_native_memory" as never,
      ts: ts as never,
      userText: memory,
      agentText: "",
      summary: memory,
      toolCalls: [],
      reflection: undefined,
      value: 0.5 as never,
      alpha: 0.5 as never,
      priority: 0.5,
      turnId: ts as never,
    };
  });
}

interface OpenClawNativeMessage {
  agentId: string;
  sessionId: string;
  file: string;
  lineNo: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

interface OpenClawNativeScanResult {
  found: boolean;
  agent: "openclaw";
  path: string;
  total: number;
  files: number;
  sessions: number;
  error?: string;
}

async function scanOpenClawNativeSessions(path: string): Promise<OpenClawNativeScanResult> {
  try {
    const source = await readOpenClawNativeMessages(path);
    return {
      found: true,
      agent: "openclaw",
      path,
      total: source.messages.length,
      files: source.files,
      sessions: source.sessions,
    };
  } catch (err) {
    return {
      found: false,
      agent: "openclaw",
      path,
      total: 0,
      files: 0,
      sessions: 0,
      error: (err as Error).message,
    };
  }
}

async function readOpenClawNativeMessages(path: string): Promise<{
  messages: OpenClawNativeMessage[];
  files: number;
  sessions: number;
}> {
  const agentEntries = await readdir(path, { withFileTypes: true });
  const messages: OpenClawNativeMessage[] = [];
  let files = 0;
  let sessions = 0;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const sessionsDir = join(path, agentId, "sessions");
    let sessionFiles: string[] = [];
    try {
      sessionFiles = (await readdir(sessionsDir))
        .filter((f) => f.includes(".jsonl"))
        .sort();
    } catch {
      continue;
    }
    sessions += sessionFiles.length;

    for (const file of sessionFiles) {
      const filePath = join(sessionsDir, file);
      let fallbackTs = Date.now();
      try {
        fallbackTs = Math.floor((await stat(filePath)).mtimeMs);
      } catch {
        // Keep reading; the file may still be readable even if stat races.
      }
      let raw = "";
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      files++;
      const sessionId = file.replace(/\.jsonl.*$/, "");
      const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.type !== "message") continue;
        const role = obj.message?.role ?? obj.role;
        if (role !== "user" && role !== "assistant") continue;
        let content = extractOpenClawMessageText(obj.message?.content ?? obj.content);
        if (role === "user") content = stripOpenClawInboundMetadata(content);
        content = content.trim();
        if (content.length < 10) continue;
        const ts = normalizeOpenClawTimestamp(
          obj.message?.timestamp ?? obj.timestamp,
          fallbackTs + i,
        );
        messages.push({
          agentId,
          sessionId,
          file,
          lineNo: i + 1,
          role,
          content,
          ts,
        });
      }
    }
  }

  messages.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const af = `${a.agentId}/${a.file}`;
    const bf = `${b.agentId}/${b.file}`;
    if (af !== bf) return af.localeCompare(bf);
    return a.lineNo - b.lineNo;
  });
  return { messages, files, sessions };
}

function buildOpenClawNativeTraces(messages: readonly OpenClawNativeMessage[]): TraceDTO[] {
  return messages.map((msg) => {
    const hash = createHash("sha256")
      .update(`${msg.agentId}\0${msg.sessionId}\0${msg.file}\0${msg.lineNo}\0${msg.role}\0${msg.content}`)
      .digest("hex")
      .slice(0, 24);
    return {
      id: `tr_oc_${hash}` as never,
      episodeId: `ep_oc_${safeIdPart(msg.agentId)}_${safeIdPart(msg.sessionId)}` as never,
      sessionId: `se_oc_${safeIdPart(msg.agentId)}_${safeIdPart(msg.sessionId)}` as never,
      ts: msg.ts as never,
      userText: msg.role === "user" ? msg.content : "",
      agentText: msg.role === "assistant" ? msg.content : "",
      summary: msg.content,
      toolCalls: [],
      reflection: undefined,
      value: 0.5 as never,
      alpha: 0.5 as never,
      priority: 0.5,
      turnId: msg.ts as never,
    };
  });
}

function extractOpenClawMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => (part as { text: string }).text)
      .join("\n");
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const OPENCLAW_INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
];

const OPENCLAW_SENTINEL_FAST_RE = new RegExp(
  OPENCLAW_INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

const OPENCLAW_ENVELOPE_PREFIX_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[A-Z]{3}[+-]\d{1,2}\]\s*/;

function stripOpenClawInboundMetadata(text: string): string {
  let cleaned = stripOpenClawMemoryInjection(text).replace(OPENCLAW_ENVELOPE_PREFIX_RE, "");
  cleaned = cleaned.replace(/\[message_id:\s*[a-f0-9-]+\]/gi, "");
  cleaned = cleaned.replace(/\[\[reply_to_current\]\]/gi, "");
  if (!OPENCLAW_SENTINEL_FAST_RE.test(cleaned)) return cleaned.replace(OPENCLAW_ENVELOPE_PREFIX_RE, "").trim();

  const lines = cleaned.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!inMetaBlock && OPENCLAW_INBOUND_META_SENTINELS.some((s) => s === trimmed)) {
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
  return result.join("\n").replace(OPENCLAW_ENVELOPE_PREFIX_RE, "").trim();
}

function stripOpenClawMemoryInjection(text: string): string {
  let cleaned = text;
  const mcStart = cleaned.indexOf("<memory_context>");
  if (mcStart !== -1) {
    const mcEnd = cleaned.indexOf("</memory_context>");
    cleaned = mcEnd !== -1
      ? cleaned.slice(0, mcStart) + cleaned.slice(mcEnd + "</memory_context>".length)
      : cleaned.slice(0, mcStart);
  }
  cleaned = cleaned.replace(
    /=== MemOS LONG-TERM MEMORY[\s\S]*?(?:MANDATORY[^\n]*\n?|(?=\n{2,}))/gi,
    "",
  );
  cleaned = cleaned.replace(
    /\[MemOS Auto-Recall\][^\n]*\n(?:(?:\d+\.\s+\[(?:USER|ASSISTANT)[^\n]*\n?)*)/gi,
    "",
  );
  cleaned = cleaned.replace(
    /## Memory system\n+No memories were automatically recalled[^\n]*(?:\n[^\n]*memory_search[^\n]*)*/gi,
    "",
  );
  return cleaned.trim();
}

function normalizeOpenClawTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "session";
}

function coerceNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function coerceBatchLimit(value: unknown): number {
  const n = coerceNonNegativeInt(value, NATIVE_IMPORT_DEFAULT_BATCH);
  if (n <= 0) return NATIVE_IMPORT_DEFAULT_BATCH;
  return Math.min(n, NATIVE_IMPORT_MAX_BATCH);
}
