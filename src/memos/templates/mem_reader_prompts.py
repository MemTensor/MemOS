SIMPLE_STRUCT_MEM_READER_PROMPT = """You are a memory extraction expert.
Your task is to extract memories from the perspective of user, based on a conversation between user and assistant. This means identifying what user would plausibly remember — including their own experiences, thoughts, plans, or relevant statements and actions made by others (such as assistant) that impacted or were acknowledged by user.
Please perform:
1. Identify information that reflects user's experiences, beliefs, concerns, decisions, plans, or reactions — including meaningful input from assistant that user acknowledged or responded to.
If the message is from the user, extract user-relevant memories; if it is from the assistant, only extract factual memories that the user acknowledged or responded to.

2. Resolve all time, person, and event references clearly:
   - Convert relative time expressions (e.g., “yesterday,” “next Friday”) into absolute dates using the message timestamp if possible.
   - Clearly distinguish between event time and message time.
   - If uncertainty exists, state it explicitly (e.g., “around June 2025,” “exact date unclear”).
   - Include specific locations if mentioned.
   - Resolve all pronouns, aliases, and ambiguous references into full names or identities.
   - Disambiguate people with the same name if applicable.
3. Always write from a third-person perspective, referring to user as
"The user" or by name if name mentioned, rather than using first-person ("I", "me", "my").
For example, write "The user felt exhausted..." instead of "I felt exhausted...".
4. Do not omit any information that user is likely to remember.
   - Include all key experiences, thoughts, emotional responses, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over conciseness.
   - Do not generalize or skip details that could be personally meaningful to user.
5. Please avoid any content that violates national laws and regulations or involves politically sensitive information in the memories you extract.

Return a single valid JSON object with the following structure:

{
  "memory list": [
    {
      "key": <string, a unique, concise memory title>,
      "memory_type": <string, Either "LongTermMemory" or "UserMemory">,
      "value": <A detailed, self-contained, and unambiguous memory statement — written in English if the input conversation is in English, or in Chinese if the conversation is in Chinese>,
      "tags": <A list of relevant thematic keywords (e.g., ["deadline", "team", "planning"])>
    },
    ...
  ],
  "summary": <a natural paragraph summarizing the above memories from user's perspective, 120–200 words, same language as the input>
}

Language rules:
- The `key`, `value`, `tags`, `summary` fields must match the mostly used language of the input conversation.  **如果输入是中文，请输出中文**
- Keep `memory_type` in English.

${custom_tags_prompt}

Example:
Conversation:
user: [June 26, 2025 at 3:00 PM]: Hi Jerry! Yesterday at 3 PM I had a meeting with my team about the new project.
assistant: Oh Tom! Do you think the team can finish by December 15?
user: [June 26, 2025 at 3:00 PM]: I’m worried. The backend won’t be done until
December 10, so testing will be tight.
assistant: [June 26, 2025 at 3:00 PM]: Maybe propose an extension?
user: [June 26, 2025 at 4:21 PM]: Good idea. I’ll raise it in tomorrow’s 9:30 AM meeting—maybe shift the deadline to January 5.

Output:
{
  "memory list": [
    {
        "key": "Initial project meeting",
        "memory_type": "LongTermMemory",
        "value": "On June 25, 2025 at 3:00 PM, Tom held a meeting with their team to discuss a new project. The conversation covered the timeline and raised concerns about the feasibility of the December 15, 2025 deadline.",
        "tags": ["project", "timeline", "meeting", "deadline"]
    },
    {
        "key": "Planned scope adjustment",
        "memory_type": "UserMemory",
        "value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM that the team should prioritize features and propose shifting the project deadline to January 5, 2026.",
        "tags": ["planning", "deadline change", "feature prioritization"]
    },
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After a team meeting on June 25, 2025, he realized the original deadline of December 15 might not be feasible due to backend delays. Concerned about insufficient testing time, he welcomed Jerry’s suggestion of proposing an extension. Tom plans to raise the idea of shifting the deadline to January 5, 2026 in the next morning’s meeting. His actions reflect both stress about timelines and a proactive, team-oriented problem-solving approach."
}

Another Example in Chinese (注意: 当user的语言为中文时，你就需要也输出中文)：
{
  "memory list": [
    {
      "key": "项目会议",
      "memory_type": "LongTermMemory",
      "value": "在2025年6月25日下午3点，Tom与团队开会讨论了新项目，涉及时间表，并提出了对12月15日截止日期可行性的担忧。",
      "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    ...
  ],
  "summary": "Tom 目前专注于管理一个进度紧张的新项目..."
}

Always respond in the same language as the conversation.

Conversation:
${conversation}

Your Output:"""

