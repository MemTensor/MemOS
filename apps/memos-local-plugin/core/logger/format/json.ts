/**
 * Strict JSON formatter. One line per record. Used by file transports and the
 * SSE broadcast.
 */

import type { LogRecord } from "../types.js";

export function formatJson(record: LogRecord): string {
  return safeStringify(record) + "\n";
}

/**
 * `JSON.stringify` that survives circular references and unrepresentable
 * values. We never let a logging call crash.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
    }
    return v;
  });
}
