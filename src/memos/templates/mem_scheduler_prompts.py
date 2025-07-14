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
1. Mark as satisfied ONLY if:
   - All question aspects are addressed
   - Supporting evidence exists in working memory
   - No apparent gaps in information

2. Mark as unsatisfied if:
   - Any question aspect remains unanswered
   - Evidence is generic/non-specific
   - Personal context is missing

## Output Specification
Return JSON with:
- "trigger_retrieval": Boolean (true if more evidence needed)
- "missing_evidences": List of specific evidence types required

## Response Format
{{
  "trigger_retrieval": <boolean>,
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

## Input Format
- Queries: Recent user questions/requests (list)
- Current Order: Existing memory sequence (list)

## Output Requirements
Return a JSON object with:
- "new_order": The reordered list (maintaining all original items)
- "reasoning": Brief explanation of your ranking logic (1-2 sentences)

## Processing Guidelines
1. Prioritize evidence that:
   - Directly answers query questions
   - Contains exact keyword matches
   - Provides contextual support
   - Shows temporal relevance (newer > older)
2. For ambiguous cases, maintain original relative ordering

## Example
Input queries: ["python threading best practices"]
Input order: ["basic python syntax", "thread safety patterns", "data structures"]

Output:
{{
  "new_order": ["thread safety patterns", "data structures", "basic python syntax"],
  "reasoning": "Prioritized threading-related content while maintaining general python references"
}}

## Current Task
Queries: {queries}
Current order: {current_order}

Please provide your reorganization:
"""

PROMPT_MAPPING = {
    "intent_recognizing": INTENT_RECOGNIZING_PROMPT,
    "memory_reranking": MEMORY_RERANKING_PROMPT,
}

MEMORY_ASSEMBLY_TEMPLATE = """The retrieved memories are listed as follows:\n\n {memory_text}"""