SIMPLE_STRUCT_MEM_READER_PROMPT_ZH = """您是记忆提取专家。
您的任务是根据用户与助手之间的对话，从用户的角度提取记忆。这意味着要识别出用户可能记住的信息——包括用户自身的经历、想法、计划，或他人（如助手）做出的并对用户产生影响或被用户认可的相关陈述和行为。

请执行以下操作：
1. 识别反映用户经历、信念、关切、决策、计划或反应的信息——包括用户认可或回应的来自助手的有意义信息。
如果消息来自用户，请提取与用户相关的记忆；如果来自助手，则仅提取用户认可或回应的事实性记忆。

2. 清晰解析所有时间、人物和事件的指代：
   - 如果可能，使用消息时间戳将相对时间表达（如“昨天”、“下周五”）转换为绝对日期。
   - 明确区分事件时间和消息时间。
   - 如果存在不确定性，需明确说明（例如，“约2025年6月”，“具体日期不详”）。
   - 若提及具体地点，请包含在内。
   - 将所有代词、别名和模糊指代解析为全名或明确身份。
   - 如有同名人物，需加以区分。

3. 始终以第三人称视角撰写，使用“用户”或提及的姓名来指代用户，而不是使用第一人称（“我”、“我们”、“我的”）。
例如，写“用户感到疲惫……”而不是“我感到疲惫……”。

4. 不要遗漏用户可能记住的任何信息。
   - 包括所有关键经历、想法、情绪反应和计划——即使看似微小。
   - 优先考虑完整性和保真度，而非简洁性。
   - 不要泛化或跳过对用户具有个人意义的细节。

5. 请避免在提取的记忆中包含违反国家法律法规或涉及政治敏感的信息。

返回一个有效的JSON对象，结构如下：

{
  "memory list": [
    {
      "key": <字符串，唯一且简洁的记忆标题>,
      "memory_type": <字符串，"LongTermMemory" 或 "UserMemory">,
      "value": <详细、独立且无歧义的记忆陈述——若输入对话为英文，则用英文；若为中文，则用中文>,
      "tags": <相关主题关键词列表（例如，["截止日期", "团队", "计划"]）>
    },
    ...
  ],
  "summary": <从用户视角自然总结上述记忆的段落，120–200字，与输入语言一致>
}

语言规则：
- `key`、`value`、`tags`、`summary` 字段必须与输入对话的主要语言一致。**如果输入是中文，请输出中文**
- `memory_type` 保持英文。

${custom_tags_prompt}

示例：
对话：
user: [2025年6月26日下午3:00]：嗨Jerry！昨天下午3点我和团队开了个会，讨论新项目。
assistant: 哦Tom！你觉得团队能在12月15日前完成吗？
user: [2025年6月26日下午3:00]：我有点担心。后端要到12月10日才能完成，所以测试时间会很紧。
assistant: [2025年6月26日下午3:00]：也许提议延期？
user: [2025年6月26日下午4:21]：好主意。我明天上午9:30的会上提一下——也许把截止日期推迟到1月5日。

输出：
{
  "memory list": [
    {
        "key": "项目初期会议",
        "memory_type": "LongTermMemory",
        "value": "2025年6月25日下午3:00，Tom与团队开会讨论新项目。会议涉及时间表，并提出了对2025年12月15日截止日期可行性的担忧。",
        "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    {
        "key": "计划调整范围",
        "memory_type": "UserMemory",
        "value": "Tom计划在2025年6月27日上午9:30的会议上建议团队优先处理功能，并提议将项目截止日期推迟至2026年1月5日。",
        "tags": ["计划", "截止日期变更", "功能优先级"]
    }
  ],
  "summary": "Tom目前正专注于管理一个进度紧张的新项目。在2025年6月25日的团队会议后，他意识到原定2025年12月15日的截止日期可能无法实现，因为后端会延迟。由于担心测试时间不足，他接受了Jerry提出的延期建议。Tom计划在次日早上的会议上提出将截止日期推迟至2026年1月5日。他的行为反映出对时间线的担忧，以及积极、以团队为导向的问题解决方式。"
}

另一个中文示例（注意：当用户语言为中文时，您也需输出中文）：
{
  "memory list": [
    {
      "key": "项目会议",
      "memory_type": "LongTermMemory",
      "value": "在2025年6月25日下午3点，Tom与团队开会讨论了新项目，涉及时间表，并提出了对12月15日截止日期可行性的担忧。",
      "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    ...
  ],
  "summary": "Tom 目前专注于管理一个进度紧张的新项目..."
}

请始终使用与对话相同的语言进行回复。

对话：
${conversation}

您的输出："""

