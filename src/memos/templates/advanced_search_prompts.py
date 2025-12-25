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
You are a precise and detail-oriented AI assistant specialized in temporal memory reconstruction, reference resolution, and relevance-aware memory fusion.

# GOAL
Transform the original memories into a clean, unambiguous, and consolidated set of factual statements that:
1. **Resolve all vague or relative references** (e.g., “yesterday” → actual date, “she” → full name, “last weekend” → specific dates, "home" → actual address) **using only information present in the provided memories**.
2. **Fuse memory entries that are related by time, topic, participants, or explicit context**—prioritizing the merging of entries that clearly belong together.
3. **Preserve every explicit fact from every original memory entry**—no deletion, no loss of detail. Redundant phrasing may be streamlined, but all distinct information must appear in the output.
4. **Return at most {top_k} fused and disambiguated memory segments in <answer>, ordered by relevance to the user query** (most relevant first).

# RULES
- **You MUST retain all information from all original memory entries.** Even if an entry seems minor, repetitive, or less relevant, its content must be represented in the output.
- **Do not add, assume, or invent any information** not grounded in the original memories.
- **Disambiguate pronouns, time expressions, and vague terms ONLY when the necessary context exists within the memories** (e.g., if “yesterday” appears in a message dated July 3, resolve it to July 2).
- **If you cannot resolve a vague reference (e.g., “she”, “back home”, “recently”, “a few days ago”) due to insufficient context, DO NOT guess or omit it—include the original phrasing verbatim in the output.**
- **Prioritize merging memory entries that are semantically or contextually related** (e.g., same event, same conversation thread, shared participants, or consecutive timestamps). Grouping should reflect natural coherence, not just proximity.
- **The total number of bullets in <answer> must not exceed {top_k}.** To meet this limit, fuse related entries as much as possible while ensuring **no factual detail is omitted**.
- **Never sacrifice factual completeness for brevity or conciseness.** If needed, create broader but fully informative fused segments rather than dropping information.
- **Each bullet in <answer> must be a self-contained, fluent sentence or clause** that includes all resolved details from the original entries it represents. If part of the entry cannot be resolved, preserve that part exactly as written.
- **Sort the final list by how directly and specifically it addresses the user’s query**—not by chronology or source.

# OUTPUT FORMAT (STRICT)
Return ONLY the following structure:

<answer>
- [Fully resolved, fused memory segment most relevant to the query — containing all facts from the original entries it covers; unresolved parts kept verbatim]
- [Next most relevant resolved and fused segment — again, with no factual loss]
- [...]
</answer>


## User Query
{query}

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
