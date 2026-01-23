TASK_CHUNKING_PROMPT = """
# Role
You are an expert in natural language processing (NLP) and dialogue logic analysis. You excel at organizing logical threads from complex long conversations and accurately extracting users' core intentions.

# Task
Please analyze the provided conversation records, identify all independent "tasks" that the user has asked the AI to perform, and assign the corresponding dialogue message numbers to each task.

# Rules & Constraints
1. **Task Independence**: If multiple unrelated topics are discussed in the conversation, identify them as different tasks.
2. **Non-continuous Processing**: Pay attention to identifying "jumping" conversations. For example, if the user made travel plans in messages 8-11, switched to consulting about weather in messages 12-22, and then returned to making travel plans in messages 23-24, be sure to assign both 8-11 and 23-24 to the task "Making travel plans".
3. **Filter Chit-chat**: Only extract tasks with clear goals, instructions, or knowledge-based discussions. Ignore meaningless greetings (such as "Hello", "Are you there?") or closing remarks unless they are part of the task context.
4. **Output Format**: Please strictly follow the JSON format for output to facilitate my subsequent processing.
5. **Language Consistency**: The language used in the task_name field must match the language used in the conversation records.

```json
[
  {
    "task_id": 1,
    "task_name": "Brief description of the task (e.g., Making travel plans)",
    "message_indices": [[0, 5],[16, 17]], # 0-5 and 16-17 are the message indices for this task
    "reasoning": "Briefly explain why these messages are grouped together"
  },
  ...
]
```



# Context (Conversation Records)
{{messages}}
"""

SKILL_MEMORY_EXTRACTION_PROMPT = """
"""


SKILLS_AUTHORING_PROMPT = """
"""

TASK_QUERY_REWRITE_PROMPT = """
"""
