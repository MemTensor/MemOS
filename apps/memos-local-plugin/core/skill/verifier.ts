/**
 * V7 §2.5.3 — Consistency + integration verification for a freshly minted
 * skill.
 *
 * Two checks, both deterministic — no LLM calls:
 *
 * 1. **Tool coverage**: every tool name declared in `draft.tools` must
 *    appear in the evidence traces' structured `toolCalls`. Coverage is a
 *    simple set-containment check — `draft.tools ⊆ evidenceTools`. This
 *    catches the most common LLM hallucination: inventing tool/command
 *    names that never appeared in any evidence trace.
 *
 * 2. **Evidence resonance**: at least `minResonance` fraction of the
 *    evidence traces should share ≥ 2 tokens with the skill's summary or
 *    steps. Prevents a skill whose narrative contradicts the examples.
 *
 * The check returns a verdict; the caller (orchestrator) decides whether to
 * promote (active) or hold (candidate) and whether to emit a failure
 * event.
 */

import type { Logger } from "../logger/types.js";
import type { TraceRow } from "../types.js";
import type { SkillCrystallizationDraft } from "./types.js";
import { extractToolNames } from "./tool-names.js";

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

  // --- Tool coverage (structured set comparison) ---
  const evidenceTools = extractToolNames(evidence);
  const draftTools = (draft.tools ?? []).map((t) => t.toLowerCase());
  const matched: string[] = [];
  const unmapped: string[] = [];
  for (const tok of draftTools) {
    if (evidenceTools.has(tok)) matched.push(tok);
    else unmapped.push(tok);
  }
  const coverage =
    draftTools.length === 0 ? 1 : matched.length / draftTools.length;

  // --- Evidence resonance (unchanged) ---
  const resonance = computeResonance(draft, evidence);

  if (coverage < 0.5 && draftTools.length > 0) {
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

// ---------------------------------------------------------------------------
// Resonance
// ---------------------------------------------------------------------------

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
    // Tool sub-steps leave `userText`/`agentText` empty on purpose (the
    // viewer's flattenChat contract — see core/capture/step-extractor.ts),
    // so their real payload lives in `summary` and `toolCalls`. Include
    // those in the resonance text or tool-heavy sessions contribute empty
    // strings and every draft fails with resonance-low. Names + inputs
    // only — outputs are unbounded. Inputs are capped at the same 300-char
    // horizon the embedder uses (core/capture/embedder.ts), so an oversized
    // tool input can neither dominate the token budget nor force spurious
    // matches on the reward-tick path. Names get a tighter 60-char cap for
    // the same reason: a malformed/pathological name is still just a
    // `string` and must not bypass the budget guard.
    const toolTxt = (t.toolCalls ?? [])
      .map(
        (tc) =>
          `${tc.name.slice(0, 60)} ${safeStringify(tc.input).slice(0, 300)}`,
      )
      .join(" ");
    const txt =
      `${t.userText}\n${t.agentText}\n${t.summary ?? ""}\n${t.reflection ?? ""}\n${toolTxt}`.toLowerCase();
    const toks = tokensOf(txt);
    let overlap = 0;
    for (const tok of draftTokens) if (toks.has(tok)) overlap += 1;
    if (overlap >= 2) hit += 1;
  }
  return hit / evidence.length;
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      // A custom .toString() may throw too — degrade to a sentinel rather
      // than let verification blow up on a hostile payload.
      return "[unstringifiable]";
    }
  }
}

function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  const asciiMatches = s.match(/[a-z0-9_][a-z0-9_./-]{3,}/g) ?? [];
  for (const m of asciiMatches) {
    const tok = m.toLowerCase();
    if (RESONANCE_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  const cjkRuns = s.match(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

const RESONANCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "will", "then",
  "into", "when", "what", "where", "your", "user", "agent", "null", "true",
  "false", "none", "let", "new", "old", "use", "used", "have", "has", "its",
  "not", "any", "can", "does", "only", "just", "like", "please", "step",
  "steps", "body", "title", "summary", "task", "tasks", "run", "see", "end",
  "our", "their", "them", "being", "make", "made", "thing", "things",
]);
