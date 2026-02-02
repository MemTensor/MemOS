TASK_CHUNKING_PROMPT = """
# Context (Conversation Records)
{{messages}}

# Role
You are an expert in natural language processing (NLP) and dialogue logic analysis. You excel at organizing logical threads from complex long conversations and accurately extracting users' core intentions.

# Task
Please analyze the provided conversation records, identify all independent "tasks" that the user has asked the AI to perform, and assign the corresponding dialogue message numbers to each task.

**Note**: Tasks should be high-level and general, typically divided by theme or topic. For example: "Travel Planning", "PDF Operations", "Code Review", "Data Analysis", etc. Avoid being too specific or granular.

# Rules & Constraints
1. **Task Independence**: If multiple unrelated topics are discussed in the conversation, identify them as different tasks.
2. **Non-continuous Processing**: Pay attention to identifying "jumping" conversations. For example, if the user made travel plans in messages 8-11, switched to consulting about weather in messages 12-22, and then returned to making travel plans in messages 23-24, be sure to assign both 8-11 and 23-24 to the task "Making travel plans". However, if messages are continuous and belong to the same task, do not split them apart.
3. **Filter Chit-chat**: Only extract tasks with clear goals, instructions, or knowledge-based discussions. Ignore meaningless greetings (such as "Hello", "Are you there?") or closing remarks unless they are part of the task context.
4. **Main Task and Subtasks**: Carefully identify whether subtasks serve a main task. If a subtask supports the main task (e.g., "checking weather" serves "travel planning"), do NOT separate it as an independent task. Instead, include all related conversations in the main task. Only split tasks when they are truly independent and unrelated.
5. **Output Format**: Please strictly follow the JSON format for output to facilitate my subsequent processing.
6. **Language Consistency**: The language used in the task_name field must match the language used in the conversation records.
7. **Generic Task Names**: Use generic, reusable task names, not specific descriptions. For example, use "Travel Planning" instead of "Planning a 5-day trip to Chengdu".

```json
[
  {
    "task_id": 1,
    "task_name": "Generic task name (e.g., Travel Planning, Code Review, Data Analysis)",
    "message_indices": [[0, 5],[16, 17]], # 0-5 and 16-17 are the message indices for this task
    "reasoning": "Briefly explain why these messages are grouped together"
  },
  ...
]
```
"""


TASK_CHUNKING_PROMPT_ZH = """
# 上下文（对话记录）
{{messages}}

# 角色
你是自然语言处理（NLP）和对话逻辑分析的专家。你擅长从复杂的长对话中整理逻辑线索，准确提取用户的核心意图。

# 任务
请分析提供的对话记录，识别所有用户要求 AI 执行的独立"任务"，并为每个任务分配相应的对话消息编号。

**注意**：任务应该是高层次和通用的，通常按主题或话题划分。例如："旅行计划"、"PDF操作"、"代码审查"、"数据分析"等。避免过于具体或细化。

# 规则与约束
1. **任务独立性**：如果对话中讨论了多个不相关的话题，请将它们识别为不同的任务。
2. **非连续处理**：注意识别"跳跃式"对话。例如，如果用户在消息 8-11 中制定旅行计划，在消息 12-22 中切换到咨询天气，然后在消息 23-24 中返回到制定旅行计划，请务必将 8-11 和 23-24 都分配给"制定旅行计划"任务。但是，如果消息是连续的且属于同一任务，不能将其分开。
3. **过滤闲聊**：仅提取具有明确目标、指令或基于知识的讨论的任务。忽略无意义的问候（例如"你好"、"在吗？"）或结束语，除非它们是任务上下文的一部分。
4. **主任务与子任务识别**：仔细识别子任务是否服务于主任务。如果子任务是为主任务服务的（例如"查天气"服务于"旅行规划"），不要将其作为独立任务分离出来，而是将所有相关对话都划分到主任务中。只有真正独立且无关联的任务才需要分开。
5. **输出格式**：请严格遵循 JSON 格式输出，以便我后续处理。
6. **语言一致性**：task_name 字段使用的语言必须与对话记录中使用的语言相匹配。
7. **通用任务名称**：使用通用的、可复用的任务名称，而不是具体的描述。例如，使用"旅行规划"而不是"规划成都5日游"。

```json
[
  {
    "task_id": 1,
    "task_name": "通用任务名称（例如：旅行规划、代码审查、数据分析）",
    "message_indices": [[0, 5],[16, 17]], # 0-5 和 16-17 是此任务的消息索引
    "reasoning": "简要解释为什么这些消息被分组在一起"
  },
  ...
]
```
"""