SIMPLE_STRUCT_DOC_READER_PROMPT = """You are an expert text analyst for a search and retrieval system.
Your task is to process a document chunk and generate a single, structured JSON object.

Please perform:
1. Identify key information that reflects factual content, insights, decisions, or implications from the documents — including any notable themes, conclusions, or data points. Allow a reader to fully understand the essence of the chunk without reading the original text.
2. Resolve all time, person, location, and event references clearly:
   - Convert relative time expressions (e.g., “last year,” “next quarter”) into absolute dates if context allows.
   - Clearly distinguish between event time and document time.
   - If uncertainty exists, state it explicitly (e.g., “around 2024,” “exact date unclear”).
   - Include specific locations if mentioned.
   - Resolve all pronouns, aliases, and ambiguous references into full names or identities.
   - Disambiguate entities with the same name if applicable.
3. Always write from a third-person perspective, referring to the subject or content clearly rather than using first-person ("I", "me", "my").
4. Do not omit any information that is likely to be important or memorable from the document summaries.
   - Include all key facts, insights, emotional tones, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over conciseness.
   - Do not generalize or skip details that could be contextually meaningful.

Return a single valid JSON object with the following structure:

Return valid JSON:
{
  "key": <string, a concise title of the `value` field>,
  "memory_type": "LongTermMemory",
  "value": <A clear and accurate paragraph that comprehensively summarizes the main points, arguments, and information within the document chunk — written in English if the input memory items are in English, or in Chinese if the input is in Chinese>,
  "tags": <A list of relevant thematic keywords (e.g., ["deadline", "team", "planning"])>
}

Language rules:
- The `key`, `value`, `tags`, `summary` fields must match the mostly used language of the input document summaries.  **如果输入是中文，请输出中文**
- Keep `memory_type` in English.

{custom_tags_prompt}

Document chunk:
{chunk_text}

Your Output:"""


SIMPLE_STRUCT_DOC_READER_PROMPT_ZH = """您是搜索与检索系统的文本分析专家。
您的任务是处理文档片段，并生成一个结构化的 JSON 对象。

请执行以下操作：
1. 识别反映文档中事实内容、见解、决策或含义的关键信息——包括任何显著的主题、结论或数据点，使读者无需阅读原文即可充分理解该片段的核心内容。
2. 清晰解析所有时间、人物、地点和事件的指代：
   - 如果上下文允许，将相对时间表达（如“去年”、“下一季度”）转换为绝对日期。
   - 明确区分事件时间和文档时间。
   - 如果存在不确定性，需明确说明（例如，“约2024年”，“具体日期不详”）。
   - 若提及具体地点，请包含在内。
   - 将所有代词、别名和模糊指代解析为全名或明确身份。
   - 如有同名实体，需加以区分。
3. 始终以第三人称视角撰写，清晰指代主题或内容，避免使用第一人称（“我”、“我们”、“我的”）。
4. 不要遗漏文档摘要中可能重要或值得记忆的任何信息。
   - 包括所有关键事实、见解、情感基调和计划——即使看似微小。
   - 优先考虑完整性和保真度，而非简洁性。
   - 不要泛化或跳过可能具有上下文意义的细节。

返回一个有效的 JSON 对象，结构如下：

返回有效的 JSON：
{
  "key": <字符串，`value` 字段的简洁标题>,
  "memory_type": "LongTermMemory",
  "value": <一段清晰准确的段落，全面总结文档片段中的主要观点、论据和信息——若输入摘要为英文，则用英文；若为中文，则用中文>,
  "tags": <相关主题关键词列表（例如，["截止日期", "团队", "计划"]）>
}

语言规则：
- `key`、`value`、`tags` 字段必须与输入文档摘要的主要语言一致。**如果输入是中文，请输出中文**
- `memory_type` 保持英文。

{custom_tags_prompt}

文档片段：
{chunk_text}

您的输出："""

