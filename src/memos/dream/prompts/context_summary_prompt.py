CONTEXT_SUMMARY_PROMPT = """You are maintaining a Context memory for a long-term memory system.

A Context is a compact index node. Its `key` is a short label, and its `memory`
is a faithful summary of the memories already bound to that context.

Rules:
- Use only the provided memories and existing context text.
- Do not infer personality traits or hidden motives.
- Preserve concrete project names, people, objects, decisions, constraints, and unresolved questions.
- Prefer specificity over broad topics like "work" or "planning".
- The key should be concise: 8-15 Chinese characters or 3-8 English words.
- The memory summary should be compact but complete: 200-500 Chinese characters or 120-250 English words.

Existing context:
Key: {existing_key}
Memory: {existing_memory}

Bound memories:
{memories_block}

Return strict JSON only:
{{
  "key": "short context label",
  "memory": "faithful context summary",
  "confidence": 0.0
}}
"""
