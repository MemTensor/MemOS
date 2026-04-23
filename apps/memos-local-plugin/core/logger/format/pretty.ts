/**
 * Human-friendly console formatter. Used in dev when `logging.console.pretty`
 * is true. Doesn't try to be fancy: timestamp + level + channel + msg + a
 * single-line `key=val` summary of `data`.
 *
 * Colors are applied only when stdout is a TTY (so piping to a file stays clean).
 */

import { isoFromEpochMs } from "../../time.js";
import type { LogRecord } from "../types.js";

const COLOR_BY_LEVEL: Record<string, string> = {
  trace: "\x1b[2;37m",
  debug: "\x1b[36m",
  info:  "\x1b[32m",
  warn:  "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[1;41;37m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const KIND_TAG: Record<string, string> = {
  app: "",
  audit: "[audit] ",
  llm: "[llm] ",
  perf: "[perf] ",
  events: "[event] ",
  error: "",
};

export function formatPretty(record: LogRecord, opts: { color: boolean }): string {
  const ts = isoFromEpochMs(record.ts).slice(11, 23); // HH:mm:ss.SSS
  const lvl = record.level.toUpperCase().padEnd(5);
  const kind = KIND_TAG[record.kind] ?? "";
  const channel = record.channel ?? "?";

  const dataPart = record.data ? " " + summarize(record.data) : "";
  const ctxPart = record.ctx && Object.keys(record.ctx).length > 0 ? " " + summarize(record.ctx) : "";
  const errPart = record.err ? "\n  " + summarizeErr(record.err) : "";

  const line = `${ts} ${lvl} [${channel}] ${kind}${record.msg}${dataPart}${ctxPart}${errPart}`;
  if (!opts.color) return line;

  const c = COLOR_BY_LEVEL[record.level] ?? "";
  return `${DIM}${ts}${RESET} ${c}${lvl}${RESET} ${DIM}[${channel}]${RESET} ${kind}${record.msg}${DIM}${dataPart}${ctxPart}${RESET}${errPart}`;
}

function summarize(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    parts.push(`${k}=${shortVal(v)}`);
  }
  return parts.join(" ");
}

function shortVal(v: unknown): string {
  if (typeof v === "string") {
    if (v.length <= 60) return JSON.stringify(v);
    return JSON.stringify(v.slice(0, 57) + "…");
  }
  if (typeof v === "number" || typeof v === "boolean" || v == null) return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    return `{${keys.slice(0, 3).join(",")}${keys.length > 3 ? ",…" : ""}}`;
  }
  return String(v);
}

function summarizeErr(err: { name: string; message: string; code?: string; stack?: string }): string {
  const head = `${err.name}${err.code ? `(${err.code})` : ""}: ${err.message}`;
  if (!err.stack) return head;
  const stackHead = err.stack.split("\n").slice(1, 4).join("\n  ");
  return `${head}\n  ${stackHead}`;
}
