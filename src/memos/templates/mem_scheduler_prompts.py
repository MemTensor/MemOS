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

## Output Format Requirements
You MUST output a valid JSON object with EXACTLY the following structure:
{{
  "new_order": [array_of_integers],
  "reasoning": "string_explanation"
}}

## Important Notes:
- Only output the JSON object, nothing else
- Do not include any markdown formatting or code block notation
- Ensure all brackets and quotes are properly closed
- The output must be parseable by a JSON parser

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

MEMORY_FILTERING_PROMPT = """
# Memory Relevance Filtering Task

## Role
You are an intelligent memory filtering system. Your primary function is to analyze memory relevance and filter out memories that are completely unrelated to the user's query history.

## Task Description
Analyze the provided memories and determine which ones are relevant to the user's query history:
1. Evaluate semantic relationship between each memory and the query history
2. Identify memories that are completely unrelated or irrelevant
3. Filter out memories that don't contribute to answering the queries
4. Preserve memories that provide context, evidence, or relevant information

## Relevance Criteria
A memory is considered RELEVANT if it:
- Directly answers questions from the query history
- Provides context or background information related to the queries
- Contains information that could be useful for understanding the queries
- Shares semantic similarity with query topics or themes
- Contains keywords or concepts mentioned in the queries

A memory is considered IRRELEVANT if it:
- Has no semantic connection to any query in the history
- Discusses completely unrelated topics
- Contains information that cannot help answer any query
- Is too generic or vague to be useful

## Input Format
- Query History: List of user queries (chronological order)
- Memories: List of memory texts to be evaluated

## Output Format Requirements
You MUST output a valid JSON object with EXACTLY the following structure:
{{
  "relevant_memories": [array_of_memory_indices],
  "filtered_count": <number_of_filtered_memories>,
  "reasoning": "string_explanation"
}}

## Important Notes:
- Only output the JSON object, nothing else
- Do not include any markdown formatting or code block notation
- Ensure all brackets and quotes are properly closed
- The output must be parseable by a JSON parser
- Memory indices should correspond to the input order (0-based)

## Processing Guidelines
1. Be conservative in filtering - when in doubt, keep the memory
2. Consider both direct and indirect relevance
3. Look for thematic connections, not just exact keyword matches
4. Preserve memories that provide valuable context

## Current Task
Query History: {query_history}
Memories to Filter: {memories}

Please provide your filtering analysis:
"""

MEMORY_REDUNDANCY_FILTERING_PROMPT = """
# Memory Redundancy Filtering Task

## Role
You are an intelligent memory optimization system. Your primary function is to analyze memories and remove redundancy to improve memory quality and relevance.

## Task Description
Analyze the provided memories and identify redundant ones:
1. **Redundancy Detection**: Find memories that contain the same core facts relevant to queries
2. **Best Memory Selection**: Keep only the most concise and focused version of redundant information
3. **Quality Preservation**: Ensure the final set covers all necessary information without redundancy

## Redundancy Detection Criteria
A memory is considered REDUNDANT if it:
- Contains the same core fact as another memory that's relevant to the queries
- Provides the same information but with additional irrelevant details
- Repeats information that's already covered by a more concise memory
- Has overlapping content with another memory that serves the same purpose

When redundancy is found, KEEP the memory that:
- Is more concise and focused
- Contains less irrelevant information
- Is more directly relevant to the queries
- Has higher information density

## Input Format
- Query History: List of user queries (chronological order)
- Memories: List of memory texts to be evaluated

## Output Format Requirements
You MUST output a valid JSON object with EXACTLY the following structure:
{{
  "kept_memories": [array_of_memory_indices_to_keep],
  "redundant_groups": [
    {{
      "group_id": <number>,
      "memories": [array_of_redundant_memory_indices],
      "kept_memory": <index_of_best_memory_in_group>,
      "reason": "explanation_of_why_this_memory_was_kept"
    }}
  ],
  "reasoning": "string_explanation_of_filtering_decisions"
}}

## Important Notes:
- Only output the JSON object, nothing else
- Do not include any markdown formatting or code block notation
- Ensure all brackets and quotes are properly closed
- The output must be parseable by a JSON parser
- Memory indices should correspond to the input order (0-based)
- Be conservative in filtering - when in doubt, keep the memory
- Focus on semantic similarity, not just exact text matches

## Processing Guidelines
1. First identify which memories are relevant to the queries
2. Group relevant memories by semantic similarity and core facts
3. Within each group, select the best memory (most concise, least noise)
4. Ensure the final set covers all necessary information without redundancy

## Current Task
Query History: {query_history}
Memories to Filter: {memories}

Please provide your redundancy filtering analysis:
"""

