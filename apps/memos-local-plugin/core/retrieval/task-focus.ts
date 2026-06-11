/**
 * Retrieval query focus — strip host / eval prompt scaffolding so embed,
 * FTS, and llm_filter target the user's task, not repeated instruction templates.
 */

export type QueryFocusMethod =
  | "passthrough"
  | "question_section"
  | "fallback";

export interface QueryFocusResult {
  text: string;
  method: QueryFocusMethod;
}

const QUESTION_HEADING_RE = /^#{1,3}\s*question\s*$/i;

const IR_EVAL_MARKERS_RE = /\bdeep research agent\b/i;

/**
 * Body after a markdown `## Question` (or `# Question`) heading.
 * Returns null when the heading is missing or the body is empty.
 */
export function extractQuestionSection(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (QUESTION_HEADING_RE.test(lines[i]!.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const bodyLines: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (bodyLines.length > 0 && /^#{1,3}\s+\S/.test(line.trim())) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n").trim();
  return body || null;
}

/** True when the prompt matches the EvoAgentBench IR eval template shape. */
export function isIrEvalPrompt(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (!IR_EVAL_MARKERS_RE.test(text)) return false;
  return text.split("\n").some((line) => QUESTION_HEADING_RE.test(line.trim()));
}

/**
 * When the prompt is an IR eval template, keep only the `## Question` body.
 * Otherwise return the raw text unchanged.
 */
export function focusIrRetrievalQuery(raw: string): QueryFocusResult {
  const text = raw.trim();
  if (!text) return { text: "", method: "passthrough" };
  if (!isIrEvalPrompt(text)) return { text, method: "passthrough" };

  const question = extractQuestionSection(text);
  if (question) return { text: question, method: "question_section" };

  return { text, method: "fallback" };
}
