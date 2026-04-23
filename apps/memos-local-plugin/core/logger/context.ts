/**
 * Per-async-flow context propagation. Modules that want their `traceId`,
 * `sessionId`, `episodeId`, `turnId`, etc. attached to every log automatically
 * wrap their work in `withCtx({...}, fn)`.
 *
 * Backed by Node's `AsyncLocalStorage` so callbacks, `await`s, and timers all
 * inherit the right context.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { LogContext } from "../../agent-contract/log-record.js";
import { ids } from "../id.js";

const als = new AsyncLocalStorage<LogContext>();

/** Get the current ambient context (or `undefined` if none). */
export function getCtx(): LogContext | undefined {
  return als.getStore();
}

/**
 * Run `fn` with the merged context. Existing fields are kept unless overridden.
 * Returns whatever `fn` returns (preserves async).
 */
export function withCtx<T>(patch: Partial<LogContext>, fn: () => T): T {
  const merged: LogContext = { ...(als.getStore() ?? {}), ...patch };
  return als.run(merged, fn);
}

/** Set or replace ambient context for the current async flow. */
export function setCtx(patch: Partial<LogContext>): void {
  const cur = als.getStore();
  if (cur) Object.assign(cur, patch);
  // If no parent ALS scope exists we silently no-op; loggers will fall back to
  // their own static `child({ ctx })` defaults.
}

/**
 * Convenience: ensure a `traceId` exists in the current scope, generating
 * one if not. Returns the resolved id.
 */
export function ensureTraceId(): string {
  const cur = als.getStore();
  if (cur?.traceId) return cur.traceId as string;
  const traceId = ids.trace_corr();
  if (cur) cur.traceId = traceId;
  return traceId;
}
