/**
 * Error-signature extractor — V7 §2.6 "structural match" input.
 *
 * Tier 2 retrieval (see `core/retrieval/tier2-trace.ts`) can do three
 * kinds of match against the current step: semantic (embedding cosine),
 * tag pre-filter, and **structural** — exact-substring match of the
 * error token that the agent just saw. V7 uses this for cases like
 * hitting `"pg_config executable not found"` again after a similar
 * failure days ago.
 *
 * This module:
 *   1. Extracts normalised error tokens from `ToolCallDTO` outputs +
 *      error codes + assistant text.
 *   2. Ranks them by specificity (more unusual tokens first).
 *   3. Returns at most `MAX_SIGNATURES` tokens so the hot-path query
 *      stays bounded.
 *
 * We intentionally do NOT use the LLM here — this runs on every trace
 * write and must be cheap + deterministic.
 */
import type { ToolCallDTO } from "../../agent-contract/dto.js";

/** Max signatures we keep per trace. Anything beyond is dropped. */
export const MAX_SIGNATURES = 4;

/** Min length of a usable error fragment (after normalisation). */
const MIN_FRAGMENT_LEN = 6;

/** Max length of a stored fragment. */
const MAX_FRAGMENT_LEN = 160;

/**
 * Patterns we extract verbatim — order matters. The first capture group
 * is the normalised signature.
 */
const ERROR_PATTERNS: RegExp[] = [
  // Go / Rust / Python-ish: `<Name>Error: <body>`
  /\b([A-Z][A-Za-z0-9]*(?:Error|Exception)):\s*([^\n]{4,160})/g,
  // `error: <body>` / `Error: <body>` / `fatal: <body>`
  /\b(?:error|Error|fatal|FATAL|ERROR)\s*:\s*([^\n]{4,160})/g,
  // `<cmd>: <thing> not found`
  /\b([A-Za-z0-9_\-./]+):\s*[^\n]{0,40}\b(not found|no such (?:file|directory)|permission denied|undefined reference|command not found)\b[^\n]*/g,
  // `<thing> is required`, `<thing> must be`, `<thing> cannot`
  /\b([A-Za-z0-9_]{3,40})\s+(is required|must be|cannot|could not|failed to)\s+[^\n]{3,120}/g,
  // exit code / status
  /\bexit (?:code|status)\s*[:=]?\s*(\d{1,4})\b[^\n]{0,80}/g,
  // HTTP-ish status codes with a body
  /\b(4\d\d|5\d\d)\s+([A-Za-z][A-Za-z ]{2,30})\b/g,
];

/** Common high-frequency tokens we drop before dedup. */
const STOP_WORDS = new Set([
  "the",
  "for",
  "this",
  "that",
  "your",
  "from",
  "with",
  "have",
  "has",
  "not",
  "a",
  "an",
  "of",
  "to",
  "is",
  "in",
  "on",
  "by",
]);

// ─── Public API ────────────────────────────────────────────────────────────

export interface ExtractInput {
  toolCalls: readonly ToolCallDTO[];
  /** Free-form assistant reply for the turn (reflection may live here). */
  agentText?: string;
  /** Reflection text, when the adapter surfaced one. */
  reflection?: string;
}

/**
 * Produce up to {@link MAX_SIGNATURES} normalised error fragments,
 * ordered by specificity (more "unusual" first).
 */
export function extractErrorSignatures(input: ExtractInput): string[] {
  const corpus: string[] = [];

  for (const tc of input.toolCalls) {
    if (tc.errorCode) corpus.push(String(tc.errorCode));
    const out = stringifyToolOutput(tc.output);
    if (out) corpus.push(out);
  }
  if (input.reflection) corpus.push(input.reflection);
  if (input.agentText) corpus.push(input.agentText);

  // We dedupe by a lowercased/collapsed key so overlapping regex patterns
  // don't produce near-duplicate fragments ("Error: X" vs "error: X").
  // The first-seen casing wins for the stored fragment.
  const candidates = new Map<string, { frag: string; freq: number }>();
  for (const text of corpus) {
    for (const frag of extractFragments(text)) {
      const normalised = normaliseFragment(frag);
      if (!normalised) continue;
      const key = normalised.toLowerCase().replace(/\s+/g, " ");
      const existing = candidates.get(key);
      if (existing) {
        existing.freq++;
      } else {
        candidates.set(key, { frag: normalised, freq: 1 });
      }
    }
  }

  const scored = Array.from(candidates.values()).map(({ frag, freq }) => ({
    frag,
    freq,
    score: specificityScore(frag, freq),
  }));
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_SIGNATURES).map((s) => s.frag);
}

// ─── Internals ─────────────────────────────────────────────────────────────

function stringifyToolOutput(out: unknown): string {
  if (out == null) return "";
  if (typeof out === "string") return out;
  try {
    return JSON.stringify(out).slice(0, 4000);
  } catch {
    return "";
  }
}

function extractFragments(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const pattern of ERROR_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      // Use the raw match (m[0]) as the fragment since the pattern
      // captures the interesting bit as part of the whole match.
      out.push(m[0]);
      if (out.length >= 32) break; // hard cap per pattern
    }
  }
  return out;
}

function normaliseFragment(frag: string): string | null {
  const collapsed = frag
    .replace(/\s+/g, " ")
    .replace(/[\u200b\u00a0]/g, "")
    .trim();
  if (collapsed.length < MIN_FRAGMENT_LEN) return null;
  const truncated =
    collapsed.length > MAX_FRAGMENT_LEN
      ? collapsed.slice(0, MAX_FRAGMENT_LEN)
      : collapsed;
  // Reject fragments that are just stop words / numbers.
  const alpha = truncated.replace(/[^A-Za-z]/g, "");
  if (alpha.length < 4) return null;
  const lower = truncated.toLowerCase();
  const words = lower.split(/[^a-z0-9_]+/).filter(Boolean);
  if (words.every((w) => STOP_WORDS.has(w))) return null;
  return truncated;
}

/**
 * Prefer fragments that contain unusual tokens (PascalCase identifiers,
 * filesystem paths, error codes). Higher score → more specific.
 */
function specificityScore(frag: string, freq: number): number {
  let score = 0;
  if (/\b[A-Z][a-zA-Z]*Error\b/.test(frag)) score += 3;
  if (/\b[A-Z][a-zA-Z]*Exception\b/.test(frag)) score += 3;
  if (/(\b|_)E[A-Z]{3,}\b/.test(frag)) score += 2; // ENOENT, EACCES, etc.
  if (/\/[a-zA-Z0-9._\-/]+/.test(frag)) score += 2; // path
  if (/\bcode\s*=\s*\d+/.test(frag)) score += 1;
  if (/\b\d{3}\b/.test(frag)) score += 1; // status
  if (/_/.test(frag)) score += 1; // snake_case ids
  score += Math.min(2, freq - 1); // a little boost for repeated fragments
  // Penalise very long fragments — specificity should be concise.
  if (frag.length > 120) score -= 1;
  return score;
}
