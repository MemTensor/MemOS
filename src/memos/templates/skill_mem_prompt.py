TASK_CHUNKING_PROMPT = """
# Role
You are an expert in natural language processing (NLP) and dialogue logic analysis. You excel at organizing logical threads from complex long conversations and accurately extracting users' core intentions.

# Task
Please analyze the provided conversation records, identify all independent "tasks" that the user has asked the AI to perform, and assign the corresponding dialogue message numbers to each task.

**Note**: Tasks should be high-level and general, typically divided by theme or topic. For example: "Travel Planning", "PDF Operations", "Code Review", "Data Analysis", etc. Avoid being too specific or granular.

# Rules & Constraints
1. **Task Independence**: If multiple unrelated topics are discussed in the conversation, identify them as different tasks.
2. **Non-continuous Processing**: Pay attention to identifying "jumping" conversations. For example, if the user made travel plans in messages 8-11, switched to consulting about weather in messages 12-22, and then returned to making travel plans in messages 23-24, be sure to assign both 8-11 and 23-24 to the task "Making travel plans". However, if messages are continuous and belong to the same task, do not split them apart.
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


TASK_CHUNKING_PROMPT_ZH = """
# 角色
你是自然语言处理（NLP）和对话逻辑分析的专家。你擅长从复杂的长对话中整理逻辑线索，准确提取用户的核心意图。

# 任务
请分析提供的对话记录，识别所有用户要求 AI 执行的独立"任务"，并为每个任务分配相应的对话消息编号。

**注意**：任务应该是高层次和通用的，通常按主题或话题划分。例如："旅行计划"、"PDF操作"、"代码审查"、"数据分析"等。避免过于具体或细化。

# 规则与约束
1. **任务独立性**：如果对话中讨论了多个不相关的话题，请将它们识别为不同的任务。
2. **非连续处理**：注意识别"跳跃式"对话。例如，如果用户在消息 8-11 中制定旅行计划，在消息 12-22 中切换到咨询天气，然后在消息 23-24 中返回到制定旅行计划，请务必将 8-11 和 23-24 都分配给"制定旅行计划"任务。但是，如果消息是连续的且属于同一任务，不能将其分开。
3. **过滤闲聊**：仅提取具有明确目标、指令或基于知识的讨论的任务。忽略无意义的问候（例如"你好"、"在吗？"）或结束语，除非它们是任务上下文的一部分。
4. **输出格式**：请严格遵循 JSON 格式输出，以便我后续处理。
5. **语言一致性**：task_name 字段使用的语言必须与对话记录中使用的语言相匹配。

```json
[
  {
    "task_id": 1,
    "task_name": "任务的简要描述（例如：制定旅行计划）",
    "message_indices": [[0, 5],[16, 17]], # 0-5 和 16-17 是此任务的消息索引
    "reasoning": "简要解释为什么这些消息被分组在一起"
  },
  ...
]
```

# 上下文（对话记录）
{{messages}}
"""


SKILL_MEMORY_EXTRACTION_PROMPT = """
# Role
You are an expert in general skill extraction and skill memory management. You excel at analyzing conversations to extract actionable, transferable, and reusable skills, procedures, experiences, and user preferences. The skills you extract should be general and applicable across similar scenarios, not overly specific to a single instance.

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
  "description": "A clear description of what this skill does or accomplishes",
  "procedure": "Step-by-step procedure: 1. First step 2. Second step 3. Third step...",
  "experience": ["Lesson 1: Specific experience or insight learned", "Lesson 2: Another valuable experience..."],
  "preference": ["User preference 1", "User preference 2", "User preference 3..."],
  "example": ["Example case 1 demonstrating how to complete the task following this skill's guidance", "Example case 2..."],
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
- **example**: Concrete example cases demonstrating how to complete the task by following this skill's guidance
- **tags**: Relevant keywords for categorization
- **scripts**: Dictionary of scripts where key is the .py filename and value is the executable code snippet. Use null if not applicable
- **others**: Flexible additional information in key-value format. Can be either:
  - Simple key-value pairs where key is a title and value is content
  - Separate markdown files where key is .md filename and value is the markdown content
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


