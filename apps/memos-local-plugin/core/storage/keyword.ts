/**
 * `keyword.ts` — shared helpers for the FTS5 + pattern keyword channels.
 *
 * Two utilities live here:
 *
 *   1. `prepareFtsMatch(query)` — sanitise a free-form user query for an
 *      FTS5 MATCH clause. We split on whitespace, apply the configured
 *      keyword token mode, escape internal quotes and AND the resulting
 *      phrases.
 *
 *   2. `extractPatternTerms(query)` — return short tokens (length 2)
 *      and CJK bigrams (sliding 2-char windows over CJK runs). These
 *      cover the queries that fall below the trigram tokenizer's 3-char
 *      window — most importantly 2-char Chinese names and verbs which
 *      are extremely common in zh-CN agent traffic.
 *
 * Both helpers are pure — no SQL prepared here so the repos can choose
 * the right column list / table for the FTS join.
 */

const PUNCT = /["“”'’(){}\[\]<>«»《》【】（）\\^~!@#$%&*+/=:;,.，。、；：!?？]+/g;
const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]+/g;
const TRIGRAM_MIN = 3;
const PATTERN_MIN = 2;
const MAX_FTS_TOKENS = 12;
const MAX_PATTERN_TERMS = 16;

export type FtsTokenizerMode = "trigram" | "cjk";

export interface PrepareFtsMatchOptions {
  tokenizer?: FtsTokenizerMode;
}

/**
 * Sanitised FTS5 MATCH expression.
 *
 * Returns `null` when no usable token is left (caller should skip the
 * FTS channel rather than issue an empty MATCH).
 */
export function prepareFtsMatch(
  query: string,
  opts: PrepareFtsMatchOptions = {},
): string | null {
  if (!query) return null;
  const cleaned = String(query).replace(PUNCT, " ").trim();
  if (!cleaned) return null;
  const tokenizer = opts.tokenizer ?? "trigram";

  // Split on whitespace AND on CJK boundaries: a CJK run becomes its
  // own token so we don't end up with 50-character "phrases".
  const rough = cleaned.split(/\s+/).filter(Boolean);
  const expanded: string[] = [];
  for (const tok of rough) {
    if (tokenizer === "cjk") {
      expanded.push(...expandCjkToken(tok));
      continue;
    }

    // If the token has both ASCII and CJK, split out CJK runs as their
    // own tokens; trigram handles each well.
    const cjkRuns = tok.match(CJK_RUN) ?? [];
    let stripped = tok;
    for (const r of cjkRuns) {
      stripped = stripped.replace(r, " ");
      if (r.length >= TRIGRAM_MIN) expanded.push(r);
    }
    for (const sub of stripped.split(/\s+/).filter(Boolean)) {
      if (sub.length >= TRIGRAM_MIN) expanded.push(sub);
    }
  }
  if (expanded.length === 0) return null;

  const limited = Array.from(new Set(expanded)).slice(0, MAX_FTS_TOKENS);
  // Each token wrapped in FTS5 phrase quotes so internal punctuation /
  // CJK can't break parsing. Multiple phrases joined by space → AND.
  const safe = limited.map((t) => `"${t.replace(/"/g, '""')}"`);
  return safe.join(" ");
}

function expandCjkToken(token: string): string[] {
  const out: string[] = [];
  const cjkRuns = token.match(CJK_RUN) ?? [];
  let stripped = token;
  for (const run of cjkRuns) {
    stripped = stripped.replace(run, " ");
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i <= run.length - PATTERN_MIN; i++) {
      out.push(run.slice(i, i + PATTERN_MIN));
    }
  }

  for (const sub of stripped.split(/\s+/).filter(Boolean)) {
    if (sub.length >= PATTERN_MIN) out.push(sub);
  }

  const hasNonCjk = /[^\u4e00-\u9fff]/.test(token);
  const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/.test(token);
  if (token.length >= PATTERN_MIN && hasNonCjk && hasCjk) {
    out.push(token);
  }

  return out;
}

/**
 * Pattern-channel terms — what the trigram FTS can't catch on its own.
 *
 * Returns:
 *   - 2-char ASCII tokens from the query (FTS trigram requires ≥3).
 *   - CJK bigrams sliding over each CJK run of length ≥2.
 *
 * Empty array is a perfectly valid result — caller skips the pattern
 * channel.
 */
export function extractPatternTerms(query: string): string[] {
  if (!query) return [];
  const cleaned = String(query).replace(PUNCT, " ");
  const out = new Set<string>();

  // Short ASCII tokens (length === 2). Length 1 is too noisy.
  for (const tok of cleaned.split(/\s+/).filter(Boolean)) {
    if (tok.length === PATTERN_MIN && /[^\u4e00-\u9fff]/.test(tok)) {
      out.add(tok.toLowerCase());
    }
  }

  // CJK bigrams.
  const runs = cleaned.match(CJK_RUN) ?? [];
  for (const run of runs) {
    if (run.length < PATTERN_MIN) continue;
    if (run.length === PATTERN_MIN) {
      out.add(run);
      continue;
    }
    for (let i = 0; i <= run.length - PATTERN_MIN; i++) {
      out.add(run.slice(i, i + PATTERN_MIN));
    }
  }

  return Array.from(out).slice(0, MAX_PATTERN_TERMS);
}

/**
 * Reciprocal-rank scoring helper used by FTS / pattern hits.
 *
 * FTS5 returns rows in `rank` order (lower = better) and we want to
 * fuse with vector cosine via the ranker's RRF pass; using
 * `1 / (k + rank + 1)` here keeps the contribution shape identical to
 * the cosine-derived RRF and avoids needing to invent a synthetic
 * cosine for keyword hits.
 */
export function reciprocalRankScore(rank0: number, k = 60): number {
  return 1 / (k + rank0 + 1);
}
