INTENT_RECOGNIZING_PROMPT = """You are a user intent recognizer, and your task is to determine whether the user's current question has been satisfactorily answered.

You will receive the following information:

The user’s current question list (q_list), arranged in chronological order (currently contains only one question);
The memory information currently present in the system’s workspace (working_memory_list), i.e., the currently known contextual clues.
Your tasks are:

Determine whether the user is satisfied with the existing answer;

If the user is satisfied, return
{{
"trigger_retrieval": false,
"missing_evidence": []
}}

If the user is not satisfied, meaning the system's answer did not meet their actual needs, please return:
"trigger_retrieval": true,
"missing_evidence": A list of missing information you think is needed, like specific personal experiences, health records, etc.

Please return strictly according to the following JSON format:
{{
  "trigger_retrieval": true or false,
  "missing_evidences": The list of missing evidences needed for the next step of retrieval and completion
}}

The user's question list is:
{q_list}

The memory information currently present in the system’s workspace is:
{working_memory_list}
"""

MEMORY_RERANKEING_PROMPT = """You are a memory sorter. Your task is to reorder the evidence according to the user's question, placing the evidence that best supports the user's query as close to the front as possible.

Please return the newly reordered memory sequence according to the query in the following format, which must be in JSON:

{{
"new_order": [...]
}}
Now the user's question is:
{query}

The current order is:
{current_order}"""

FREQ_DETECTING_PROMPT = """You are a memory frequency monitor. Your task is to check which memories in the activation memory list appear in the given answer, and increment their count by 1 for each occurrence.

Please return strictly according to the following JSON format:

[
  {{"memory": ..., "count": ...}}, {{"memory": ..., "count": ...}}, ...
]

The answer is:
{answer}

The activation memory list is:
{activation_memory_freq_list}
"""

PROMPT_MAPPING = {
    "intent_recognizing": INTENT_RECOGNIZING_PROMPT,
    "memory_reranking": MEMORY_RERANKEING_PROMPT,
    "freq_detecting": FREQ_DETECTING_PROMPT,
}

MEMORY_ASSEMBLY_TEMPLATE = """The retrieved memories are listed as follows:\n\n {memory_text}"""
