STAGE1_EXPAND_RETRIEVE_PROMPT = """
## Goal
Determine whether the current memories can answer the query using concrete, specific facts. If not, generate 3–8 precise retrieval phrases that capture the missing information.

## Strict Criteria for Answerability
- The answer MUST be factual, precise, and grounded solely in memory content.
- Do NOT use vague adjectives (e.g., "usually", "often"), unresolved pronouns ("he", "it"), or generic statements.
- Do NOT answer with placeholders, speculation, or inferred information.

## Retrieval Phrase Requirements (if can_answer = false)
- Output 3–8 short, discriminative noun phrases or attribute-value pairs.
- Each phrase must include at least one explicit entity, attribute, time, or location.
- Avoid fuzzy words, subjective terms, or pronouns.
- Phrases must be directly usable as search queries in a vector or keyword retriever.

## Input
- Query: {query}
- Previous retrieval phrases:
{previous_retrieval_phrases}
- Current Memories:
{memories}

## Output (STRICT TAG-BASED FORMAT)
Respond ONLY with the following structure. Do not add any other text, explanation, or formatting.

<can_answer>
true or false
</can_answer>
<reason>
Brief, one-sentence explanation for why the query is or isn't answerable with current memories.
</reason>
<retrieval_phrases>
- missing phrase 1
- missing phrase 2
...
</retrieval_phrases>

Answer:
"""


# Stage 2: if Stage 1 phrases still fail, rewrite the retrieval query and phrases to maximize recall
STAGE2_EXPAND_RETRIEVE_PROMPT = """
## Goal
Rewrite the original query and generate an improved list of retrieval phrases to maximize recall of relevant memories. Use reference resolution, canonicalization, synonym expansion, and constraint enrichment.

## Rewrite Strategy
- **Resolve ambiguous references**: Replace pronouns (e.g., “she”, “they”, “it”) and vague terms (e.g., “the book”, “that event”) with explicit entity names or descriptors using only information from the current memories.
- **Canonicalize entities**: Use full names (e.g., “Melanie Smith”), known roles (e.g., “Caroline’s mentor”), or unambiguous identifiers when available.
- **Normalize temporal expressions**: Convert relative time references (e.g., “yesterday”, “last weekend”, “a few months ago”) to absolute dates or date ranges **only if the current memories provide sufficient context**.
- **Enrich with discriminative context**: Combine entity + action/event + time + location when supported by memory content (e.g., “Melanie pottery class July 2023”).
- **Decompose complex queries**: Break multi-part or abstract questions into concrete, focused sub-queries targeting distinct factual dimensions.
- **Never invent, assume, or retain unresolved pronouns, vague nouns, or subjective language**.

## Input
- Query: {query}
- Previous retrieval phrases:
{previous_retrieval_phrases}
- Current Memories:
{memories}

## Output (STRICT TAG-BASED FORMAT)
Respond ONLY with the following structure. Do not add any other text, explanation, or formatting.

<can_answer>
true or false
</can_answer>
<reason>
Brief explanation (1–2 sentences) of how this rewrite improves recall—e.g., by resolving pronouns, normalizing time, or adding concrete attributes—over Stage 1 phrases.
</reason>
<retrieval_phrases>
- new phrase 1 (Rewritten, canonical, fully grounded in memory content)
- new phrase 2
...
</retrieval_phrases>

Answer:
"""


# Stage 3: generate grounded hypotheses to guide retrieval when still not answerable
STAGE3_EXPAND_RETRIEVE_PROMPT = """
## Goal
As the query remains unanswerable, generate grounded, plausible hypotheses based ONLY on the provided memories. Each hypothesis must imply a concrete retrieval target and define clear validation criteria.

## Rules
- Base hypotheses strictly on facts from the memories. Do NOT introduce new entities, events, or assumptions.
- Frame each hypothesis as a testable conditional statement: "If [X] is true, then the query can be answered."
- For each hypothesis, specify 1–3 concrete evidence requirements that would confirm it (e.g., a specific date, name, or event description).
- Do NOT guess, invent, or speculate beyond logical extrapolation from existing memory content.

## Input
- Query: {query}
- Previous retrieval phrases:
{previous_retrieval_phrases}
- Memories:
{memories}

## Output (STRICT TAG-BASED FORMAT)
Respond ONLY with the following structure. Do not add any other text, explanation, or formatting.

<can_answer>
true or false
</can_answer>
<reason>
- statement: <tentative, grounded hypothesis derived from memory>
  retrieval_query: <concise, searchable query to test the hypothesis>
  validation_criteria:
  - <specific evidence that would confirm the hypothesis>
  - <another required piece of evidence (if applicable)>
- statement: <another distinct hypothesis>
  retrieval_query: <searchable query>
  validation_criteria:
  - <required evidence>
</reason>
<retrieval_phrases>
- <retrieval_query from hypothesis 1>
- <retrieval_query from hypothesis 2>
...
</retrieval_phrases>

Answer:
"""

MEMORY_JUDGMENT_PROMPT = """
# Memory Relevance Judgment

## Role
You are a precise memory evaluator. Given a user query and a set of retrieved memories, your task is to judge whether the memories contain sufficient relevant information to answer the query.

## Instructions

### Core Principles
- Use ONLY facts from the provided memories. Do not invent, infer, guess, or hallucinate.
- Resolve all pronouns (e.g., "he", "it", "they") and vague terms (e.g., "this", "that", "some people") to explicit entities using memory content.
- Each fact must be atomic, unambiguous, and verifiable.
- Preserve all key details: who, what, when, where, why — if present in memory.
- Judge whether the memories directly support answering the query.
- Focus on relevance: does this memory content actually help answer what was asked?

### Processing Logic
- Assess each memory's direct relevance to the query.
- Judge whether the combination of memories provides sufficient information for a complete answer.
- Exclude any memory that does not directly support answering the query.
- Prioritize specificity: e.g., "Travis Tang moved to Singapore in 2021" > "He relocated abroad."

## Input
- Query: {query}
- Current Memories:
{memories}

## Output Format (STRICT TAG-BASED)
Respond ONLY with the following XML-style tags. Do NOT include any other text, explanations, or formatting.

<reason>
Brief explanation of why the memories are or are not sufficient for answering the query
</reason>
<can_answer>
YES or NO - indicating whether the memories are sufficient to answer the query
</can_answer>

Answer:
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

PROMPT_MAPPING = {
    "memory_judgement": MEMORY_JUDGMENT_PROMPT,
    "stage1_expand_retrieve": STAGE1_EXPAND_RETRIEVE_PROMPT,
    "stage2_expand_retrieve": STAGE2_EXPAND_RETRIEVE_PROMPT,
    "stage3_expand_retrieve": STAGE3_EXPAND_RETRIEVE_PROMPT,
    "memory_recreate_enhancement": MEMORY_RECREATE_ENHANCEMENT_PROMPT,
}
