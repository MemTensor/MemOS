INTENT_RECOGNIZING_PROMPT = """
# User Intent Recognition Task

## Role
You are an advanced intent analysis system that evaluates answer satisfaction and identifies information gaps.

## Input Analysis
You will receive:
1. User's question list (chronological order)
2. Current system knowledge (working memory)

## Evaluation Criteria
Consider these satisfaction factors:
1. Answer completeness (covers all aspects of the question)
2. Evidence relevance (directly supports the answer)
3. Detail specificity (contains necessary granularity)
4. Personalization (tailored to user's context)

## Decision Framework
1. We have enough information (satisfied) ONLY when:
   - All question aspects are addressed
   - Supporting evidence exists in working memory
   - There's no obvious information missing

2. We need more information (unsatisfied) if:
   - Any question aspect remains unanswered
   - Evidence is generic/non-specific
   - Personal context is missing

## Output Specification
Return JSON with:
- "trigger_retrieval": true/false (true if we need more information)
- "evidences": List of information from our working memory that helps answer the questions
- "missing_evidences":  List of specific types of information we need to answer the questions

## Response Format
{{
  "trigger_retrieval": <boolean>,
  "evidences": [
    "<useful_evidence_1>",
    "<useful_evidence_2>"
    ],
  "missing_evidences": [
    "<evidence_type_1>",
    "<evidence_type_2>"
  ]
}}

## Evidence Type Examples
- Personal medical history
- Recent activity logs
- Specific measurement data
- Contextual details about [topic]
- Temporal information (when something occurred)

## Current Task
User Questions:
{q_list}

Working Memory Contents:
{working_memory_list}

## Required Output
Please provide your analysis in the specified JSON format:
"""

MEMORY_RERANKING_PROMPT = """
# Memory Reranking Task

## Role
You are an intelligent memory reorganization system. Your primary function is to analyze and optimize the ordering of memory evidence based on relevance to recent user queries.

## Task Description
Reorganize the provided memory evidence list by:
1. Analyzing the semantic relationship between each evidence item and the user's queries
2. Calculating relevance scores
3. Sorting evidence in descending order of relevance
4. Maintaining all original items (no additions or deletions)

## Temporal Priority Rules
- Query recency matters: Index 0 is the MOST RECENT query
- Evidence matching recent queries gets higher priority
- For equal relevance scores: Favor items matching newer queries

## Input Format
- Queries: Recent user questions/requests (list)
- Current Order: Existing memory sequence (list of strings with indices)

## Output Requirements
Return a JSON object with:
- "new_order": The reordered indices (array of integers)
- "reasoning": Brief explanation of your ranking logic (1-2 sentences)

## Processing Guidelines
1. Prioritize evidence that:
   - Directly answers query questions
   - Contains exact keyword matches
   - Provides contextual support
   - Shows temporal relevance (newer > older)
2. For ambiguous cases, maintain original relative ordering

## Scoring Priorities (Descending Order)
1. Direct matches to newer queries
2. Exact keyword matches in recent queries
3. Contextual support for recent topics
4. General relevance to older queries

## Example
Input queries: ["[0] python threading", "[1] data visualization"]
Input order: ["[0] syntax", "[1] matplotlib", "[2] threading"]

Output:
{{
  "new_order": [2, 1, 0],
  "reasoning": "Threading (2) prioritized for matching newest query, followed by matplotlib (1) for older visualization query"
}}

## Current Task
Queries: {queries} (recency-ordered)
Current order: {current_order}

Please provide your reorganization:
"""

QUERY_KEYWORDS_EXTRACTION_PROMPT = """
## Role
You are an intelligent keyword extraction system. Your task is to identify and extract the most important words or short phrases from user queries.

## Instructions
- They have to be single words or short phrases that make sense.
- Only nouns (naming words) or verbs (action words) are allowed.
- Don't include stop words (like "the", "is") or adverbs (words that describe verbs, like "quickly").
- Keep them as the smallest possible units that still have meaning.

## Example
- Input Query: "What breed is Max?"
- Output Keywords (list of string): ["breed", "Max"]

## Current Task
- Query: {query}
- Output Format: A Json list of keywords.

Answer:
"""


PROMPT_MAPPING = {
    "intent_recognizing": INTENT_RECOGNIZING_PROMPT,
    "memory_reranking": MEMORY_RERANKING_PROMPT,
    "query_keywords_extraction": QUERY_KEYWORDS_EXTRACTION_PROMPT,
}

MEMORY_ASSEMBLY_TEMPLATE = """The retrieved memories are listed as follows:\n\n {memory_text}"""