MEMORY_COMBINED_FILTERING_PROMPT = """
# Memory Combined Filtering Task

## Role
You are an intelligent memory optimization system. Your primary function is to analyze memories and perform two types of filtering in sequence:
1. **Unrelated Memory Removal**: Remove memories that are completely unrelated to the user's query history
2. **Redundancy Removal**: Remove redundant memories by keeping only the most informative version

## Task Description
Analyze the provided memories and perform comprehensive filtering:
1. **First Step - Unrelated Filtering**: Identify and remove memories that have no semantic connection to any query
2. **Second Step - Redundancy Filtering**: Group similar memories and keep only the best version from each group

## Unrelated Memory Detection Criteria
A memory is considered UNRELATED if it:
- Has no semantic connection to any query in the history
- Discusses completely unrelated topics
- Contains information that cannot help answer any query
- Is too generic or vague to be useful

## Redundancy Detection Criteria
A memory is considered REDUNDANT if it:
- Contains the same core fact as another memory that's relevant to the queries
- Provides the same information but with additional irrelevant details
- Repeats information that's already covered by a more concise memory
- Has overlapping content with another memory that serves the same purpose

When redundancy is found, KEEP the memory that:
- Is more concise and focused
- Contains less irrelevant information
- Is more directly relevant to the queries
- Has higher information density

## Input Format
- Query History: List of user queries (chronological order)
- Memories: List of memory texts to be evaluated

## Output Format Requirements
You MUST output a valid JSON object with EXACTLY the following structure:
{{
  "kept_memories": [array_of_memory_indices_to_keep],
  "unrelated_removed_count": <number_of_unrelated_memories_removed>,
  "redundant_removed_count": <number_of_redundant_memories_removed>,
  "redundant_groups": [
    {{
      "group_id": <number>,
      "memories": [array_of_redundant_memory_indices],
      "kept_memory": <index_of_best_memory_in_group>,
      "reason": "explanation_of_why_this_memory_was_kept"
    }}
  ],
  "reasoning": "string_explanation_of_filtering_decisions"
}}

## Important Notes:
- Only output the JSON object, nothing else
- Do not include any markdown formatting or code block notation
- Ensure all brackets and quotes are properly closed
- The output must be parseable by a JSON parser
- Memory indices should correspond to the input order (0-based)
- Be conservative in filtering - when in doubt, keep the memory
- Focus on semantic similarity, not just exact text matches

## Processing Guidelines
1. **First, identify unrelated memories** and mark them for removal
2. **Then, group remaining memories** by semantic similarity and core facts
3. **Within each group, select the best memory** (most concise, least noise)
4. **Ensure the final set covers all necessary information** without redundancy
5. **Count how many memories were removed** for each reason

## Current Task
Query History: {query_history}
Memories to Filter: {memories}

Please provide your combined filtering analysis:
"""


MEMORY_ANSWER_ABILITY_EVALUATION_PROMPT = """
# Memory Answer Ability Evaluation Task

## Task
Evaluate whether the provided memories contain sufficient information to answer the user's query.

## Evaluation Criteria
Consider these factors:
1. **Answer completeness**: Do the memories cover all aspects of the query?
2. **Evidence relevance**: Do the memories directly support answering the query?
3. **Detail specificity**: Do the memories contain necessary granularity?
4. **Information gaps**: Are there obvious missing pieces of information?

## Decision Rules
- Return `True` for "result" ONLY when memories provide complete, relevant answers
- Return `False` for "result" if memories are insufficient, irrelevant, or incomplete

## User Query
{query}

## Available Memories
{memory_list}

## Required Output
Return a JSON object with this exact structure:
{{
  "result": <boolean>,
  "reason": "<brief explanation of your decision>"
}}

## Instructions
- Only output the JSON object, nothing else
- Be conservative: if there's any doubt about completeness, return true
- Focus on whether the memories can fully answer the query without additional information
"""

