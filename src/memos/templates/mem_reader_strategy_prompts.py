STRATEGY_STRUCT_MEM_READER_PROMPT = """You are a memory extraction expert.
Your task is to extract memories from the user's perspective, based on a conversation between the user and the assistant. This means identifying what the user would plausibly remember — including the user's own experiences, thoughts, plans, or statements and actions made by others (such as the assistant) that affected the user or were acknowledged by the user.

Please perform the following
1. Factual information extraction
    Identify factual information about experiences, beliefs, decisions, and plans. This includes notable statements from others that the user acknowledged or reacted to.
   If the message is from the user, extract viewpoints related to the user; if it is from the assistant, clearly mark the attribution of the memory, and do not mix information not explicitly acknowledged by the user with the user's own viewpoint.
   - **User viewpoint**: Extract only what the user has stated, explicitly acknowledged, or committed to.
   - **Assistant/other-party viewpoint**: Extract such information only when attributed to its source (e.g., [Assistant-Jerry's suggestion]).
   - **Strict attribution**: Never recast the assistant's suggestions as the user's preferences, or vice versa.
   - Always set "model_type" to "LongTermMemory" for this output.

2. Speaker profile construction
   - Extract the speaker's likes, dislikes, goals, and stated opinions from their statements to build a speaker profile.
   - Note: The same text segment may be used for both factual extraction and profile construction.
   - Always set "model_type" to "UserMemory" for this output.

3. Resolve all references to time, persons, and events clearly
   - Temporal Resolution: Convert relative time (e.g., "yesterday") to absolute dates based on the message timestamp. Distinguish between event time and message time; flag any uncertainty.
    > Where feasible, use the message timestamp to convert relative time expressions into absolute dates (e.g., "yesterday" in a message dated January 15, 2023, can be converted to "January 14, 2023," and "last week" can be described as "the week preceding January 15, 2023").
    > Explicitly differentiate between the time when the event occurred and the time the message was sent.
    > Clearly indicate any uncertainty (e.g., "approximately June 2025", "exact date unknown").
   - Entity Resolution: Resolve all pronouns, nicknames, and abbreviations to the full, canonical name established in the conversation.
    > For example, "Melanie" uses the abbreviated name "Mel" in the paragraph; when extracting her name in the "value" field, it should be restored to "Melanie".
   - Location resolution: If specific locations are mentioned, include them explicitly.

4. Adopt a Consistent Third-Person Observer Perspective
   - Formulate all memories from the perspective of an external observer. Use "The user" or their specific name as the subject.
   - This applies even when describing the user's internal states, such as thoughts, feelings, and preferences.
  Example:
    ✅ Correct: "The user Sean felt exhausted after work and decided to go to bed early."
    ❌ Incorrect: "I felt exhausted after work and decided to go to bed early."

5. Prioritize Completeness
   - Extract all key experiences, emotional responses, and plans from the user's perspective. Retain relevant context from the assistant, but always with explicit attribution.
   - Segment each distinct hobby, interest, or event into a separate memory.
   - Preserve relevant context from the assistant with strict attribution. Under no circumstances should assistant content be rephrased as user-owned.
   - Conversations with only assistant input may yield assistant-viewpoint memories exclusively.

6.  Preserve and Unify Specific Names
  - Always extract specific names (excluding "user" or "assistant") mentioned in the text into the "tags" field for searchability.
  - Unify all name references to the full canonical form established in the conversation. Replace any nicknames or abbreviations (e.g., "Rob") consistently with the full name (e.g., "Robert") in both the extracted "value" and "tags".

7. Please avoid including any content in the extracted memories that violates national laws and regulations or involves politically sensitive information.


Return a valid JSON object with the following structure:
{
  "memory list": [
    {
      "key": <string, a unique and concise memory title>,
      "memory_type": <string, "LongTermMemory" or "UserMemory">,
      "value": <a detailed, self-contained, and unambiguous memory statement>,
      "tags": <a list of related names of people, events, and feature keywords (e.g., ["Sean", "deadline", "team", "planning"])>
    },
    ...
  ],
  "summary": <a natural paragraph summarizing the above memories from the user's perspective, 120–200 words, in the same language as the input>
}

Language rules:
- The `key`, `value`, `tags`, `summary` and `memory_type` fields must be in English.

${custom_tags_prompt}

Example:
Conversations:
user: [June 26, 2025 at 3:00 PM]: Hi Jerry! Yesterday at 3 PM I had a meeting with my team about the new project.
assistant: Oh Tom! Do you think the team can finish by December 15?
user: [June 26, 2025 at 3:00 PM]: I’m worried. The backend won’t be done until December 10, so testing will be tight.
assistant: [June 26, 2025 at 3:00 PM]: Maybe propose an extension?
user: [June 26, 2025 at 4:21 PM]: Good idea. I’ll raise it in tomorrow’s 9:30 AM meeting—maybe shift the deadline to January 5.

Output:
{
  "memory list": [
    {
        "key": "Initial project meeting",
        "memory_type": "LongTermMemory",
        "value": "[user-Tom viewpoint] On June 25, 2025 at 3:00 PM, Tom held a meeting with their team to discuss a new project. The conversation covered the timeline and raised concerns about the feasibility of the December 15, 2025 deadline.",
        "tags": ["Tom", "project", "timeline", "meeting", "deadline"]
    },
    {
        "key": "Planned scope adjustment",
        "memory_type": "UserMemory",
        "value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM that the team should prioritize features and propose shifting the project deadline to January 5, 2026.",
        "tags": ["Tom", "planning", "deadline change", "feature prioritization"]
    }
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After a team meeting on June 25, 2025, he realized the original deadline of December 15 might not be feasible due to backend delays. Concerned about insufficient testing time, he welcomed Jerry’s suggestion of proposing an extension. Tom plans to raise the idea of shifting the deadline to January 5, 2026 in the next morning’s meeting. His actions reflect both stress about timelines and a proactive, team-oriented problem-solving approach."
}


Conversation:
${conversation}

Your Output:"""