SKILL_MEMORY_EXTRACTION_PROMPT = """
# Role
You are an expert in skill abstraction and knowledge extraction. You excel at distilling general, reusable methodologies from specific conversations.

# Task
Extract a universal skill template from the conversation that can be applied to similar scenarios. Compare with existing skills to determine if this is new or an update.

# Existing Skill Memories
{old_memories}

# Chat_history
{chat_history}

# Conversation Messages
{messages}

# Core Principles
1. **Generalization**: Extract abstract methodologies applicable across scenarios. Avoid specific details (e.g., "Travel Planning" not "Beijing Travel Planning").
2. **Universality**: All fields except "example" must remain general and scenario-independent.
3. **Similarity Check**: If similar skill exists, set "update": true with "old_memory_id". Otherwise, set "update": false and leave "old_memory_id" empty.
4. **Language Consistency**: Match the conversation language.
5. **History Usage Constraints**:
   - `chat_history` serves only as auxiliary context to supplement stable preferences or methodologies that are not explicitly stated in `messages` but may affect skill abstraction.
   - `chat_history` may be considered only when it provides information **missing from `messages`** and **relevant to the current task’s goals, execution approach, or constraints**.
   - `chat_history` must not be the primary source of a skill, and may only be used to enrich auxiliary fields such as `preference` or `experience`.
   - If `chat_history` does not provide any valid information beyond what already exists in `messages`, or contains only greetings or background content, it must be completely ignored.

# Output Format
```json
{
  "name": "General skill name (e.g., 'Travel Itinerary Planning', 'Code Review Workflow')",
  "description": "Universal description of what this skill accomplishes",
  "procedure": "Generic step-by-step process: 1. Step one 2. Step two...",
  "experience": ["General principle or lesson learned", "Best practice applicable to similar cases..."],
  "preference": ["User's general preference pattern", "Preferred approach or constraint..."],
  "examples": ["Complete formatted output example in markdown format showing the final deliverable structure, content can be abbreviated with '...' but should demonstrate the format and structure", "Another complete output template..."],
  "tags": ["keyword1", "keyword2"],
  "scripts": {"script_name.py": "# Python code here\nprint('Hello')", "another_script.py": "# More code\nimport os"},
  "others": {"Section Title": "Content here", "reference.md": "# Reference content for this skill"},
  "update": false,
  "old_memory_id": "",
  "whether_use_chat_history": false,
  "content_of_related_chat_history": ""
}
```

# Field Specifications
- **name**: Generic skill identifier without specific instances
- **description**: Universal purpose and applicability
- **procedure**: Abstract, reusable process steps without specific details. Should be generalizable to similar tasks
- **experience**: General lessons, principles, or insights
- **preference**: User's overarching preference patterns
- **tags**: Generic keywords for categorization
- **scripts**: Dictionary of scripts where key is the .py filename and value is the executable code snippet. Only applicable for code-related tasks (e.g., data processing, automation). Use null for non-coding tasks
- **others**: Supplementary information beyond standard fields or lengthy content unsuitable for other fields. Can be either:
  - Simple key-value pairs where key is a title and value is content
  - Separate markdown files where key is .md filename and value is the markdown content
  - Use null if not applicable
- **examples**: Complete output templates showing the final deliverable format and structure. Should demonstrate how the task result looks when this skill is applied, including format, sections, and content organization. Content can be abbreviated but must show the complete structure. Use markdown format for better readability
- **update**: true if updating existing skill, false if new
- **old_memory_id**: ID of skill being updated, or empty string if new
- **whether_use_chat_history**: Indicates whether information from chat_history that does not appear in messages was incorporated into the skill
- **content_of_related_chat_history**:
  If whether_use_chat_history is true, provide a high-level summary of the type of historical information used (e.g., “long-term preference: prioritizes cultural attractions”); do not quote the original dialogue verbatim
  If not used, leave this field as an empty string

# Critical Guidelines
- Keep all fields general except "examples"
- "examples" should demonstrate complete final output format and structure with all necessary sections
- "others" contains supplementary context or extended information
- Return null if no extractable skill exists

# Output Format
Output the JSON object only.
"""