MEMORY_RECREATE_ENHANCEMENT_PROMPT = """
You are a knowledgeable and precise AI assistant.

# GOAL
Transform raw memories into clean, complete, and fully disambiguated statements that preserve original meaning and explicit details.

# RULES & THINKING STEPS
1. Preserve ALL explicit timestamps (e.g., “on October 6”, “daily”).
2. Resolve all ambiguities using only memory content. If disambiguation cannot be performed using only the provided memories, retain the original phrasing exactly as written. Never guess, infer, or fabricate missing information:
    - Pronouns → full name (e.g., “she” → “Caroline”)
    - Relative time expressions → concrete dates or full context (e.g., “last night” → “on the evening of November 25, 2025”)
    - Vague references → specific, grounded details (e.g., “the event” → “the LGBTQ+ art workshop in Malmö”)
    - Incomplete descriptions → full version from memory (e.g., “the activity” → “the abstract painting session at the community center”)
3. Merge memories that are largely repetitive in content but contain complementary or distinct details. Combine them into a single, cohesive statement that preserves all unique information from each original memory. Do not merge memories that describe different events, even if they share a theme.
4. Keep ONLY what’s relevant to the user’s query. Delete irrelevant memories entirely.

# OUTPUT FORMAT (STRICT)
Return ONLY the following block, with **one enhanced memory per line**.
Each line MUST start with "- " (dash + space).

Wrap the final output inside:
<answer>
- enhanced memory 1
- enhanced memory 2
...
</answer>

## User Query
{query_history}

## Original Memories
{memories}

Final Output:
"""

MEMORY_RECREATE_ENHANCEMENT_PROMPT_BACKUP_1 = """
You are a knowledgeable and precise AI assistant.

# GOAL
Transform raw memories into clean, complete, and fully disambiguated statements that preserve original meaning and explicit details.

# RULES & THINKING STEPS
1. Preserve ALL explicit timestamps (e.g., “on October 6”, “daily”).
2. Resolve all ambiguities using only memory content. If disambiguation cannot be performed using only the provided memories, retain the original phrasing exactly as written. Never guess, infer, or fabricate missing information:
    - Pronouns → full name (e.g., “she” → “Caroline”)
    - Relative time expressions → concrete dates or full context (e.g., “last night” → “on the evening of November 25, 2025”)
    - Vague references → specific, grounded details (e.g., “the event” → “the LGBTQ+ art workshop in Malmö”)
    - Incomplete descriptions → full version from memory (e.g., “the activity” → “the abstract painting session at the community center”)
3. Merge memories that are largely repetitive in content but contain complementary or distinct details. Combine them into a single, cohesive statement that preserves all unique information from each original memory. Do not merge memories that describe different events, even if they share a theme.
4. Keep ONLY what’s relevant to the user’s query. Delete irrelevant memories entirely.

# OUTPUT FORMAT (STRICT)
Return ONLY the following block, with **one enhanced memory per line**.
Each line MUST start with "- " (dash + space).

Wrap the final output inside:
<answer>
- enhanced memory 1
- enhanced memory 2
...
</answer>

## User Query
{query_history}

## Original Memories
{memories}

Final Output:
"""


MEMORY_RECREATE_ENHANCEMENT_PROMPT_BACKUP_2 = """
You are a knowledgeable and precise AI assistant.

# GOAL
Transform raw memories into clean, query-relevant facts — preserving timestamps and resolving ambiguities without inference.

# RULES & THINKING STEPS
1. Keep ONLY what’s relevant to the user’s query. Delete irrelevant memories entirely.
2. Preserve ALL explicit timestamps (e.g., “on October 6”, “daily”, “after injury”).
3. Resolve all ambiguities using only memory content:
   - Pronouns → full name: “she” → “Melanie”
   - Vague nouns → specific detail: “home” → “her childhood home in Guangzhou”
   - “the user” → identity from context (e.g., “Melanie” if travel/running memories)
4. Never invent, assume, or extrapolate.
5. Each output line must be a standalone, clear, factual statement.
6. Output format: one line per fact, starting with "- ", no extra text.

# OUTPUT FORMAT (STRICT)
Return ONLY the following block, with **one enhanced memory per line**.
Each line MUST start with "- " (dash + space).

Wrap the final output inside:
<answer>
- enhanced memory 1
- enhanced memory 2
...
</answer>

## User Query
{query_history}

## Original Memories
{memories}

Final Output:
"""

