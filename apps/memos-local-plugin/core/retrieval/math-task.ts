export const STANDALONE_MATH_FINAL_ANSWER_TASK_KIND = "standalone_math_final_answer";
export const MATH_FINAL_ANSWER_PROTOCOL_TITLE = "## Standalone math task guardrails";

export function isStandaloneMathFinalAnswerTask(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  if (isCodeGenerationTask(normalized)) return false;

  const mathSignals = [
    /\\boxed|\\frac|\\sqrt|\\sum|\\prod|\\binom/,
    /\bmath(?:ematics)?\b|\bolympiad\b|\bmath competition\b/,
    /\bcombinatorics?\b|\bprobability\b|\bpermutation\b|\bcombination\b|\bcount(?:ing)?\b|\bhow many ways\b/,
    /\bnumber theory\b|\bmod(?:ulo|ular)?\b|\bprime\b|\bdivisib(?:le|ility)\b|\bcongruence\b/,
    /\balgebra\b|\bpolynomials?\b|\bequations?\b|\bfunctional equation\b/,
    /\bgeometry\b|\btriangle\b|\bcircle\b|\bpolygon\b|\bangle\b|\bmidpoint\b|\bparallel\b/,
    /\bintegers?\b|\breal numbers?\b|\bpositive numbers?\b/,
  ].filter((re) => re.test(normalized)).length;
  const hasFinalAnswerInstruction = /\\boxed|\bboxed\s*\{|\bfinal answer\b|\banswer in\b/.test(normalized);
  if (/\bsolve the following math competition problem\b/.test(normalized) && hasFinalAnswerInstruction) {
    return true;
  }
  if (mathSignals < 2) return false;
  if (!hasFinalAnswerInstruction) return false;
  return /\b(compute|find|determine|evaluate|solve|prove|what is)\b|\\boxed|\bboxed\s*\{/.test(normalized);
}

function isCodeGenerationTask(normalized: string): boolean {
  const programmingShellSignals = [
    /\bexpert\s+(?:python|java|c\+\+|typescript|javascript|rust)\s+programmer\b/,
    /\bgenerate\s+a\s+correct\s+[\s\S]{0,80}\bprogram\b/,
    /\bwrite\s+(?:a|the)?\s*[\s\S]{0,80}\bprogram\b/,
    /\bpasses?\s+all\s+tests?\b/,
    /\b(?:stdin|stdout|standard input|standard output)\b/,
    /###\s*(?:question|input|output|constraints)\b/,
    /\btime limit\b[\s\S]{0,120}\bmemory limit\b/,
  ].filter((re) => re.test(normalized)).length;
  if (programmingShellSignals >= 2) return true;

  const explicitCodeContract = [
    /\b(?:write|generate|implement|provide|submit|output|return)\b[\s\S]{0,120}\b(?:code|program|python|javascript|typescript|java|c\+\+|function|method|class)\b/,
    /\b(?:correct|working)\s+(?:python\s+)?program\b/,
    /\b(?:solve|run)\s+the\s+problem\b[\s\S]{0,120}\b(?:stdin|stdout|standard input|standard output)\b/,
    /\bread\s+the\s+inputs?\s+from\s+stdin\b[\s\S]{0,120}\bwrite\b[\s\S]{0,80}\bstdout\b/,
    /\b(?:input is given|the input is given)\s+from\s+standard input\b[\s\S]{0,200}\b(?:output|print)\b/,
  ];
  if (explicitCodeContract.some((re) => re.test(normalized))) return true;

  const structuralSignals = [
    /```[a-z0-9#+-]*\s*\n/,
    /\b(?:stdin|stdout|standard input|standard output)\b/,
    /\b(?:sample input|sample output|input format|output format)\b/,
    /\b(?:starter code|provided format|enclose your code)\b/,
    /\bclass\s+\w+\s*:/,
    /\bdef\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:\n]+)?\s*:/,
    /\bfrom typing import\b|\bimport sys\b/,
  ].filter((re) => re.test(normalized)).length;
  const hasProgrammingSurface =
    /\b(?:code|program|python|javascript|typescript|java|c\+\+|function|method|class|stdin|stdout|standard input|standard output)\b/.test(
      normalized,
    );
  return hasProgrammingSurface && structuralSignals >= 2;
}

export function renderMathFinalAnswerProtocol(text?: string): string {
  void text;
  const lines = [
    MATH_FINAL_ANSWER_PROTOCOL_TITLE,
    "",
    "This is a standalone math task. Finish the solution in this reply; never answer with a plan, next step, placeholder, or request for more information.",
    "Use recalled memories only if they contain concrete relevant facts. If no specific memory is present, do not call `memos_search` just to look around; solve directly from the original problem statement. MemOS tools remain available when you have a concrete reason to retrieve prior experience.",
    "Final-answer contract: output exactly one real final answer in `\\boxed{...}`. Do not output a literal placeholder such as `\\boxed{...}`. Do not stop after a progress summary or a sentence about what you will do next.",
    "Do not emit `<think>` tags, hidden-reasoning wrappers, section-by-section progress summaries, or meta commentary. Write the concise solution steps needed to justify the answer, then end with the boxed answer.",
    "If uncertain, still compute to the best supported final answer instead of asking for more information or deferring the calculation.",
    "If the host environment offers a code/execution tool and the task is a finite exact computation, run at most one short exact script or symbolic calculation before finalizing. This applies especially to explicit finite sums/products, small graph or route counts, reachability under deterministic operations, subset/vector-space counts, interpolation, recurrences, and large arithmetic. Do not use tools for broad browsing; use them only to compute or check the current problem.",
    "The script must use only local computation, print the needed value, and be small enough to finish immediately. Do not launch broad brute-force searches over large state spaces.",
    "If a script errors, times out, reports that it is still running, or prints no useful result, do not treat it as verification. Poll at most once, then kill or abandon it and finish by a checked manual derivation; do not start a second exploratory script.",
    "For finite graph/path/route tasks, do not rely only on symmetry or invariants; first verify with exact DFS/DP/enumeration when the state space is small enough, then explain the resulting count.",
    "For finite-step random walks, Markov chains, or repeated stochastic processes, never replace the requested n-step probability with the stationary or limiting distribution unless the problem explicitly asks for a limit. Compute the finite recurrence, matrix power, or eigenvalue expression and keep small correction terms. Simplify recurrences into a closed form with powers/factorials/binomials when possible; do not box an enormous unsimplified rational if a compact exact form is available.",
    "For reachability problems where intermediate states may exceed the target range, prefer a forward bounded search and repeat with a larger bound only if both runs finish immediately; do not conclude all states are reachable from a reverse move that is only a preimage generator.",
    "For explicit finite sums, products, or polynomial interpolation, compute the exact rational/symbolic value with a small script first, then give the algebraic justification.",
    "",
    "Use this compact checklist before finalizing:",
    "- First model the mathematical object structurally; do not reduce the task to an aggregate count until the construction is proved sufficient.",
    "- For counting/probability, define the sample space, condition on the exact event stated, and check overcount/undercount. For cyclic routes, decide explicitly whether the start point, direction, and rotation are fixed before multiplying. For any upper bound, verify an explicit construction or recurrence actually attains it under all adjacency/order constraints.",
    "- If the prompt asks for a transformed value, such as a rounded decimal, m+n, 100m+n, or a simplified fraction, compute that requested final value after deriving intermediate quantities; box the requested value, not an intermediate numerator, denominator, probability, or expectation.",
    "- For finite vector-space or parity subset counts, distinguish ordered tuples from unordered sets, verify the generated element is nonzero and new, and divide only by the exact multiplicity you proved.",
    "- For algebra/number theory, verify every candidate solution, boundary case, and divisibility or parity condition before finalizing. For polynomial or functional identities, check low-degree exceptional families after any leading-term argument.",
    "- For geometry, reconstruct only the relations stated in text. If a diagram is absent, do not ask for it; solve from the textual constraints and state the best determined answer. In optimization problems, check whether boundary or degenerate positions are allowed before using them as minima.",
    "- Before writing the final answer, re-read the original problem constraints once, then give exactly one boxed answer.",
  ];
  return lines.join("\n");
}

export function mergeMathFinalAnswerProtocol(context: string, text?: string): string {
  if (context.includes(MATH_FINAL_ANSWER_PROTOCOL_TITLE)) return context;
  const protocol = renderMathFinalAnswerProtocol(text);
  const trimmed = context.trim();
  if (!trimmed) return protocol;
  return `${trimmed}\n\n${protocol}`;
}
