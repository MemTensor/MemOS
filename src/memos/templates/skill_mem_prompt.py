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
# Role
You are an expert in knowledge extraction and skill memory management. You excel at analyzing conversations to extract actionable skills, procedures, experiences, and user preferences.

# Task
Based on the provided conversation messages and existing skill memories, extract new skill memory or update existing ones. You need to determine whether the current conversation contains skills similar to existing memories.

# Existing Skill Memories
{old_memories}

# Conversation Messages
{messages}

# Extraction Rules
1. **Similarity Check**: Compare the current conversation with existing skill memories. If a similar skill exists, set "update": true and provide the "old_memory_id". Otherwise, set "update": false and leave "old_memory_id" empty.
2. **Completeness**: Extract comprehensive information including procedures, experiences, preferences, and examples.
3. **Clarity**: Ensure procedures are step-by-step and easy to follow.
4. **Specificity**: Capture specific user preferences and lessons learned from experiences.
5. **Language Consistency**: Use the same language as the conversation.
6. **Accuracy**: Only extract information that is explicitly present or strongly implied in the conversation.

# Output Format
Please output in strict JSON format:

```json
{
  "name": "A concise name for this skill or task type",
  "description": "A clear description of what this skill does or accomplishes (this will be stored as the memory field)",
  "procedure": "Step-by-step procedure: 1. First step 2. Second step 3. Third step...",
  "experience": ["Lesson 1: Specific experience or insight learned", "Lesson 2: Another valuable experience..."],
  "preference": ["User preference 1", "User preference 2", "User preference 3..."],
  "example": ["Example scenario 1 showing how to apply this skill", "Example scenario 2..."],
  "tags": ["tag1", "tag2", "tag3"],
  "scripts": {"script_name.py": "# Python code here\nprint('Hello')", "another_script.py": "# More code\nimport os"},
  "others": {"Section Title": "Content here", "reference.md": "# Reference content for this skill"},
  "update": false,
  "old_memory_id": ""
}
```

# Field Descriptions
- **name**: Brief identifier for the skill (e.g., "Travel Planning", "Code Review Process")
- **description**: What this skill accomplishes or its purpose
- **procedure**: Sequential steps to complete the task
- **experience**: Lessons learned, best practices, things to avoid
- **preference**: User's specific preferences, likes, dislikes
- **example**: Concrete examples of applying this skill
- **tags**: Relevant keywords for categorization
- **scripts**: Dictionary of scripts where key is the .py filename and value is the executable code snippet. Use null if not applicable
- **others**: Flexible additional information in key-value format. Can be either:
  - Simple key-value pairs where key is a title and value is content (displayed inline in SKILL.md)
  - Separate markdown files where key is .md filename and value is the markdown content (creates separate file and links to it)
  Use null if not applicable
- **update**: true if updating existing memory, false if creating new
- **old_memory_id**: The ID of the existing memory being updated, or empty string if new

# Important Notes
- If no clear skill can be extracted from the conversation, return null
- Ensure all string values are properly formatted and contain meaningful information
- Arrays should contain at least one item if the field is populated
- Be thorough but avoid redundancy

# Output
Please output only the JSON object, without any additional formatting, markdown code blocks, or explanation.
"""


SKILLS_AUTHORING_PROMPT = """
"""

TASK_QUERY_REWRITE_PROMPT = """
# Role
You are an expert in understanding user intentions and task requirements. You excel at analyzing conversations and extracting the core task description.

# Task
Based on the provided task type and conversation messages, analyze and determine what specific task the user wants to complete, then rewrite it into a clear, concise task query string.

# Task Type
{task_type}

# Conversation Messages
{messages}

# Requirements
1. Analyze the conversation content to understand the user's core intention
2. Consider the task type as context
3. Extract and summarize the key task objective
4. Output a clear, concise task description string (one sentence)
5. Use the same language as the conversation
6. Focus on WHAT needs to be done, not HOW to do it
7. Do not include any explanations, just output the rewritten task string directly

# Output
Please output only the rewritten task query string, without any additional formatting or explanation.
"""