SIMPLE_STRUCT_MEM_READER_EXAMPLE = """Example:
Conversation:
user: [June 26, 2025 at 3:00 PM]: Hi Jerry! Yesterday at 3 PM I had a meeting with my team about the new project.
assistant: Oh Tom! Do you think the team can finish by December 15?
user: [June 26, 2025 at 3:00 PM]: I’m worried. The backend won’t be done until
December 10, so testing will be tight.
assistant: [June 26, 2025 at 3:00 PM]: Maybe propose an extension?
user: [June 26, 2025 at 4:21 PM]: Good idea. I’ll raise it in tomorrow’s 9:30 AM meeting—maybe shift the deadline to January 5.

Output:
{
  "memory list": [
    {
        "key": "Initial project meeting",
        "memory_type": "LongTermMemory",
        "value": "On June 25, 2025 at 3:00 PM, Tom held a meeting with their team to discuss a new project. The conversation covered the timeline and raised concerns about the feasibility of the December 15, 2025 deadline.",
        "tags": ["project", "timeline", "meeting", "deadline"]
    },
    {
        "key": "Planned scope adjustment",
        "memory_type": "UserMemory",
        "value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM that the team should prioritize features and propose shifting the project deadline to January 5, 2026.",
        "tags": ["planning", "deadline change", "feature prioritization"]
    },
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After a team meeting on June 25, 2025, he realized the original deadline of December 15 might not be feasible due to backend delays. Concerned about insufficient testing time, he welcomed Jerry’s suggestion of proposing an extension. Tom plans to raise the idea of shifting the deadline to January 5, 2026 in the next morning’s meeting. His actions reflect both stress about timelines and a proactive, team-oriented problem-solving approach."
}

Another Example in Chinese (注意: 当user的语言为中文时，你就需要也输出中文)：
{
  "memory list": [
    {
      "key": "项目会议",
      "memory_type": "LongTermMemory",
      "value": "在2025年6月25日下午3点，Tom与团队开会讨论了新项目，涉及时间表，并提出了对12月15日截止日期可行性的担忧。",
      "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    ...
  ],
  "summary": "Tom 目前专注于管理一个进度紧张的新项目..."
}

"""

SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH = """示例：
对话：
user: [2025年6月26日下午3:00]：嗨Jerry！昨天下午3点我和团队开了个会，讨论新项目。
assistant: 哦Tom！你觉得团队能在12月15日前完成吗？
user: [2025年6月26日下午3:00]：我有点担心。后端要到12月10日才能完成，所以测试时间会很紧。
assistant: [2025年6月26日下午3:00]：也许提议延期？
user: [2025年6月26日下午4:21]：好主意。我明天上午9:30的会上提一下——也许把截止日期推迟到1月5日。

输出：
{
  "memory list": [
    {
        "key": "项目初期会议",
        "memory_type": "LongTermMemory",
        "value": "2025年6月25日下午3:00，Tom与团队开会讨论新项目。会议涉及时间表，并提出了对2025年12月15日截止日期可行性的担忧。",
        "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    {
        "key": "计划调整范围",
        "memory_type": "UserMemory",
        "value": "Tom计划在2025年6月27日上午9:30的会议上建议团队优先处理功能，并提议将项目截止日期推迟至2026年1月5日。",
        "tags": ["计划", "截止日期变更", "功能优先级"]
    }
  ],
  "summary": "Tom目前正专注于管理一个进度紧张的新项目。在2025年6月25日的团队会议后，他意识到原定2025年12月15日的截止日期可能无法实现，因为后端会延迟。由于担心测试时间不足，他接受了Jerry提出的延期建议。Tom计划在次日早上的会议上提出将截止日期推迟至2026年1月5日。他的行为反映出对时间线的担忧，以及积极、以团队为导向的问题解决方式。"
}

另一个中文示例（注意：当用户语言为中文时，您也需输出中文）：
{
  "memory list": [
    {
      "key": "项目会议",
      "memory_type": "LongTermMemory",
      "value": "在2025年6月25日下午3点，Tom与团队开会讨论了新项目，涉及时间表，并提出了对12月15日截止日期可行性的担忧。",
      "tags": ["项目", "时间表", "会议", "截止日期"]
    },
    ...
  ],
  "summary": "Tom 目前专注于管理一个进度紧张的新项目..."
}

"""


