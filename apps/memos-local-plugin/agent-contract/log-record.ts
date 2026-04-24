/**
 * Wire shape of a single log line. This is the type non-TypeScript adapters
 * (e.g. Hermes' Python `log_forwarder.py`) serialize when forwarding their
 * own logs back through the bridge so everything ends up in the same files.
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric ordering for level comparisons. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/**
 * Stable shape for one structured log entry.
 *
 *   - `channel` is a dotted path: `<area>.<sub>.<verb-or-noun>`
 *   - `kind` lets a sink decide which file to append to ("app" → memos.log,
 *     "audit" → audit.log, "llm" → llm.jsonl, etc.)
 *   - `ctx` carries traceId/sessionId/episodeId/turnId/userId/agent so SSE
 *     consumers can stitch logs together
 *   - `data` is the structured payload (already redacted)
 *   - `err` is present only for errors and is a fully serialized error
 */
export const LOG_KINDS = ["app", "audit", "llm", "perf", "events", "error"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogContext {
  agent?: string;
  sessionId?: string;
  episodeId?: string;
  turnId?: string;
  traceId?: string;
  spanId?: string;
  userId?: string;
  /** Anything else the adapter wants to attach. */
  [k: string]: unknown;
}

export interface SerializedLogError {
  name: string;
  message: string;
  /** Stable error code if it's a `MemosError`. */
  code?: string;
  stack?: string;
  details?: Record<string, unknown>;
  cause?: SerializedLogError;
}

export interface LogRecord {
  /** Unix epoch milliseconds (UTC). */
  ts: number;
  level: LogLevel;
  kind: LogKind;
  channel: string;
  /** Human-readable short tag. Free-form, but conventionally `<area>.<verb>`. */
  msg: string;
  ctx?: LogContext;
  data?: Record<string, unknown>;
  err?: SerializedLogError;
  /** Process id of the emitter (helps when bridge + agent live in 2 procs). */
  pid?: number;
  /** Machine hostname (helps when forwarded across nodes). */
  host?: string;
  /** Source: "ts" | "py" | adapter name; defaults to "ts". */
  src?: string;
  /** Monotonically increasing per-process sequence (for replay ordering). */
  seq?: number;
}