MEMORY_REWRITE_ENHANCEMENT_PROMPT = """
You are a knowledgeable and precise AI assistant.

# GOAL
Transform raw memories into clean, query-relevant facts — preserving timestamps and resolving ambiguities without inference. Return each enhanced fact with the ID of the original memory being modified.

# RULES & THINKING STEPS
1. Keep ONLY what’s relevant to the user’s query. Delete irrelevant memories entirely.
2. Preserve ALL explicit timestamps (e.g., “on October 6”, “daily”, “after injury”).
3. Resolve all ambiguities using only memory content:
   - Pronouns → full name: “she” → “Melanie”
   - Vague nouns → specific detail: “home” → “her childhood home in Guangzhou”
   - “the user” → identity from context (e.g., “Melanie” if travel/running memories)
4. Never invent, assume, or extrapolate.
5. Each output line must be a standalone, clear, factual statement.
6. Output format: one line per fact, starting with "- ", no extra text.

# IMPORTANT FOR REWRITE
- Each output line MUST include the original memory’s ID shown in the input list.
- Use the index shown for each original memory (e.g., "[0]", "[1]") as the ID to reference which memory you are rewriting.
- For every rewritten line, prefix with the corresponding index in square brackets.

# OUTPUT FORMAT (STRICT)
Return ONLY the following block, with **one enhanced memory per line**.
Each line MUST start with "- " (dash + space) AND include index in square brackets.

Wrap the final output inside:
<answer>
- [index] enhanced memory 1
- [index] enhanced memory 2
...
</answer>

## User Query
{query_history}

## Original Memories
{memories}

Final Output:
"""


# One-sentence prompt for recalling missing information to answer the query (English)
ENLARGE_RECALL_PROMPT_ONE_SENTENCE = """
You are a precise AI assistant. Your job is to analyze the user's query and the available memories to identify what specific information is missing to fully answer the query.

# GOAL
Identify the specific missing facts needed to fully answer the user's query and generate a concise hint for recalling them.

# RULES
- Analyze the user's query to understand what information is being asked.
- Review the available memories to see what information is already present.
- Identify the gap between the user's query and the available memories.
- Generate a single, concise hint that prompts the user to provide the missing information.
- The hint should be a direct question or a statement that clearly indicates what is needed.

# OUTPUT FORMAT
A JSON object with:

trigger_retrieval: true if information is missing, false if sufficient.
hint: A clear, specific prompt to retrieve the missing information (or an empty string if trigger_retrieval is false):
{{
  "trigger_recall": <boolean>,
  "hint": a paraphrase to retrieve support memories
}}

## User Query
{query}

## Available Memories
{memories_inline}

Final Output:
"""

ENLARGE_RECALL_PROMPT_ONE_SENTENCE_BACKUP = """
You are a precise AI assistant. Your job is to analyze the user's query and the available memories to identify what specific information is missing to fully answer the query.

# GOAL

Identify the specific missing facts needed to fully answer the user's query and generate a concise hint for recalling them.

# RULES

- Analyze the user's query to understand what information is being asked.
- Review the available memories to see what information is already present.
- Identify the gap between the user's query and the available memories.
- Generate a single, concise hint that prompts the user to provide the missing information.
- The hint should be a direct question or a statement that clearly indicates what is needed.

# OUTPUT FORMAT
A JSON object with:

trigger_retrieval: true if information is missing, false if sufficient.
hint: A clear, specific prompt to retrieve the missing information (or an empty string if trigger_retrieval is false):
{{
  "trigger_recall": <boolean>,
  "hint": a paraphrase to retrieve support memories
}}

## User Query
{query}

## Available Memories
{memories_inline}

Final Output:
"""

PROMPT_MAPPING = {
    "intent_recognizing": INTENT_RECOGNIZING_PROMPT,
    "memory_reranking": MEMORY_RERANKING_PROMPT,
    "query_keywords_extraction": QUERY_KEYWORDS_EXTRACTION_PROMPT,
    "memory_filtering": MEMORY_FILTERING_PROMPT,
    "memory_redundancy_filtering": MEMORY_REDUNDANCY_FILTERING_PROMPT,
    "memory_combined_filtering": MEMORY_COMBINED_FILTERING_PROMPT,
    "memory_answer_ability_evaluation": MEMORY_ANSWER_ABILITY_EVALUATION_PROMPT,
    "memory_recreate_enhancement": MEMORY_RECREATE_ENHANCEMENT_PROMPT,
    "memory_rewrite_enhancement": MEMORY_REWRITE_ENHANCEMENT_PROMPT,
    "enlarge_recall": ENLARGE_RECALL_PROMPT_ONE_SENTENCE,
}

MEMORY_ASSEMBLY_TEMPLATE = """The retrieved memories are listed as follows:\n\n {memory_text}"""
