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
import { isIrDomain } from "../domain.js";
import { extractPatternTerms, prepareFtsMatch } from "../storage/keyword.js";
import { focusIrRetrievalQuery } from "./task-focus.js";
import type { RetrievalCtx } from "./types.js";

const MAX_QUERY_CHARS = 1_500;
const MAX_KEYWORD_TOKENS = 5;

const GENERIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "you",
  "your",
]);

/** Public tag list kept in sync with `capture/tagger.ts#KEYWORD_TAGS`. */
const KEYWORD_TAGS: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\bmath(?:ematics)?\b|\bolympiad\b|\bcompetition\b/i, tag: "math" },
  { re: /\breason(?:ing)?\b|\bproblem[-\s]?solving\b|\bderive\b|\bprove\b|\bcompute\b/i, tag: "reasoning" },
  { re: /\bcombinatorics?\b|\bcount(?:ing)?\b|\bprobability\b|\bpermutation\b|\bcombination\b|\bbijection\b/i, tag: "combinatorics" },
  { re: /\bgeometry\b|\btriangle\b|\bcircle\b|\bpolygon\b|\bangle\b|\bmidpoint\b|\bray\b|\bparallel\b/i, tag: "geometry" },
  { re: /\bnumber theory\b|\bmod(?:ulo|ular)?\b|\bprime\b|\bfactor(?:ization)?\b|\bdivisib(?:le|ility)\b|\bcongruence\b/i, tag: "number_theory" },
  { re: /\balgebra\b|\bpolynomial\b|\bequation\b|\bfunctional equation\b|\bsystem of equations\b/i, tag: "algebra" },
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

export interface RetrievalQueryExtract {
  queryVecText: string;
  keywords: string[];
}

export interface QueryBuildOpts {
  domain?: string;
}

/**
 * Build a `CompiledQuery` from a retrieval context. Behavior varies per
 * reason so that e.g. `decision_repair` biases toward the failing tool name.
 */
export function buildQuery(ctx: RetrievalCtx, opts?: QueryBuildOpts): CompiledQuery {
  return finalize(rawQueryText(ctx, opts));
}

export function buildQueryWithExtract(
  ctx: RetrievalCtx,
  extract: RetrievalQueryExtract | null | undefined,
  opts?: QueryBuildOpts,
): CompiledQuery {
  return finalize(rawQueryText(ctx, opts), extract);
}

function applyIrQueryFocus(raw: string, domain?: string): string {
  if (!isIrDomain(domain)) return raw;
  return focusIrRetrievalQuery(raw).text;
}

export function rawQueryText(ctx: RetrievalCtx, opts?: QueryBuildOpts): string {
  switch (ctx.reason) {
    case "turn_start": {
      const hintText = hintToText(ctx.contextHints);
      const parts = [applyIrQueryFocus(ctx.userText?.trim() ?? "", opts?.domain)];
      if (hintText) parts.push(hintText);
      return parts.join("\n");
    }
    case "tool_driven": {
      if (typeof ctx.args?.query === "string" && ctx.args.query.trim()) {
        const rest = { ...ctx.args };
        delete rest.query;
        const restText = Object.keys(rest).length > 0 ? renderArgs(rest) : "";
        return [applyIrQueryFocus(ctx.args.query.trim(), opts?.domain), restText]
          .filter(Boolean)
          .join("\n");
      }
      const args = renderArgs(ctx.args);
      return `tool:${ctx.tool}\n${args}`;
    }
    case "skill_invoke": {
      const head = ctx.skillId ? `skill:${ctx.skillId}\n` : "";
      return head + (ctx.query ?? "");
    }
    case "sub_agent": {
      const profile = ctx.profile ? `profile:${ctx.profile}\n` : "";
      return profile + (ctx.mission ?? "");
    }
    case "decision_repair": {
      const head = `failing_tool:${ctx.failingTool}\nfailures:${ctx.failureCount}\n`;
      const tail = ctx.lastErrorCode ? `error:${ctx.lastErrorCode}` : "";
      return head + tail;
    }
    default: {
      // Exhaustiveness — compile-time check.
      const _exhaustive: never = ctx;
      void _exhaustive;
      return "";
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

function finalize(raw: string, llmExtract?: RetrievalQueryExtract | null): CompiledQuery {
  const extracted = normalizeRetrievalExtract(raw ?? "", llmExtract);
  const trimmed = extracted.queryText;
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
  const keywordText = extracted.keywords.join(" ");
  const ftsMatch = prepareFtsMatch(keywordText) ?? prepareFtsMatch(trimmed);
  const keywordPatternTerms = extractPatternTerms(keywordText);
  const patternTerms =
    keywordPatternTerms.length > 0 ? keywordPatternTerms : extractPatternTerms(trimmed);
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

function normalizeRetrievalExtract(
  raw: string,
  llmExtract?: RetrievalQueryExtract | null,
): { queryText: string; keywords: string[] } {
  const fallback = fallbackRetrievalExtract(raw);
  const fallbackNormalized = {
    queryText: fallback.queryVecText,
    keywords: fallback.keywords,
  };
  if (!llmExtract) return fallbackNormalized;
  const candidateQueryText = String(llmExtract.queryVecText ?? "").trim();
  const queryText = isUsableQueryVecText(candidateQueryText)
    ? candidateQueryText
    : fallback.queryVecText;
  const keywords = sanitizeKeywordList(llmExtract.keywords);
  return {
    queryText,
    keywords: keywords.length > 0 ? keywords : fallbackNormalized.keywords,
  };
}

function isUsableQueryVecText(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;
  const alnumRuns = trimmed.match(/[\p{L}\p{N}]+/gu) ?? [];
  const longestRun = Math.max(0, ...alnumRuns.map((run) => run.length));
  return longestRun >= 2;
}

export function fallbackRetrievalExtract(raw: string): RetrievalQueryExtract {
  const queryText = String(raw ?? "").trim();
  return {
    queryVecText: queryText,
    keywords: extractKeywordTokens(queryText),
  };
}

function sanitizeKeywordList(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of keywords) {
    const keyword = String(item ?? "").trim();
    if (!keyword) continue;
    const normalized = keyword.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(keyword);
    if (out.length >= MAX_KEYWORD_TOKENS) break;
  }
  return out;
}

function extractKeywordTokens(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (GENERIC_STOP_WORDS.has(normalized)) continue;
    if (token.length < 2 && !/\d/.test(token)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(token);
    if (out.length >= MAX_KEYWORD_TOKENS) break;
  }
  return out;
}

export function isSoftwareRepairPrompt(text: string | undefined): boolean {
  const raw = String(text ?? "");
  return /##\s*Bug Description\b/i.test(raw) && /You need to fix a bug in\b/i.test(raw);
}

export function extractRepairTaskSection(text: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `(?:^|\\n)\\s*##\\s*${escapedHeading}\\b\\s*([\\s\\S]*?)(?=\\n\\s*(?:##\\s+|STRICT RULES:|Reply TASK_COMPLETE\\b)|$)`,
      "i",
    ),
  );
  return (match?.[1] ?? "").trim();
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