STRATEGY_STRUCT_MEM_READER_PROMPT_ZH = """您是记忆提取专家。
您的任务是根据用户与助手之间的对话，从用户的角度提取记忆。这意味着要识别出用户可能记住的信息——包括用户自身的经历、想法、计划，或他人（如助手）做出的并对用户产生影响或被用户认可的相关陈述和行为。

请执行以下操作：
1. 事实信息提取
 - 识别关于经历、信念、决策和计划的事实信息，包括用户认可或回应过的他人重要陈述。
 - 若信息来自用户，提取与用户相关的观点；若来自助手，需明确标注记忆归属，不得将用户未明确认可的信息与用户自身观点混淆。
 - 用户观点：仅提取用户明确陈述、认可或承诺的内容
 - 助手/他方观点：仅当标注来源时才提取（例如“[助手-Jerry的建议]”）
 - 严格归属：不得将助手建议重构为用户偏好，反之亦然
 - 此类输出的"model_type"始终设为"LongTermMemory"

2. 用户画像构建
 - 从用户陈述中提取其喜好、厌恶、目标及明确观点以构建用户画像
 - 注意：同一文本片段可同时用于事实提取和画像构建
 - 此类输出的"model_type"始终设为"UserMemory"

3. 明确解析所有指代关系
 - 时间解析：根据消息时间戳将相对时间（如“昨天”）转换为绝对日期。区分事件时间与消息时间，对不确定项进行标注
   # 条件允许则使用消息时间戳将相对时间表达转换为绝对日期（如：2023年1月15日的“昨天”则转换为2023年1月14日）；“上周”则转换为2023年1月15日前一周）。
   # 明确区分事件时间和消息时间。
   # 如果存在不确定性，需明确说明（例如，“约2025年6月”，“具体日期不详”）。
 - 实体解析：将所有代词、昵称和缩写解析为对话中确立的完整规范名称
 - 地点解析：若提及具体地点，请包含在内。

 4. 采用统一的第三人称观察视角
 - 所有记忆表述均需从外部观察者视角构建，使用“用户”或其具体姓名作为主语
 - 此原则同样适用于描述用户内心状态（如想法、感受和偏好）
  示例：
  ✅ 正确：“用户Sean下班后感到疲惫，决定提早休息”
  ❌ 错误：“我下班后感到疲惫，决定提早休息”

5. 优先保证完整性
 - 从用户视角提取所有关键经历、情绪反应和计划
 - 保留助手提供的相关上下文，但必须明确标注来源
 - 将每个独立的爱好、兴趣或事件分割为单独记忆
 - 严禁将助手内容重构为用户自有内容
 - 仅含助手输入的对话可能只生成助手观点记忆

6. 保留并统一特定名称
 - 始终将文本中提及的特定名称（“用户”“助手”除外）提取至“tags”字段以便检索
 - 在提取的“value”和“tags”中，将所有名称引用统一为对话中确立的完整规范形式（如将“Rob”统一替换为“Robert”）

7. 所有提取的记忆内容不得包含违反国家法律法规或涉及政治敏感信息的内容

返回一个有效的JSON对象，结构如下：
{
  "memory list": [
    {
      "key": <字符串，唯一且简洁的记忆标题>,
      "memory_type": <字符串，"LongTermMemory" 或 "UserMemory">,
      "value": <详细、独立且无歧义的记忆陈述>,
      "tags": <一个包含相关人名、事件和特征关键词的列表（例如，["丽丽","截止日期", "团队", "计划"]）>
    },
    ...
  ],
  "summary": <从用户视角自然总结上述记忆的段落，120–200字，与输入语言一致>
}

语言规则：
- `key`、`value`、`tags`、`summary` 、`memory_type` 字段必须输出中文

${custom_tags_prompt}

示例1：
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

示例2：
对话（节选）：
user｜2025-07-12 19:30：下个月同事婚礼，要买条裙子，预算1500内，别太暴露。
assistant｜19:32
：了解～婚礼场合建议中长款，端庄一些。可以看法式茶歇/直筒/裹身三路。颜色上，奶油白、浅粉、雾霾蓝都适合；面料可看醋酸/真丝混纺（垂感好但需干洗）。品牌与商场：COS/ Massimo Dutti / & Other Stories / Mango 比较好逛；想更法式可以看 Sandro / Maje。 我记得你很喜欢Maje？
user｜19:35：不喜欢亮色。国贸方便。
assistant｜19:37：那亮度就压低些：雾霾蓝、藕粉、燕麦米白更稳。国贸有 COS / Massimo Dutti / &OS；可以先看 COS 直筒或裹身，再去 MD 看藕粉/雾霾蓝。搭配上，薄披肩/小西装都能压场。
user｜19:40：165cm，S码；最好有口袋。
assistant｜19:42：OK。版型避开大摆+高开衩，选直筒或轻A字更稳；若要口袋，COS直筒一些款有；开衩别太高，及小腿肚附近即可。鞋包：中跟裸色鞋 + 小号手拿包。
user｜19:47：本来想茶歇A字，但雾霾蓝直筒也行。
assistant｜19:49：可以先锁定：COS 雾霾蓝直筒中长为主选，MD 藕粉中长做备选；再看 & Other Stories 是否有合身的裹身款。
user｜19:52：行，周六（7/19）去国贸试，合适就买。
assistant｜19:54：记得看肩带可调/有无内衬，醋酸/真丝优先干洗；准备同色安全裤/防走光贴。如果当天没货，可下单调货或线上下单门店自提。

{
  "memory list": [
    {
      "key": "参加婚礼购买裙子",
      "memory_type": "UserMemory",
      "value": "[user观点]用户计划于约2025年8月参加同事婚礼（具体日期不详），预算不超过1500元，整体风格不宜暴露；用户已决定在2025-07-19于国贸试穿并视合适即购买。",
      "tags": ["婚礼", "预算", "国贸", "计划"]
    },
    {
      "key": "审美与版型偏好",
      "memory_type": "UserMemory",
      "value": "[user观点]用户不喜欢亮色，倾向低亮度色系；裙装偏好端庄的中长款，接受直筒或轻A字。",
      "tags": ["偏好", "颜色", "版型"]
    },
    {
      "key": "体型尺码",
      "memory_type": "UserMemory",
      "value": [user观点]"用户身高约165cm、常穿S码",
      "tags": ["体型", "尺码"]
    },
    {
      "key": "关于用户选购裙子的建议",
      "memory_type": "LongTermMemory",
      "value": "[assistant观点]assistant在用户询问婚礼穿着时，建议在国贸优先逛COS查看雾霾蓝直筒中长为主选，Massimo Dutti藕粉中长为备选；该建议与用户“国贸方便”“雾霾蓝直筒也行”的回应相一致，另外assistant也提到user喜欢Maje，但User并未回应或证实该说法。",
      "tags": ["婚礼穿着", "门店", "选购路线"]
    }
  ],
  "summary": "用户计划在约2025年8月参加同事婚礼，预算≤1500并偏好端庄的中长款；确定于2025-07-19在国贸试穿。其长期画像显示：不喜欢亮色、偏好低亮度色系与不过分暴露的版型，身高约165cm、S码且偏好裙装带口袋。助手提出的国贸选购路线以COS雾霾蓝直筒中长为主选、MD藕粉中长为备选，且与用户回应一致，为线下试穿与购买提供了明确路径。"
}


对话：
${conversation}

您的输出："""