SKILL_MEMORY_EXTRACTION_PROMPT_ZH = """
# 角色
你是通用技能提取和技能记忆管理的专家。你擅长分析对话，提取可操作的、可迁移的、可复用的技能、流程、经验和用户偏好。你提取的技能应该是通用的，能够应用于类似场景，而不是过于针对单一实例。

# 任务
基于提供的对话消息和现有的技能记忆，提取新的技能记忆或更新现有的技能记忆。你需要判断当前对话中是否包含与现有记忆相似的技能。

# 现有技能记忆
{old_memories}

# 对话消息
{messages}

# 提取规则
1. **相似性检查**：将当前对话与现有技能记忆进行比较。如果存在相似的技能，设置 "update": true 并提供 "old_memory_id"。否则，设置 "update": false 并将 "old_memory_id" 留空。
2. **完整性**：提取全面的信息，包括流程、经验、偏好和示例。
3. **清晰性**：确保流程是逐步的，易于遵循。
4. **具体性**：捕获具体的用户偏好和从经验中学到的教训。
5. **语言一致性**：使用与对话相同的语言。
6. **准确性**：仅提取对话中明确存在或强烈暗示的信息。

# 输出格式
请以严格的 JSON 格式输出：

```json
{
  "name": "技能或任务类型的简洁名称",
  "description": "对该技能的作用或目的的清晰描述",
  "procedure": "逐步流程：1. 第一步 2. 第二步 3. 第三步...",
  "experience": ["经验教训 1：学到的具体经验或见解", "经验教训 2：另一个有价值的经验..."],
  "preference": ["用户偏好 1", "用户偏好 2", "用户偏好 3..."],
  "example": ["示例案例 1：展示按照此技能的指引完成任务的过程", "示例案例 2..."],
  "tags": ["标签1", "标签2", "标签3"],
  "scripts": {"script_name.py": "# Python 代码\nprint('Hello')", "another_script.py": "# 更多代码\nimport os"},
  "others": {"章节标题": "这里的内容", "reference.md": "# 此技能的参考内容"},
  "update": false,
  "old_memory_id": ""
}
```

# 字段说明
- **name**：技能的简短标识符（例如："旅行计划"、"代码审查流程"）
- **description**：该技能完成什么或其目的
- **procedure**：完成任务的顺序步骤
- **experience**：学到的经验教训、最佳实践、要避免的事项
- **preference**：用户的具体偏好、喜好、厌恶
- **example**：具体的示例案例，展示如何按照此技能的指引完成任务
- **tags**：用于分类的相关关键词
- **scripts**：脚本字典，其中 key 是 .py 文件名，value 是可执行代码片段。如果不适用则使用 null
- **others**：灵活的附加信息，采用键值对格式。可以是：
  - 简单的键值对，其中 key 是标题，value 是内容
  - 独立的 markdown 文件，其中 key 是 .md 文件名，value 是 markdown 内容
  如果不适用则使用 null
- **update**：如果更新现有记忆则为 true，如果创建新记忆则为 false
- **old_memory_id**：正在更新的现有记忆的 ID，如果是新记忆则为空字符串

# 重要说明
- 如果无法从对话中提取清晰的技能，返回 null
- 确保所有字符串值格式正确且包含有意义的信息
- 如果填充数组，则数组应至少包含一项
- 要全面但避免冗余

# 输出
请仅输出 JSON 对象，不要添加任何额外的格式、markdown 代码块或解释。
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


TASK_QUERY_REWRITE_PROMPT_ZH = """
# 角色
你是理解用户意图和任务需求的专家。你擅长分析对话并提取核心任务描述。

# 任务
基于提供的任务类型和对话消息，分析并确定用户想要完成的具体任务，然后将其重写为清晰、简洁的任务查询字符串。

# 任务类型
{task_type}

# 对话消息
{messages}

# 要求
1. 分析对话内容以理解用户的核心意图
2. 将任务类型作为上下文考虑
3. 提取并总结关键任务目标
4. 输出清晰、简洁的任务描述字符串（一句话）
5. 使用与对话相同的语言
6. 关注需要做什么（WHAT），而不是如何做（HOW）
7. 不要包含任何解释，直接输出重写后的任务字符串

# 输出
请仅输出重写后的任务查询字符串，不要添加任何额外的格式或解释。
"""

SKILLS_AUTHORING_PROMPT = """
"""
