/**
 * Convert a `RetrievalCtx` into a single embedding-friendly query string +
 * a set of coarse domain tags to pre-filter Tier-2 with.
 *
 * Keeping this logic in one place means the 5 entry points in `retrieve.ts`
 * don't each reinvent "what do we embed?" — they all call `buildQuery(ctx)`.
 *
 * Not perf-sensitive: inputs are short (≤ a few KB) and we do plain regex
 * scans, no LLM calls.
 */

import { extractErrorSignatures } from "../capture/error-signature.js";
import { extractPatternTerms, prepareFtsMatch } from "../storage/keyword.js";
import type { RetrievalCtx } from "./types.js";

const MAX_QUERY_CHARS = 1_500;

/** Public tag list kept in sync with `capture/tagger.ts#KEYWORD_TAGS`. */
const KEYWORD_TAGS: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\bdocker\b|\bcontainer\b/i, tag: "docker" },
  { re: /\bkubernetes\b|\bkubectl\b|\bk8s\b/i, tag: "kubernetes" },
  { re: /\bpip\b|\brequirements\.txt\b/i, tag: "pip" },
  { re: /\bnpm\b|\byarn\b|\bpnpm\b|\bpackage\.json\b/i, tag: "npm" },
  { re: /\bsqlite\b|\bpostgres\b|\bmysql\b|\bdatabase\b/i, tag: "database" },
  { re: /\bsql\b|\bselect\s|\binsert\s/i, tag: "sql" },
  { re: /\bshell\b|\bbash\b|\bzsh\b|\bterminal\b/i, tag: "shell" },
  { re: /\bgit\b|\bcommit\b|\bmerge\b|\bbranch\b/i, tag: "git" },
  { re: /\bpython\b|\.py\b/i, tag: "python" },
  { re: /\btypescript\b|\.ts\b|\.tsx\b/i, tag: "typescript" },
  { re: /\bjavascript\b|\.js\b|\.jsx\b/i, tag: "javascript" },
  { re: /\brust\b|\bcargo\b|\.rs\b/i, tag: "rust" },
  { re: /\bplugin\b/i, tag: "plugin" },
  { re: /\bapi\b|\brest\b|\bhttp\b/i, tag: "http" },
  { re: /network|\bdns\b|\bproxy\b/i, tag: "network" },
  { re: /\bauth(entication|orization)?\b|\btoken\b|\boauth\b/i, tag: "auth" },
  { re: /\btest\b|\bunit test\b|\bjest\b|\bvitest\b|\bpytest\b/i, tag: "test" },
  { re: /\berror\b|\bexception\b|\btraceback\b/i, tag: "error" },
];

export interface CompiledQuery {
  /** Primary text that will be embedded. */
  text: string;
  /** Extracted coarse tags (lowercase, sorted, deduped). */
  tags: string[];
  /**
   * V7 §2.6 structural fragments — verbatim error snippets to feed the
   * Tier 2 structural-match path. Same shape / normalisation rules as
   * the capture-side extractor (`core/capture/error-signature.ts`) so
   * `instr()` hits align.
   */
  structuralFragments: string[];
  /**
   * FTS5 MATCH expression for the keyword channel (trigram tokenizer).
   * `null` means "no usable token, skip the FTS channel".
   */
  ftsMatch: string | null;
  /**
   * Pattern-channel terms — short ASCII tokens (length 2) and CJK
   * bigrams that fall below the trigram window. Each term feeds a
   * `LIKE %term%` clause in `searchByPattern`. Empty array = skip.
   */
  patternTerms: string[];
  /** Did we truncate the text? Useful for logs. */
  truncated: boolean;
}

/**
 * Build a `CompiledQuery` from a retrieval context. Behavior varies per
 * reason so that e.g. `decision_repair` biases toward the failing tool name.
 */
export function buildQuery(ctx: RetrievalCtx): CompiledQuery {
  switch (ctx.reason) {
    case "turn_start": {
      const hintText = hintToText(ctx.contextHints);
      const parts = [ctx.userText?.trim() ?? ""];
      if (hintText) parts.push(hintText);
      return finalize(parts.join("\n"));
    }
    case "tool_driven": {
      const args = renderArgs(ctx.args);
      return finalize(`tool:${ctx.tool}\n${args}`);
    }
    case "skill_invoke": {
      const head = ctx.skillId ? `skill:${ctx.skillId}\n` : "";
      return finalize(head + (ctx.query ?? ""));
    }
    case "sub_agent": {
      const profile = ctx.profile ? `profile:${ctx.profile}\n` : "";
      return finalize(profile + (ctx.mission ?? ""));
    }
    case "decision_repair": {
      const head = `failing_tool:${ctx.failingTool}\nfailures:${ctx.failureCount}\n`;
      const tail = ctx.lastErrorCode ? `error:${ctx.lastErrorCode}` : "";
      return finalize(head + tail);
    }
    default: {
      // Exhaustiveness — compile-time check.
      const _exhaustive: never = ctx;
      void _exhaustive;
      return {
        text: "",
        tags: [],
        structuralFragments: [],
        ftsMatch: null,
        patternTerms: [],
        truncated: false,
      };
    }
  }
}

/** Extract the coarse domain tags *without* embedding — cheaper for logs. */
export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const { re, tag } of KEYWORD_TAGS) {
    if (re.test(text)) tags.add(tag);
  }
  return [...tags].sort();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function finalize(raw: string): CompiledQuery {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return {
      text: "",
      tags: [],
      structuralFragments: [],
      ftsMatch: null,
      patternTerms: [],
      truncated: false,
    };
  }

  const tags = extractTags(trimmed);
  // Reuse the capture-side extractor so signature shapes stay identical
  // between write-side and read-side.
  const structuralFragments = extractErrorSignatures({
    toolCalls: [],
    agentText: trimmed,
  });
  // Keyword channels — derived from the original text *before* truncation
  // so we don't lose tail content. The actual queries are bounded by the
  // helpers themselves.
  const ftsMatch = prepareFtsMatch(trimmed);
  const patternTerms = extractPatternTerms(trimmed);
  if (trimmed.length <= MAX_QUERY_CHARS) {
    return {
      text: trimmed,
      tags,
      structuralFragments,
      ftsMatch,
      patternTerms,
      truncated: false,
    };
  }
  const halfMinus = Math.floor((MAX_QUERY_CHARS - 32) / 2);
  const head = trimmed.slice(0, halfMinus);
  const tail = trimmed.slice(trimmed.length - halfMinus);
  return {
    text: `${head}\n...[truncated]...\n${tail}`,
    tags,
    structuralFragments,
    ftsMatch,
    patternTerms,
    truncated: true,
  };
}

function renderArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  try {
    return JSON.stringify(args, null, 0);
  } catch {
    return String(args);
  }
}

function hintToText(hints: Record<string, unknown> | undefined): string {
  if (!hints) return "";
  const entries = Object.entries(hints).slice(0, 8);
  if (entries.length === 0) return "";
  const lines = entries.map(([k, v]) => `${k}: ${renderHintValue(v)}`);
  return lines.join("\n");
}

function renderHintValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
