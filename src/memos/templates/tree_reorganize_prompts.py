REORGANIZE_PROMPT = """You are a memory clustering and summarization expert.

Given the following child memory items:

Keys:
{joined_keys}

Values:
{joined_values}

Summaries:
{joined_backgrounds}

Please perform:
1. Identify information that reflects user's experiences, beliefs, concerns, decisions, plans, or reactions — including meaningful input from assistant that user acknowledged or responded to.
2. Resolve all time, person, and event references clearly:
   - Convert relative time expressions (e.g., “yesterday,” “next Friday”) into absolute dates using the message timestamp if possible.
   - Clearly distinguish between event time and message time.
   - If uncertainty exists, state it explicitly (e.g., “around June 2025,” “exact date unclear”).
   - Include specific locations if mentioned.
   - Resolve all pronouns, aliases, and ambiguous references into full names or identities.
   - Disambiguate people with the same name if applicable.
3. Always write from a third-person perspective, referring to user as
"The user" or by name if name mentioned, rather than using first-person ("I", "me", "my").
For example, write "The user felt exhausted..." instead of "I felt exhausted...".
4. Do not omit any information that user is likely to remember.
   - Include all key experiences, thoughts, emotional responses, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over conciseness.
   - Do not generalize or skip details that could be personally meaningful to user.
5. Summarize all child memory items into one memory item.

Language rules:
- The `key`, `value`, `tags`, `summary` fields must match the mostly used language of the input memory items. **如果输入是中文，请输出中文**
- Keep `memory_type` in English.

Return valid JSON:
{
  "key": <string, a unique, concise memory title>,
  "memory_type": <string, Either "LongTermMemory" or "UserMemory">,
  "value": <A detailed, self-contained, and unambiguous memory statement — written in English if the input memory items are in English, or in Chinese if the input is in Chinese>,
  "tags": <A list of relevant thematic keywords (e.g., ["deadline", "team", "planning"])>,
  "summary": <a natural paragraph summarizing the above memories from user's perspective, 120–200 words, same language as the input>
}
"""

LOCAL_SUBCLUSTER_PROMPT = """You are a memory organization expert.

You are given a cluster of memory items, each with an ID and content.
Your task is to divide these into smaller, semantically meaningful sub-clusters.

Instructions:
- Identify natural topics by analyzing common time, place, people, and event elements.
- Each sub-cluster must reflect a coherent theme that helps retrieval.
- Each sub-cluster should have 2–10 items. Discard singletons.
- Each item ID must appear in exactly one sub-cluster or be discarded. No duplicates are allowed.
- All IDs in the output must be from the provided Memory items.
- Return strictly valid JSON only.

Example: If you have items about a project across multiple phases, group them by milestone, team, or event.

Language rules:
- The `theme` fields must match the mostly used language of the clustered memories. **如果输入是中文，请输出中文**

Return valid JSON:
{
  "clusters": [
    {
      "ids": ["<id1>", "<id2>", ...],
      "key": "<string, a unique, concise memory title>"
    },
    ...
  ]
}

Memory items:
{joined_scene}
"""

PAIRWISE_RELATION_PROMPT = """
You are a reasoning assistant.

Given two memory units:
- Node 1: "{node1}"
- Node 2: "{node2}"

Your task:
- Determine their relationship ONLY if it reveals NEW usable reasoning or retrieval knowledge that is NOT already explicit in either unit.
- Focus on whether combining them adds new temporal, causal, conditional, or conflict information.

Valid options:
- CAUSE: One clearly leads to the other.
- CONDITION: One happens only if the other condition holds.
- RELATE: They are semantically related by shared people, time, place, or event, but neither causes the other.
- CONFLICT: They logically contradict each other.
- NONE: No clear useful connection.

Example:
- Node 1: "The marketing campaign ended in June."
- Node 2: "Product sales dropped in July."
Answer: CAUSE

Another Example:
- Node 1: "The conference was postponed to August due to the venue being unavailable."
- Node 2: "The venue was booked for a wedding in August."
Answer: CONFLICT

Always respond with ONE word, no matter what language is for the input nodes: [CAUSE | CONDITION | RELATE_TO | CONFLICT | NONE]
"""

INFER_FACT_PROMPT = """
You are an inference expert.

Source Memory: "{source}"
Target Memory: "{target}"

They are connected by a {relation_type} relation.
Derive ONE new factual statement that clearly combines them in a way that is NOT a trivial restatement.

Requirements:
- Include relevant time, place, people, and event details if available.
- If the inference is a logical guess, explicitly use phrases like "It can be inferred that...".

Example:
Source: "John missed the team meeting on Monday."
Target: "Important project deadlines were discussed in that meeting."
Relation: CAUSE
Inference: "It can be inferred that John may not know the new project deadlines."

If there is NO new useful fact that combines them, reply exactly: "None"
"""

AGGREGATE_PROMPT = """
You are a concept summarization assistant.

Below is a list of memory items:
{joined}

Your task:
- Identify if they can be meaningfully grouped under a new, higher-level concept that clarifies their shared time, place, people, or event context.
- Do NOT aggregate if the overlap is trivial or obvious from each unit alone.
- If the summary involves any plausible interpretation, explicitly note it (e.g., "This suggests...").

Example:
Input Memories:
- "Mary organized the 2023 sustainability summit in Berlin."
- "Mary presented a keynote on renewable energy at the same summit."

Language rules:
- The `key`, `value`, `tags`, `background` fields must match the language of the input.

Good Aggregate:
{{
  "key": "Mary's Sustainability Summit Role",
  "value": "Mary organized and spoke at the 2023 sustainability summit in Berlin, highlighting renewable energy initiatives.",
  "tags": ["Mary", "summit", "Berlin", "2023"],
  "background": "Combined from multiple memories about Mary's activities at the summit."
}}

If you find NO useful higher-level concept, reply exactly: "None".
"""

CONFLICT_DETECTOR_PROMPT = """You are given two plaintext statements. Determine if these two statements are factually contradictory. Respond with only "yes" if they contradict each other, or "no" if they do not contradict each other. Do not provide any explanation or additional text.
Statement 1: {statement_1}
Statement 2: {statement_2}
"""

CONFLICT_RESOLVER_PROMPT = """You are given two facts that conflict with each other. You are also given some contextual metadata of them. Your task is to analyze the two facts in light of the contextual metadata and try to reconcile them into a single, consistent, non-conflicting fact.
- Don't output any explanation or additional text, just the final reconciled fact, try to be objective and remain independent of the context, don't use pronouns.
- Try to judge facts by using its time, confidence etc.
- Try to retain as much information as possible from the perspective of time.
If the conflict cannot be resolved, output <answer>No</answer>. Otherwise, output the fused, consistent fact in enclosed with <answer></answer> tags.

Output Example 1:
<answer>No</answer>

Output Example 2:
<answer> ... </answer>

Now reconcile the following two facts:
Statement 1: {statement_1}
Metadata 1: {metadata_1}
Statement 2: {statement_2}
Metadata 2: {metadata_2}
"""

REDUNDANCY_MERGE_PROMPT = """You are given two pieces of text joined by the marker `⟵MERGED⟶`. Please carefully read both sides of the merged text. Your task is to summarize and consolidate all the factual details from both sides into a single, coherent text, without omitting any information. You must include every distinct detail mentioned in either text. Do not provide any explanation or analysis — only return the merged summary. Don't use pronouns or subjective language, just the facts as they are presented.\n{merged_text}"""


REDUNDANCY_DETECTOR_PROMPT = """"""

REDUNDANCY_RESOLVER_PROMPT = """"""