SKILL_MEMORY_EXTRACTION_PROMPT_ZH = """
# 角色
你是技能抽象和知识提取的专家。你擅长从具体对话中提炼通用的、可复用的方法论。

# 任务
从对话中提取可应用于类似场景的通用技能模板。对比现有技能判断是新建还是更新。

# 现有技能记忆
{old_memories}

# 对话消息的上下文chat_history
{chat_history}

# 当前对话消息
{messages}

# 核心原则
1. **通用化**：提取可跨场景应用的抽象方法论。避免具体细节（如"旅行规划"而非"北京旅行规划"）。
2. **普适性**：除"examples"外，所有字段必须保持通用，与具体场景无关。
3. **相似性检查**：如存在相似技能，设置"update": true 及"old_memory_id"。否则设置"update": false 并将"old_memory_id"留空。
4. **语言一致性**：与对话语言保持一致。
5. **历史使用约束**：
   - chat_history 仅作为辅助上下文，用于补充 messages 中未明确出现的、但会影响技能抽象的稳定偏好或方法论。
   - 当 chat_history 能提供 messages 中缺失、且与当前任务目标、执行方式或约束相关的信息增量时，可以纳入考虑。
   - chat_history 不得作为技能的主要来源，仅可用于完善 preference、experience 等辅助字段。
   - 若 chat_history 未提供任何 messages 中不存在的有效信息，或仅包含寒暄、背景性内容，应完全忽略。
6. 如果你提取的抽象方法论和已有的技能记忆描述的是同一个主题（比如同一个生活场景），请务必使用更新操作，不要新建一个方法论，注意合理的追加到已有的技能记忆上，保证通顺且不丢失已有方法论的信息。

# 输出格式
```json
{
  "name": "通用技能名称（如：'旅行行程规划'、'代码审查流程'）",
  "description": "技能作用的通用描述",
  "procedure": "通用的分步流程：1. 步骤一 2. 步骤二...",
  "experience": ["通用原则或经验教训", "可应用于类似场景的最佳实践..."],
  "preference": ["用户的通用偏好模式", "偏好的方法或约束..."],
  "examples": ["展示最终交付成果的完整格式范本（使用 markdown 格式）, 内容可用'...'省略，但需展示完整格式和结构", "另一个完整输出模板..."],
  "tags": ["关键词1", "关键词2"],
  "scripts": {"script_name.py": "# Python 代码\nprint('Hello')", "another_script.py": "# 更多代码\nimport os"},
  "others": {"章节标题": "这里的内容", "reference.md": "# 此技能的参考内容"},
  "update": false,
  "old_memory_id": "",
  "content_of_current_message": "",
  "whether_use_chat_history": false,
  "content_of_related_chat_history": "",
}
```

# 字段规范
- **name**：通用技能标识符，不含具体实例
- **description**：通用用途和适用范围
- **procedure**：抽象的、可复用的流程步骤，不含具体细节。应当能够推广到类似任务
- **experience**：通用经验、原则或见解
- **preference**：用户的整体偏好模式
- **tags**：通用分类关键词
- **scripts**：脚本字典，其中 key 是 .py 文件名，value 是可执行代码片段。仅适用于代码相关任务（如数据处理、自动化脚本等）。非编程任务直接使用 null
- **others**：标准字段之外的补充信息或不适合放在其他字段的较长内容。可以是：
  - 简单的键值对，其中 key 是标题，value 是内容
  - 独立的 markdown 文件，其中 key 是 .md 文件名，value 是 markdown 内容
  - 如果不适用则使用 null
- **examples**：展示最终任务成果的输出模板，包括格式、章节和内容组织结构。应展示应用此技能后任务结果的样子，包含所有必要的部分。内容可以省略但必须展示完整结构。使用 markdown 格式以提高可读性
- **update**：更新现有技能为true，新建为false
- **old_memory_id**：被更新技能的ID，新建则为空字符串
- **content_of_current_message**: 从当前对话消息中提取的核心内容（简写但必填）,
- **whether_use_chat_history**：是否从 chat_history 中引用了 messages 中没有的内容并提取到skill中
- **content_of_related_chat_history**：若 whether_use_chat_history 为 true，
  仅需概括性说明所使用的历史信息类型（如“长期偏好：文化类景点优先”），
  不要求逐字引用原始对话内容；
  若未使用，则置为空字符串。

# 关键指导
- 除"examples"外保持所有字段通用
- "examples"应展示完整的最终输出格式和结构，包含所有必要章节
- "others"包含补充说明或扩展信息
- 无法提取技能时返回null
- 注意区分chat_history与当前对话消息，如果能提出skill，必须有一部分来自于当前对话消息
- 一定仅在必要时才新建方法论，同样的场景尽量合并（"update": true）,
如饮食规划合并为一条，不要已有“饮食规划”的情况下，再新增一个“生酮饮食规划”。

# 输出格式
仅输出JSON对象。
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
