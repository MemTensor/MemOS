/**
 * V7 §2.5.3 — Consistency + integration verification for a freshly minted
 * skill.
 *
 * Two checks, both heuristic and deterministic — no LLM calls. The goal is
 * to catch obvious drafts that should never surface in Tier-1 retrieval
 * (e.g. the LLM invented a tool name not present in any evidence, or the
 * steps don't cover the originating sub-problem).
 *
 * 1. **Consistency coverage**: every non-empty step title / body token that
 *    looks like a tool / command identifier (`rg`, `git_diff`, `docker.ps`)
 *    must appear in at least one evidence trace's action text.
 * 2. **Evidence resonance**: at least `minResonance` fraction of the
 *    evidence traces should share ≥ one token with the skill's summary or
 *    steps. Prevents a skill whose narrative contradicts the examples.
 *
 * The check returns a verdict; the caller (orchestrator) decides whether to
 * promote (active) or hold (candidate) and whether to emit a failure
 * event.
 */

import type { Logger } from "../logger/types.js";
import type { TraceRow } from "../types.js";
import type { SkillCrystallizationDraft } from "./types.js";

export interface VerifyInput {
  draft: SkillCrystallizationDraft;
  evidence: TraceRow[];
}

export interface VerifyDeps {
  log: Logger;
  /** Fraction of evidence that must resonate with the draft; default 0.5. */
  minResonance?: number;
}

export interface VerifyResult {
  ok: boolean;
  coverage: number;
  resonance: number;
  unmappedTokens: string[];
  reason?: string;
}

export function verifyDraft(
  input: VerifyInput,
  deps: VerifyDeps,
): VerifyResult {
  const { draft, evidence } = input;
  const minResonance = deps.minResonance ?? 0.5;

  if (evidence.length === 0) {
    return {
      ok: false,
      coverage: 0,
      resonance: 0,
      unmappedTokens: [],
      reason: "no-evidence",
    };
  }

  const actionBlob = evidence
    .flatMap((t) => [t.agentText, t.userText, t.reflection ?? ""])
    .join("\n")
    .toLowerCase();

  const commandLike = collectCommandTokens(draft);
  const matched: string[] = [];
  const unmapped: string[] = [];
  for (const tok of commandLike) {
    if (actionBlob.includes(tok)) matched.push(tok);
    else unmapped.push(tok);
  }
  const coverage = commandLike.length === 0 ? 1 : matched.length / commandLike.length;

  const resonance = computeResonance(draft, evidence);

  if (coverage < 0.5 && commandLike.length > 0) {
    deps.log.warn("skill.verify.fail", { reason: "coverage-low", coverage });
    return {
      ok: false,
      coverage,
      resonance,
      unmappedTokens: unmapped,
      reason: `coverage=${coverage.toFixed(2)}<0.5`,
    };
  }
  if (resonance < minResonance) {
    deps.log.warn("skill.verify.fail", { reason: "resonance-low", resonance });
    return {
      ok: false,
      coverage,
      resonance,
      unmappedTokens: unmapped,
      reason: `resonance=${resonance.toFixed(2)}<${minResonance}`,
    };
  }

  deps.log.debug("skill.verify.ok", { coverage, resonance });
  return { ok: true, coverage, resonance, unmappedTokens: unmapped };
}

function collectCommandTokens(draft: SkillCrystallizationDraft): string[] {
  const fields = [
    ...draft.steps.flatMap((s) => [s.title, s.body]),
    ...draft.examples.flatMap((e) => [e.input, e.expected]),
  ].join(" ");
  const matches = fields.match(/`([^`]+)`|([a-z][a-z0-9_]{1,}\.[a-z][a-z0-9_]+|[a-z_]{3,}\b)/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const tok = raw.replace(/`/g, "").toLowerCase().trim();
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function computeResonance(
  draft: SkillCrystallizationDraft,
  evidence: TraceRow[],
): number {
  const needle = [
    draft.summary,
    ...draft.steps.flatMap((s) => [s.title, s.body]),
  ]
    .join(" ")
    .toLowerCase();
  const draftTokens = tokensOf(needle);
  if (draftTokens.size === 0) return 0;
  let hit = 0;
  for (const t of evidence) {
    const txt = `${t.userText}\n${t.agentText}\n${t.reflection ?? ""}`.toLowerCase();
    const toks = tokensOf(txt);
    let overlap = 0;
    for (const tok of draftTokens) if (toks.has(tok)) overlap += 1;
    if (overlap >= 2) hit += 1;
  }
  return hit / evidence.length;
}

function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  // ASCII identifier-ish tokens (length ≥ 4 incl. leading char).
  const asciiMatches = s.match(/[a-z0-9_][a-z0-9_./-]{3,}/g) ?? [];
  for (const m of asciiMatches) {
    const tok = m.toLowerCase();
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  // CJK support: Chinese / Japanese / Korean text isn't whitespace-separated,
  // so the ASCII-only tokenizer above produces an empty set on Chinese
  // evidence and the resonance check rejects every skill (the famous
  // "resonance=0.00<0.5" failure). Add character bigrams from any CJK runs
  // to give the verifier a reasonable signal in non-Latin contexts.
  const cjkRuns = s.match(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "will", "then",
  "into", "when", "what", "where", "your", "user", "agent", "null", "true",
  "false", "none", "let", "new", "old", "use", "used", "have", "has", "its",
  "not", "any", "can", "does", "only", "just", "like", "please", "step",
  "steps", "body", "title", "summary", "task", "tasks", "run", "see", "end",
  "our", "their", "them", "being", "make", "made", "thing", "things",
]);
