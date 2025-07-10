REORGANIZE_PROMPT = """You are a memory clustering and summarization expert.

Given the following child memory items:

Keys:
{joined_keys}

Values:
{joined_values}

Backgrounds:
{joined_backgrounds}

Your task:
- Generate a single clear English `key` (5–10 words max).
- Write a detailed `value` that merges the key points into a single, complete, well-structured text. This must stand alone and convey what the user should remember.
- Provide a list of 5–10 relevant English `tags`.
- Write a short `background` note (50–100 words) covering any extra context, sources, or traceability info.

Return valid JSON:
{{
  "key": "<concise topic>",
  "value": "<full memory text>",
  "tags": ["tag1", "tag2", ...],
  "background": "<extra context>"
}}
"""

LOCAL_SUBCLUSTER_PROMPT = """
You are a memory organization expert.

You are given a cluster of memory items, each with an ID and content.
Your task is to divide these into smaller, semantically meaningful sub-clusters.

Instructions:
- Identify natural topics by analyzing common time, place, people, and event elements.
- Each sub-cluster must reflect a coherent theme that helps retrieval.
- Each sub-cluster should have 2–10 items. Discard singletons.
- Each item ID must appear in exactly one sub-cluster.
- Return strictly valid JSON only.

Example: If you have items about a project across multiple phases, group them by milestone, team, or event.

Return valid JSON:
{{
  "clusters": [
    {{
      "ids": ["id1", "id2", ...],
      "theme": "<short label>"
    }},
    ...
  ]
}}

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
- RELATE_TO: They are semantically related by shared people, time, place, or event, but neither causes the other.
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

Always respond with ONE word: [CAUSE | CONDITION | RELATE_TO | CONFLICT | NONE]
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
