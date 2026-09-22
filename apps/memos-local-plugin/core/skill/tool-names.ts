/**
 * Extract the set of tool / command names actually invoked in a batch of
 * traces, using the structured `ToolCallDTO` data rather than regex
 * heuristics on natural-language text.
 *
 * Two levels of extraction:
 *   1. `tc.name` — the tool-level identifier (e.g. "shell", "pip.install").
 *   2. First token of `tc.input` when input is a string — the command-level
 *      identifier for shell-like tools (e.g. "apk" from "apk add openssl-dev").
 */

import type { TraceRow } from "../types.js";

const IGNORED_NAMES = new Set(["unknown", "unknown_tool"]);

export function extractToolNames(traces: readonly TraceRow[]): Set<string> {
  const out = new Set<string>();
  for (const t of traces) {
    for (const tc of t.toolCalls) {
      const name = tc.name?.trim().toLowerCase();
      if (name && !IGNORED_NAMES.has(name)) out.add(name);

      if (typeof tc.input === "string") {
        const raw = tc.input.trim();
        // JSON tool arguments are payload, not shell commands.  Taking the
        // first whitespace token from them produces entries such as `{"code":`
        // and poisons the EVIDENCE_TOOLS whitelist.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          continue;
        }
        const first = raw.split(/\s+/)[0]?.toLowerCase();
        if (first && first.length >= 2) out.add(first);
      }
    }
  }
  return out;
}
