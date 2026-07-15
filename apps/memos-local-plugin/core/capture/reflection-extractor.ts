/**
 * `reflection-extractor` — try to lift a self-reflection out of the
 * assistant text for free (no LLM required).
 *
 * The V7 spec defines a reflection as "the agent's own explanation of
 * why it made this decision". Hosts sometimes emit this inline:
 *   - An OpenClaw assistant block containing `### Reasoning:` or
 *     `I chose this because …`.
 *   - A Hermes `<reflection>…</reflection>` tag (legacy).
 *   - A Chinese-language agent producing "我这样做是因为…" or "思考过程：".
 *
 * We recognise a handful of high-precision patterns and return the cleaned
 * snippet. Never throws, never invokes an LLM.
 *
 * If the step already has `rawReflection` set (from adapter-provided meta),
 * that wins unchanged.
 */

import type { NormalizedStep } from "./types.js";

const INLINE_PATTERNS: RegExp[] = [
  // Markdown heading-style reasoning blocks.
  /^###?\s*(reasoning|rationale|why|思考(?:过程|过程如下)?|我的理由)[:：]?\s*\n([\s\S]+?)(?=\n(?:###?\s|$))/im,

  // "<reflection>...</reflection>" legacy tags.
  /<reflection>\s*([\s\S]+?)\s*<\/reflection>/i,

  // English inline phrase "Reflection: ..." / "Reasoning: ..."
  /\b(reflection|reasoning|rationale)\s*[:：]\s*([\s\S]{20,})/i,

  // Chinese phrases.
  /(我(?:这么|这样)做的?(?:原因|理由)[是:：]?)\s*([\s\S]{10,})/m,
  /(思考(?:过程|过程如下))\s*[:：]?\s*([\s\S]{10,})/m,
];

/**
 * Extract a reflection from the step. Prefers the adapter-provided value;
 * falls back to parsing `agentText`. Returns `null` when no signal found.
 */
export function extractReflection(step: NormalizedStep): string | null {
  if (step.rawReflection && step.rawReflection.trim().length > 0) {
    return step.rawReflection.trim();
  }
  const text = step.agentText ?? "";
  if (text.length === 0) return null;

  for (const pat of INLINE_PATTERNS) {
    const m = pat.exec(text);
    if (m) {
      // The actual body is the last capturing group.
      const body = (m[m.length - 1] ?? "").trim();
      if (body.length >= 10) {
        // Cap so a misbehaving pattern can't swallow the whole message.
        return body.slice(0, 1_500);
      }
    }
  }
  return null;
}
