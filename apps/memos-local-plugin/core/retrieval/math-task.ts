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
    "Finish in this reply with exactly one real final answer in `\\boxed{...}`; never answer with a plan, placeholder, request for more information, hidden-reasoning wrapper, or progress summary.",
    "Use recalled memories only as optional method hints. If no concrete relevant memory is present, do not call `memos_search` just to look around; solve from the original problem statement.",
    "Use a code/execution tool only for mechanical finite checks: exact sums/products, small graph/path/route counts, reachability under deterministic operations, subset/vector-space counts, interpolation, recurrences, or large arithmetic. Prefer Python standard library only, make the script print the needed value, and avoid long exploratory searches.",
    "For finite graph/path/route tasks, verify with exact DFS/DP/enumeration when the state space is clearly small enough. For reachability where intermediate states may exceed the target range, use forward bounded search and repeat with a larger bound to check stabilization.",
    "If a verification script errors, times out, or prints no useful result, do not treat it as verification; fix one obvious print/import/syntax issue at most, otherwise finish by manual derivation.",
    "",
    "Final checklist:",
    "- Model the object structurally before reducing it to a count.",
    "- For counting/probability, define the sample space, condition on the exact event, and check overcount/undercount; for cyclic routes, decide whether start point, direction, and rotation are fixed.",
    "- For finite vector-space or parity subset counts, distinguish ordered tuples from unordered sets, verify the generated element is nonzero and new, and divide only by the exact multiplicity you proved.",
    "- For algebra/number theory, verify candidate solutions, boundary cases, divisibility/parity, and low-degree exceptions after leading-term arguments.",
    "- For geometry, use only stated relations; if no diagram is given, solve from text. In optimization, check whether boundary or degenerate positions are allowed.",
    "- Re-read the original constraints, then give exactly one boxed answer.",
  ].join("\n");
}

export function mergeMathFinalAnswerProtocol(context: string): string {
  if (context.includes(MATH_FINAL_ANSWER_PROTOCOL_TITLE)) return context;
  const protocol = renderMathFinalAnswerProtocol();
  const trimmed = context.trim();
  if (!trimmed) return protocol;
  return `${trimmed}\n\n${protocol}`;
}
