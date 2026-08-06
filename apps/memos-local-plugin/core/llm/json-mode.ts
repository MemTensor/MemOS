/**
 * JSON-mode utilities.
 *
 * LLMs routinely answer "sure, here's your JSON:" followed by Markdown-fenced
 * code. We want a single function that takes raw text and hands back a
 * parsed object (or throws a specific `llm_output_malformed` error).
 *
 * Fallback-cascade:
 *   1. Straight `JSON.parse(raw.trim())`.
 *   2. Strip ```json … ``` fences and try again.
 *   3. Extract the first balanced `{ … }` / `[ … ]` block and try.
 *   4. Remove trailing commas before `}`/`]` and try.
 *   5. Give up, throw `LLM_OUTPUT_MALFORMED`.
 *
 * We avoid heroics (no partial repair beyond trailing commas) because
 * silently "fixing" broken JSON makes algorithm bugs invisible.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmProviderName } from "./types.js";

export interface ParseOpts {
  provider?: LlmProviderName;
  op?: string;
}

export function parseLlmJson<T = unknown>(raw: string, opts: ParseOpts = {}): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw malformed("empty response", raw, opts);
  }

  const candidates: string[] = [];
  candidates.push(trimmed);

  const stripped = stripFences(trimmed);
  if (stripped !== trimmed) candidates.push(stripped);

  const extracted = extractFirstJsonBlock(stripped);
  if (extracted && extracted !== stripped) candidates.push(extracted);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // keep trying
    }
  }

  // Last resort: strip trailing commas before `}` and `]`.
  for (const c of candidates) {
    const repaired = removeTrailingCommas(c);
    if (repaired !== c) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // ignore and fall through
      }
    }
  }

  throw malformed("unparseable JSON after best-effort repair", raw, opts);
}

function stripFences(s: string): string {
  // Strip one layer of ```…``` fences, with or without a lang tag.
  const fence = /^```(?:json|JSON|jsonl|jsonc)?\s*([\s\S]*?)\s*```$/m;
  const m = fence.exec(s);
  if (m && typeof m[1] === "string") return m[1].trim();
  // Single-line fence: ```…```
  const inline = /^```\s*([\s\S]*?)\s*```\s*$/m.exec(s);
  if (inline && typeof inline[1] === "string") return inline[1].trim();
  return s;
}

/**
 * Find the first balanced `{…}` or `[…]` block. Returns null when nothing
 * obvious is found. Naive — but good enough for LLMs that say "Here you go:
 * {…}" or "I'll return [ …, … ] now."
 */
function extractFirstJsonBlock(s: string): string | null {
  const openers = ["{", "["];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!openers.includes(ch!)) continue;
    const match = walkToClose(s, i);
    if (match) return match;
  }
  return null;
}

function walkToClose(s: string, start: number): string | null {
  const open = s[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function removeTrailingCommas(s: string): string {
  // Strip `,` right before `}` / `]`, ignoring commas inside strings.
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (!inStr && ch === ",") {
      // Look ahead past whitespace for `}` or `]`
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") {
        continue; // drop this comma
      }
    }
    out += ch;
  }
  return out;
}

function malformed(reason: string, raw: string, opts: ParseOpts): MemosError {
  return new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, `LLM output not valid JSON: ${reason}`, {
    provider: opts.provider,
    op: opts.op,
    rawPreview: raw.slice(0, 512),
  });
}

/**
 * Build the "you MUST respond with JSON" instruction that goes into the
 * system prompt for providers that don't have native JSON mode.
 */
export function buildJsonSystemHint(hint?: string): string {
  const base = "Respond with a single valid JSON value and nothing else. Do not wrap in Markdown code fences. Do not include explanations.";
  if (!hint) return base;
  return `${base}\n\nExpected shape:\n${hint}`;
}
