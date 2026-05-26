export const STANDALONE_MATH_FINAL_ANSWER_TASK_KIND = "standalone_math_final_answer";
export const MATH_FINAL_ANSWER_PROTOCOL_TITLE = "## Standalone math task guardrails";

export function isStandaloneMathFinalAnswerTask(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const mathSignals = [
    /\\boxed|\\frac|\\sqrt|\\sum|\\prod|\\binom/,
    /\bmath(?:ematics)?\b|\bolympiad\b|\bcompetition\b/,
    /\bcombinatorics?\b|\bprobability\b|\bpermutation\b|\bcombination\b|\bcount(?:ing)?\b|\bhow many ways\b/,
    /\bnumber theory\b|\bmod(?:ulo|ular)?\b|\bprime\b|\bdivisib(?:le|ility)\b|\bcongruence\b/,
    /\balgebra\b|\bpolynomials?\b|\bequations?\b|\bfunctional equation\b/,
    /\bgeometry\b|\btriangle\b|\bcircle\b|\bpolygon\b|\bangle\b|\bmidpoint\b|\bparallel\b/,
    /\bintegers?\b|\breal numbers?\b|\bpositive numbers?\b/,
  ].filter((re) => re.test(normalized)).length;
  if (mathSignals < 2) return false;
  return /\b(final answer|answer in|compute|find|determine|evaluate|solve|prove|what is)\b|\\boxed/.test(normalized);
}

export function renderMathFinalAnswerProtocol(): string {
  return [
    MATH_FINAL_ANSWER_PROTOCOL_TITLE,
    "",
    "This is a standalone math task. Finish the solution in this reply; never answer with a plan, next step, placeholder, or request for more information.",
    "Use recalled memories only if they contain concrete relevant facts. If no specific memory is present, do not call `memos_search` just to look around; solve directly from the original problem statement. MemOS tools remain available when you have a concrete reason to retrieve prior experience.",
    "Final-answer contract: output exactly one real final answer in `\\boxed{...}`. Do not output a literal placeholder such as `\\boxed{...}`. Do not stop after a progress summary or a sentence about what you will do next.",
    "Do not emit `<think>` tags, hidden-reasoning wrappers, section-by-section progress summaries, or meta commentary. Write the concise solution steps needed to justify the answer, then end with the boxed answer.",
    "If uncertain, still compute to the best supported final answer instead of asking for more information or deferring the calculation.",
    "If the host environment offers a code/execution tool and the task is a finite exact computation, run one short exact script or symbolic calculation before finalizing. This applies especially to explicit finite sums/products, small graph or route counts, reachability under deterministic operations, subset/vector-space counts, interpolation, recurrences, and large arithmetic. Do not use tools for broad browsing; use them only to compute or check the current problem.",
    "For finite graph/path/route tasks, do not rely only on symmetry or invariants; first verify with exact DFS/DP/enumeration when the state space is small enough, then explain the resulting count.",
    "For reachability problems where intermediate states may exceed the target range, prefer a forward bounded search and repeat with a larger bound to check that the count inside the target range has stabilized; do not conclude all states are reachable from a reverse move that is only a preimage generator.",
    "For explicit finite sums, products, or polynomial interpolation, compute the exact rational/symbolic value with a small script first, then give the algebraic justification.",
    "If a verification script errors, times out, or prints no useful result, do not treat it as verification; fix the script or proceed with a clearly checked manual derivation.",
    "",
    "Use this compact checklist before finalizing:",
    "- First model the mathematical object structurally; do not reduce the task to an aggregate count until the construction is proved sufficient.",
    "- For counting/probability, define the sample space, condition on the exact event stated, and check overcount/undercount. For cyclic routes, decide explicitly whether the start point, direction, and rotation are fixed before multiplying.",
    "- For finite vector-space or parity subset counts, distinguish ordered tuples from unordered sets, verify the generated element is nonzero and new, and divide only by the exact multiplicity you proved.",
    "- For algebra/number theory, verify every candidate solution, boundary case, and divisibility or parity condition before finalizing. For polynomial or functional identities, check low-degree exceptional families after any leading-term argument.",
    "- For geometry, reconstruct only the relations stated in text. If a diagram is absent, do not ask for it; solve from the textual constraints and state the best determined answer. In optimization problems, check whether boundary or degenerate positions are allowed before using them as minima.",
    "- Before writing the final answer, re-read the original problem constraints once, then give exactly one boxed answer.",
  ].join("\n");
}

export function mergeMathFinalAnswerProtocol(context: string): string {
  if (context.includes(MATH_FINAL_ANSWER_PROTOCOL_TITLE)) return context;
  const protocol = renderMathFinalAnswerProtocol();
  const trimmed = context.trim();
  if (!trimmed) return protocol;
  return `${trimmed}\n\n${protocol}`;
}
