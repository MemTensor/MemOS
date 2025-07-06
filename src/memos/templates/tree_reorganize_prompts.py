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
