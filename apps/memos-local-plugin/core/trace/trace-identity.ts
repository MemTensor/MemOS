/**
 * Stable content signature for L1 traces — matches capture's dedupe key so
 * skill evidence gathering ignores orphan duplicate rows (see diagnose.md).
 */

import type { TraceRow } from "../types.js";

export function traceIdentitySignature(row: TraceRow, anchorTurnId: number): string {
  const tool = row.toolCalls[0];
  if (tool) {
    const hasRealTiming =
      typeof tool.startedAt === "number" || typeof tool.endedAt === "number";
    return [
      "tool",
      anchorTurnId,
      tool.name,
      hasRealTiming ? tool.startedAt ?? "" : row.ts,
      hasRealTiming ? tool.endedAt ?? "" : "",
      stableJson(tool.input),
      stableJson(tool.output),
      tool.errorCode ?? "",
    ].join("\x1f");
  }
  if (row.agentText.trim()) {
    return ["assistant", anchorTurnId, row.ts, row.agentText.trim()].join("\x1f");
  }
  return ["user", anchorTurnId, row.ts, row.userText.trim()].join("\x1f");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, sortJson(val)]),
  );
}
