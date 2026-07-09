CONTEXT_BINDING_PROMPT = """You are grouping memories into Contexts for a long-term memory system.

A Context is a continuing task, goal, topic, project thread, relationship, or unresolved problem.
Group memories only when they are about the same continuing context.

Rules:
- Use the short IDs exactly as provided, such as "m1" or "m2".
- Each short ID can appear in at most one context.
- Do not group memories just because they share a session, project, entity, or broad topic.
- Group only when they are part of the same continuing user goal, task, decision, problem, or concrete theme.
- If unsure, leave the memory unassigned.
- Batch/chunk units should stay together unless the unit content clearly contains unrelated material.
- Do not invent facts or IDs.
- The key should be concise and specific.

Candidate memories:
{memories_block}

Return strict JSON only:
{{
  "contexts": [
    {{
      "key": "short context label",
      "ids": ["m1", "m2"],
      "confidence": 0.0,
      "reason": "brief reason"
    }}
  ],
  "unassigned_ids": ["m3"]
}}
"""
