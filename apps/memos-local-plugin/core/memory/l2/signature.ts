/**
 * Signature derivation for L2 candidate pool bucketing.
 *
 * Two traces from different tasks share a signature when they *look like*
 * instances of the same sub-problem — same primary domain tag, same tool,
 * same error code. This is the cheap pre-filter before any cosine
 * comparison (`similarity.ts`).
 *
 * Signature format: `<primaryTag>|<secondaryTag>|<tool>|<errCode>` with
 * underscores filling in missing components. See `types.ts`.
 */

import type { ToolCallDTO } from "../../../agent-contract/dto.js";
import type { TraceRow } from "../../types.js";
import type { PatternSignature, SignatureComponents } from "./types.js";

const MISSING = "_";

export function signatureOf(trace: TraceRow): PatternSignature {
  return componentsToSignature(componentsOf(trace));
}

export function componentsToSignature(c: SignatureComponents): PatternSignature {
  return `${c.primaryTag}|${c.secondaryTag}|${c.tool}|${c.errCode}`;
}

export function componentsOf(trace: TraceRow): SignatureComponents {
  const tags = normaliseTags(trace.tags);
  const tool = firstTool(trace.toolCalls);
  const errCode = firstErrCode(trace);
  return {
    primaryTag: tags[0] ?? MISSING,
    secondaryTag: tags[1] ?? MISSING,
    tool,
    errCode,
  };
}

/** Utility — a parser so downstream logs can show the four parts. */
export function parseSignature(sig: PatternSignature): SignatureComponents | null {
  const parts = sig.split("|");
  if (parts.length !== 4) return null;
  return {
    primaryTag: parts[0] || MISSING,
    secondaryTag: parts[1] || MISSING,
    tool: parts[2] || MISSING,
    errCode: parts[3] || MISSING,
  };
}

/**
 * A looser "bucket key" used when promoting candidates — when
 * primaryTag + errCode match we accept joint induction even if the second
 * tag or tool differ. This is V7 §2.4.5 "different tasks, same sub-problem":
 * e.g. Alpine+lxml and Debian+psycopg2 share `pip|MODULE_NOT_FOUND`.
 */
export function bucketKeyOf(trace: TraceRow): PatternSignature {
  const c = componentsOf(trace);
  return `${c.primaryTag}|${MISSING}|${MISSING}|${c.errCode}`;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normaliseTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  return tags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 32);
}

function firstTool(calls: readonly ToolCallDTO[] | undefined): string {
  if (!calls || calls.length === 0) return MISSING;
  const name = calls[0].name?.trim().toLowerCase();
  if (!name) return MISSING;
  return name.length <= 64 ? name : name.slice(0, 64);
}

function firstErrCode(trace: TraceRow): string {
  for (const call of trace.toolCalls ?? []) {
    const out = typeof call.output === "string" ? call.output : undefined;
    if (!out) continue;
    const m = out.match(/\b([A-Z][A-Z0-9_]{2,}_[A-Z0-9_]+)\b/);
    if (m) return m[1].slice(0, 48);
    if (/exit\s*(?:code)?\s*[:=]?\s*([1-9]\d*)/i.test(out)) {
      const n = RegExp.$1;
      return `EXIT_${n}`;
    }
  }
  const refl = trace.reflection ?? "";
  const m2 = refl.match(/\b([A-Z][A-Z0-9_]{2,}_[A-Z0-9_]+)\b/);
  if (m2) return m2[1].slice(0, 48);
  return MISSING;
}
