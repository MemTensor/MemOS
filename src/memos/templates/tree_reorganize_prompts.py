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
- Look for naturally coherent themes or topics.
- Ensure each sub-cluster is meaningful and not too large (5–10 items each).
- Each sub-cluster must contain at least 2 items. Singletons should be discarded.
- Each item ID must appear in exactly one sub-cluster. Do not duplicate items.
- Return strictly valid JSON. Do not include any extra text.

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
