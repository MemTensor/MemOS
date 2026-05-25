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
    "",
    "Use this compact checklist before finalizing:",
    "- First model the mathematical object structurally; do not reduce the task to an aggregate count until the construction is proved sufficient.",
    "- For counting/probability, define the sample space, condition on the exact event stated, and check overcount/undercount. For cyclic routes, decide explicitly whether the start point, direction, and rotation are fixed before multiplying.",
    "- For algebra/number theory, verify every candidate solution, boundary case, and divisibility or parity condition before finalizing. For polynomial or functional identities, check low-degree exceptional families after any leading-term argument.",
    "- For geometry, reconstruct only the relations stated in text. If a diagram is absent, do not ask for it; solve from the textual constraints and state the best determined answer.",
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
