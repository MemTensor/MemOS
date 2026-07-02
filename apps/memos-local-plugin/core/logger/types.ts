/**
 * Public types for the logger.
 *
 * `LogRecord`, `LogLevel`, `LogKind`, `LogContext` are re-exported from
 * `agent-contract/log-record.ts` so non-TS adapters can rely on the same
 * shape.
 */

import type {
  LogLevel,
  LogKind,
  LogRecord,
  LogContext,
  SerializedLogError,
} from "../../agent-contract/log-record.js";

export type { LogLevel, LogKind, LogRecord, LogContext, SerializedLogError };

// ─── Public Logger interface ────────────────────────────────────────────────

export interface LlmLogPayload {
  provider: string;
  model: string;
  /** Human label for which call site (e.g. "score.r-human"). */
  op: string;
  ms: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Estimated cost (USD). Best-effort, may be undefined. */
  costUsd?: number;
  /** May be redacted depending on config. */
  prompt?: string;
  completion?: string;
  /** Status: ok | retry | failure */
  status?: "ok" | "retry" | "failure";
  error?: SerializedLogError;
}

export interface PerfSpan {
  /** Stop the timer; emits a perf entry. Calling `end()` twice is a no-op. */
  end(extra?: Record<string, unknown>): void;
  /** Symbol.dispose so `using span = log.timer("op")` works. */
  [Symbol.dispose](): void;
}

export interface ChildOptions {
  channel: string;
  /** Default ctx fields; merged into every record from this child. */
  ctx?: Partial<LogContext>;
}

export interface Logger {
  /** The channel this logger emits on. */
  readonly channel: string;

  child(opts: ChildOptions): Logger;

  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info (msg: string, data?: Record<string, unknown>): void;
  warn (msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown> & { err?: unknown }): void;
  fatal(msg: string, data?: Record<string, unknown> & { err?: unknown }): void;

  /** Emit an audit-grade record (→ audit.log; 永不删除 retention). */
  audit(msg: string, data?: Record<string, unknown>): void;

  /** Emit an LLM-call record (→ llm.jsonl). */
  llm(payload: LlmLogPayload): void;

  /** Start a perf timer; closes via `using` or `.end()`. */
  timer(op: string, extra?: Record<string, unknown>): PerfSpan;

  /**
   * Forward an externally-constructed record (used by Hermes' Python adapter
   * to push its records into our sinks via the bridge).
   */
  forward(record: LogRecord): void;

  /** Best-effort flush of every transport. Called at shutdown. */
  flush(): Promise<void>;

  /** Close all transports. Subsequent emits are dropped. */
  close(): Promise<void>;
}

// ─── Low-level (used by transports / sinks) ────────────────────────────────

export interface Transport {
  readonly name: string;
  /** True if this transport accepts the given record (after redaction). */
  accepts(record: LogRecord): boolean;
  /** Write a record; transports MUST not throw — they should log internally. */
  write(record: LogRecord): void;
  /** Optional flush. */
  flush?(): Promise<void> | void;
  /** Optional close. */
  close?(): Promise<void> | void;
}

export interface Sink {
  readonly name: string;
  /** Whether this sink accepts the record. */
  accepts(record: LogRecord): boolean;
  /** Sinks own their own transports. */
  write(record: LogRecord): void;
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}
