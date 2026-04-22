/**
 * Single-line, key=value compact format. Useful in CI / docker logs where
 * JSON noise would drown the signal but you still want machine-grep-ability.
 */

import { isoFromEpochMs } from "../../time.js";
import type { LogRecord } from "../types.js";

export function formatCompact(record: LogRecord): string {
  const parts: string[] = [];
  parts.push(isoFromEpochMs(record.ts));
  parts.push(record.level);
  parts.push(record.kind);
  parts.push(`channel=${record.channel}`);
  parts.push(`msg=${quote(record.msg)}`);
  if (record.ctx) for (const [k, v] of Object.entries(record.ctx)) parts.push(`ctx.${k}=${pretty(v)}`);
  if (record.data) for (const [k, v] of Object.entries(record.data)) parts.push(`${k}=${pretty(v)}`);
  if (record.err) parts.push(`err=${quote(`${record.err.name}: ${record.err.message}`)}`);
  return parts.join(" ") + "\n";
}

function pretty(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return quote(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return quote(JSON.stringify(v));
}

function quote(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