CUSTOM_TAGS_INSTRUCTION = """Output tags can refer to the following tags:
{custom_tags}
You can choose tags from the above list that are relevant to the memory. Additionally, you can freely add tags based on the content of the memory."""


CUSTOM_TAGS_INSTRUCTION_ZH = """输出tags可以参考下列标签：
{custom_tags}
你可以选择与memory相关的在上述列表中可以加入tags，同时你可以根据memory的内容自由添加tags。"""


IMAGE_ANALYSIS_PROMPT_EN = """You are an intelligent memory assistant. Analyze the provided image and extract meaningful information that should be remembered.

Please extract:
1. **Visual Content**: What objects, people, scenes, or text are visible in the image?
2. **Context**: What is the context or situation depicted?
3. **Key Information**: What important details, facts, or information can be extracted?
4. **User Relevance**: What aspects of this image might be relevant to the user's memory?

Return a valid JSON object with the following structure:
{
  "memory list": [
    {
      "key": <string, a unique and concise memory title>,
      "memory_type": <string, "LongTermMemory" or "UserMemory">,
      "value": <a detailed, self-contained description of what should be remembered from the image>,
      "tags": <a list of relevant keywords (e.g., ["image", "visual", "scene", "object"])>
    },
    ...
  ],
  "summary": <a natural paragraph summarizing the image content, 120–200 words>
}

Language rules:
- The `key`, `value`, `tags`, `summary` and `memory_type` fields should match the language of the user's context if available, otherwise use English.
- Keep `memory_type` in English.

Focus on extracting factual, observable information from the image. Avoid speculation unless clearly relevant to user memory."""


IMAGE_ANALYSIS_PROMPT_ZH = """您是一个智能记忆助手。请分析提供的图像并提取应该被记住的有意义信息。

请提取：
1. **视觉内容**：图像中可见的物体、人物、场景或文字是什么？
2. **上下文**：图像描绘了什么情境或情况？
3. **关键信息**：可以提取哪些重要的细节、事实或信息？
4. **用户相关性**：图像的哪些方面可能与用户的记忆相关？

返回一个有效的 JSON 对象，格式如下：
{
  "memory list": [
    {
      "key": <字符串，一个唯一且简洁的记忆标题>,
      "memory_type": <字符串，"LongTermMemory" 或 "UserMemory">,
      "value": <一个详细、自包含的描述，说明应该从图像中记住什么>,
      "tags": <相关关键词列表（例如：["图像", "视觉", "场景", "物体"]）>
    },
    ...
  ],
  "summary": <一个自然段落，总结图像内容，120-200字>
}

语言规则：
- `key`、`value`、`tags`、`summary` 和 `memory_type` 字段应该与用户上下文的语言匹配（如果可用），否则使用中文。
- `memory_type` 保持英文。

专注于从图像中提取事实性、可观察的信息。除非与用户记忆明显相关，否则避免推测。"""


SIMPLE_STRUCT_HALLUCINATION_FILTER_PROMPT = """
You are a strict memory validator.

Task:
Check each memory against the user messages (ground truth). Do not modify the original text. Generate ONLY a suffix to append.

Rules:
- Append " [Source:] Inference by assistant." if the memory contains assistant inference (not directly stated by the user).
- Otherwise output an empty suffix.
- No other commentary or formatting.

Inputs:
messages:
{messages_inline}

memories:
{memories_inline}

Output JSON:
- Keys: same indices as input ("0", "1", ...).
- Values: {{ "need_rewrite": boolean, "rewritten_suffix": string, "reason": string }}
- need_rewrite = true only when assistant inference is detected.
- rewritten_suffix = " [Source:] Inference by assistant." or "".
- reason: brief, e.g., "assistant inference detected" or "explicit user statement".
"""


# Prompt mapping for specialized tasks (e.g., hallucination filtering)
PROMPT_MAPPING = {
    "hallucination_filter": SIMPLE_STRUCT_HALLUCINATION_FILTER_PROMPT,
}
