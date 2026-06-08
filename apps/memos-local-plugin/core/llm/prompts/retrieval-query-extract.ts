import type { PromptDef } from "./index.js";

export const RETRIEVAL_QUERY_EXTRACT_PROMPT: PromptDef = {
  id: "retrieval.query.extract",
  version: 1,
  description:
    "Extract a compact semantic query and up to five keyword terms for memory retrieval.",
  system: `You prepare memory retrieval input for an AI agent.

Given the complete current user input, return JSON with:
- queryVecText: a compact semantic query for embedding search and later relevance filtering.
- keywords: up to 5 short keyword strings for lexical FTS / pattern search.

Rules:
1. Use the complete input as evidence. Do not assume a fixed prompt template.
2. Remove wrapper/protocol noise only when it is clearly not part of the user's real task.
3. Preserve task-specific nouns, entities, technologies, filenames, error names, and requested deliverables when they are useful for retrieval.
4. keywords must contain at most 5 items, ordered by retrieval usefulness.
5. Do not invent keywords not grounded in the input.
6. Keep queryVecText concise but specific; do not summarize away the user's actual goal.

Return JSON only:
{
  "queryVecText": "semantic retrieval query",
  "keywords": ["term1", "term2", "term3"]
}`,
};
