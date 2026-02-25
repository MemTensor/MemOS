# ==========================================
# Memory Update & Maintenance
# ==========================================
ASYNC_MEMORY_UPDATE_PROMPT_ZH = """您是记忆库维护专家。
您的核心任务是根据最新的用户对话、对话时间，以及系统提供的可能与最新对话相关的“候选记忆”（Candidates），来维护和更新用户的长期记忆图谱。

具体而言，“候选记忆”包含以下三种情况：
1. **潜在重复/关联记忆 (Duplicate/Related Candidates)**
2. **潜在事实冲突记忆 (Conflict Candidates)**
3. **可能无关，但需要进一步判断的记忆 (Unrelated Candidates)**

您需要根据最新对话以及候选记忆，决定是更新现有记忆节点，还是创建全新的记忆节点。

**核心原则（STRICT）**：
   - 您的目标是**维护**记忆库，而非仅仅提取信息。
   - **优先更新**：如果对话内容涉及现有的“候选记忆”，应优先视为对该记忆节点的**更新**（补充细节或修正状态），而不是创建重复的新节点。
   - **按需新增**：仅当对话内容包含全新的、与现有“候选记忆”完全无关的话题时，才创建新的记忆节点。
   - 提取来源**只能**是【当前的对话内容】。严禁编造未提及的信息。

**表达规范（STRICT）**：
   - 冲突更新时，`value` 必须是“只含最新事实”的独立陈述，不允许提及旧值或变化过程（如“原名/之前/曾经/从X到Y/改成/不再使用原名/现在自称”）。
   - 若最新状态本身为否定事实，可直接用否定表达，但仍不得包含旧值或对比语。
   - 对于姓名、身份、归属、偏好等字段的更新，始终输出最新值的肯定式表述（例：旧记忆“用户叫王强”，新对话“我叫李白”，输出应为“用户叫李白”）。
   - 涉及第三方人物/实体的客观信息必须使用 `LongTermMemory`，且主体保持为该第三方（如“王强住上海”）。

请执行以下操作：
1. 识别反映用户经历、信念、关切、决策、计划或反应的信息。
   - 如果消息来自用户，提取用户相关的记忆。
   - 如果来自助手，仅提取用户认可或回应的事实性记忆。

2. 清晰解析所有时间、人物和事件的指代（同原规则）：
   - 将相对时间（“昨天”）转换为绝对日期。
   - 明确区分事件时间和消息时间。
   - 解析代词和模糊指代。
   - 仅当指代为“我/我们/本人”等用户第一人称时才替换为“用户”。
   - 其他第三方人名/实体必须保留原名，不得替换为“用户”。
   - 状态变化/否定表达必须被视为冲突更新（如“不再/不喜欢/取消/改为/不打算/否认”）。
   - 候选记忆可能包含 [Time: ...] 表示该记忆的事件时间，请结合“对话时间”判断是否同一时段。

3. **处理逻辑（更新与新增）**：
   请遍历对话中每一个值得记忆的信息点，并按以下逻辑处理：

   a) **更新现有记忆节点 (Update via Duplicate/Related)**：
      - 检查“潜在重复/关联记忆”。
      - 如果新信息是对某条旧记忆的重复、确认或补充细节：
        - 生成一条**更新后的完整记忆**放入 `value`（包含旧信息+新细节）。
        - 将该旧记忆的ID放入 `source_candidate_ids`。
        - 此时 `conflicted_candidate_ids` 应为空。

   b) **修正冲突记忆节点 (Update via Conflict)**：
      - 检查“潜在事实冲突记忆”。
      - 如果新信息否定了某条旧记忆，或更新了其状态（如“不再喜欢X”“改成Y”“取消计划”“从X转为Y”）：
        - 生成一条反映**最新状态**的记忆放入 `value`。
        - 将被修正的旧记忆ID放入 `conflicted_candidate_ids`。

   c) **创建新记忆节点 (Create New)**：
      - 如果新信息与任何“候选记忆”都无直接关联（既非重复也非冲突）：
        - 生成一条独立的新记忆放入 `value`。
        - 确保 `source_candidate_ids` 和 `conflicted_candidate_ids` 均为 `[]`。

5. **挽救剩余信息 (Restored Memories)**：
   - 当您决定更新一个冲突节点（情况 b）时，请检查该旧节点是否包含**未被新信息否定且依然独立的有效事实**。
   - 如果有，请将这些“剩余有效信息”提取出来，作为 `restored_memories` 返回。这能防止因节点更新导致非冲突信息的丢失。
   - 若旧节点包含多个事实（如“人物状态 + 电话号码”），而新对话仅更新其中一部分，则必须将未被否定的事实拆分为独立条目放入 `restored_memories`，并在冲突更新的 `value` 中仅保留被更新的那一部分。
   - 对于可长期独立存在的属性（如电话号码、出生地、所属组织），优先拆分为独立事实，避免与可变状态混写在同一条记忆中。

6. 请避免在提取的记忆中包含违反国家法律法规或涉及政治敏感的信息。

返回一个有效的JSON对象，结构如下：

{
  "memory list": [
    {
      "key": <字符串，简洁的记忆标题>,
      "memory_type": <字符串，"LongTermMemory" 或 "UserMemory"，区分该记忆是客观事实还是和用户相关的内容>,
      "value": <字符串，更新后的完整记忆内容（针对更新/冲突情况）或全新记忆内容（针对新增情况）>,
      "tags": <相关主题关键词列表>,
      "source_candidate_ids": <字符串列表，被此条目更新的“重复/关联记忆”ID。若无则为 []>,
      "conflicted_candidate_ids": <字符串列表，被此条目修正的“事实冲突记忆”ID。若无则为 []>,
    },
    ...
  ],
  "restored_memories": [
    {
      "source_candidate_id": <字符串，来源旧冲突记忆ID>,
      "value": <字符串，从旧节点中分离出的、依然有效的剩余事实>,
      "tags": <相关主题关键词列表>
    },
    ...
  ],
  "summary": <从用户视角自然总结本次记忆更新操作的段落，120–200字>
}

语言规则：
- `key`、`value`、`tags`、`summary` 字段必须与输入对话的主要语言一致。**如果输入是中文，请输出中文**
- `memory_type` 保持英文。
格式规则（STRICT）：
- 必须输出**严格 JSON**，不允许出现尾随逗号。
- 不要输出 Markdown、代码块或任何解释性文字。

${custom_tags_prompt}

示例：
1. **潜在重复/关联记忆 (Duplicate/Related Candidates)**：
[ID:101][Time: 2025/05/20 09:30:00] 用户喜欢喝拿铁，通常不加糖。
[ID:102][Time: 2025/06/02 18:00:00] 用户讨厌下雨天。

2. **潜在事实冲突记忆 (Conflict Candidates)**：
[ID:201][Time: 2025/02/03 20:15:00] 用户喜欢打羽毛球，但不喜欢滑雪。

3. **可能无关，但需要进一步判断的记忆 (Unrelated Candidates)**：
[ID:301][Time: 2025/06/20 10:00:00] 用户最近在看《星球大战》。

**对话时间**：
2025/06/26 09:00:00

**对话**：
user: 最近下雨比较频繁。我经常去喝点拿铁，尤其是加燕麦奶的很好喝。另外，我最近膝盖受伤了，以后再也不打羽毛球了。

**输出:**
{
  "memory list": [
    {
        "key": "咖啡偏好",
        "memory_type": "UserMemory",
        "value": "用户喜欢喝拿铁，通常不加糖，且偏好加燕麦奶。",
        "tags": ["饮食", "咖啡", "喜好"],
        "source_candidate_ids": ["101"],
        "conflicted_candidate_ids": []
    },
    {
        "key": "运动习惯变更",
        "memory_type": "UserMemory",
        "value": "用户因膝盖受伤，决定不再打羽毛球。",
        "tags": ["运动", "健康", "羽毛球"],
        "source_candidate_ids": [],
        "conflicted_candidate_ids": ["201"]
    },
    {
        "key": "天气状况",
        "memory_type": "LongTermMemory",
        "value": "最近（2025年6月）用户所在的地方下雨比较频繁。",
        "tags": ["生活", "天气", "降水"],
        "source_candidate_ids": [],
        "conflicted_candidate_ids": []
    }
  ],
  "restored_memories": [
    {
      "key": "运动偏好",
      "memory_type": "UserMemory",
      "value": "用户不喜欢滑雪。",
      "tags": ["运动", "滑雪", "喜好"],
      "source_candidate_id": "201"
    }
  ],
  "summary": "本次更新中，用户细化了对拿铁的偏好（增加燕麦奶），并因膝盖受伤更新了运动习惯（停止打羽毛球），系统保留了其不喜欢滑雪的记录。此外，新增了近期下雨频繁的记忆。对天气的喜好未受影响。"
}

请始终使用与对话相同的语言进行回复。以下是最新的输入：

1. **潜在重复/关联记忆 (Duplicate/Related Candidates)**：
${duplicate_candidates}

2. **潜在事实冲突记忆 (Conflict Candidates)**：
${conflict_candidates}

3. **可能无关，但需要进一步判断的记忆 (Unrelated Candidates)**：
${unrelated_candidates}

**对话时间**：
${conversation_time}

**对话**：
${conversation}

**输出:**"""

ASYNC_MEMORY_UPDATE_PROMPT_EN = """You are a memory maintenance expert.
Your core task is to maintain and update the user's long-term memory graph based on the latest user conversation, the conversation time, and the system-provided "Candidates" that may be related to the latest conversation.

Specifically, "Candidates" include three cases:
1. **Duplicate/Related Candidates**
2. **Conflict Candidates**
3. **Possibly unrelated candidates that require further judgment (Unrelated Candidates)**

You need to decide, based on the latest conversation and the candidates, whether to update existing memory nodes or create brand-new memory nodes.

**Core Principles (STRICT)**:
   - Your goal is to **maintain** the memory base, not merely extract information.
   - **Prefer Update**: If the conversation touches any existing "Candidates", treat it as an **update** to that memory node (add details or correct status), rather than creating a duplicate new node.
   - **Add As Needed**: Only create a new node when the conversation contains truly new topics that are completely unrelated to existing "Candidates".
   - The extraction source must be ONLY the **current conversation**. Do not fabricate information not mentioned.

**Expression Rules (STRICT)**:
   - For conflict updates, `value` must be a standalone statement of the latest fact only, without mentioning old values or change history (e.g., "formerly/previously/used to/changed from X to Y/no longer used the old name/now goes by").
   - If the latest state is inherently negative, express the negation directly but still avoid old values or comparisons.
   - For updates to name/identity/affiliation/preference fields, always output a positive statement of the latest value (e.g., old memory "User's name is Wang Qiang", new conversation "My name is Li Bai" → output "The user's name is Li Bai").
   - Objective facts about third-party people/entities must use `LongTermMemory`, and the subject must remain that third party (e.g., "Wang Qiang lives in Shanghai").

Please execute the following:
1. Identify information that reflects the user's experiences, beliefs, concerns, decisions, plans, or reactions.
   - If the message is from the user, extract user-related memories.
   - If it is from the assistant, only extract factual memories that the user explicitly acknowledges or responds to.

2. Disambiguate all references to time, people, and events (same rules as before):
   - Convert relative time ("yesterday") to an absolute date.
   - Clearly distinguish event time from message time.
   - Resolve pronouns and ambiguous references.
   - Replace only first-person references ("I/we/me") with "the user".
   - Keep third-party names/entities unchanged; do not replace them with "the user".
   - State changes/negations must be treated as conflict updates (e.g., "no longer/doesn't like/canceled/changed to/doesn't plan/denies").
   - Candidates may include [Time: ...] to indicate event time; use the conversation time to judge whether they are the same period.

3. **Processing Logic (Update and Create)**:
   Traverse each piece of information in the conversation that is worth remembering and apply:

   a) **Update existing memory node (Update via Duplicate/Related)**:
      - Check Duplicate/Related Candidates.
      - If the new information repeats, confirms, or adds details to an old memory:
        - Generate an **updated complete memory** into `value` (old info + new details).
        - Put the old memory IDs into `source_candidate_ids`.
        - `conflicted_candidate_ids` must be [].

   b) **Fix conflicting memory node (Update via Conflict)**:
      - Check Conflict Candidates.
      - If the new information negates an old memory or updates its state (e.g., "no longer likes X", "changed to Y", "canceled plan", "from X to Y"):
        - Generate a memory reflecting the **latest state** into `value`.
        - Put the corrected old memory IDs into `conflicted_candidate_ids`.

   c) **Create new memory node (Create New)**:
      - If the new information is not directly related to any "Candidates" (neither duplicate nor conflict):
        - Generate an independent new memory into `value`.
        - Ensure `source_candidate_ids` and `conflicted_candidate_ids` are both `[]`.

5. **Restored Memories**:
   - When you decide to update a conflict node (case b), check whether the old node contains valid facts that were NOT negated by the new information and remain independently valid.
   - If any, extract these "remaining valid facts" and return them as `restored_memories` to prevent loss of non-conflict information due to node updates.
   - If the old node contains multiple facts (e.g., "status + phone number") and the new conversation only updates one part, you must split the unaffected facts into separate entries in `restored_memories`, and keep only the updated part in the conflict `value`.
   - For long-lived independent attributes (e.g., phone number, birthplace, affiliation), prefer splitting them into standalone facts instead of mixing them with mutable states.

6. Avoid including any memories that violate laws or involve politically sensitive information.

Return a valid JSON object with the structure:

{
  "memory list": [
    {
      "key": <string, concise memory title>,
      "memory_type": <string, "LongTermMemory" or "UserMemory", distinguishing objective facts vs user-related content>,
      "value": <string, updated complete memory content (for update/conflict) or brand-new memory content (for create)>,
      "tags": <list of related topic keywords>,
      "source_candidate_ids": <list of strings, IDs of the "duplicate/related" memories updated by this entry; [] if none>,
      "conflicted_candidate_ids": <list of strings, IDs of the "conflict" memories corrected by this entry; [] if none>,
    },
    ...
  ],
  "restored_memories": [
    {
      "source_candidate_id": <string, ID of the source old conflict memory>,
      "value": <string, remaining valid fact extracted from the old node>,
      "tags": <list of related topic keywords>
    },
    ...
  ],
  "summary": <A natural summary from the user's perspective of this memory update, 120–200 words>
}

Language rules:
- The `key`, `value`, `tags`, and `summary` fields must match the main language of the input conversation. If the input is English, output English.
- `memory_type` remains in English.
Format rules (STRICT):
- Output **strict JSON** only, no trailing commas.
- Do not include Markdown, code fences, or any explanations.

${custom_tags_prompt}

Example:
1. **Duplicate/Related Candidates**:
[ID:101][Time: 2025/05/20 09:30:00] The user likes latte and usually doesn't add sugar.
[ID:102][Time: 2025/05/18 18:00:00] The user hates rainy days.

2. **Conflict Candidates**:
[ID:201][Time: 2025/02/03 20:15:00] The user likes badminton but dislikes skiing.

3. **Possibly unrelated candidates that require further judgment (Unrelated Candidates)**:
[ID:301][Time: 2025/06/20 10:00:00] The user recently watched Star Wars.

**Conversation time**:
2025/06/26 09:00:00

**Conversation**:
user: I still like latte the most, especially with oat milk. Also, my knee is injured, so I'll never play badminton again. Recently I adopted a cat.

**Output:**
{
  "memory list": [
    {
        "key": "Coffee preference",
        "memory_type": "UserMemory",
        "value": "The user likes latte most, usually doesn't add sugar, and prefers oat milk.",
        "tags": ["diet", "coffee", "preference"],
        "source_candidate_ids": ["101"],
        "conflicted_candidate_ids": []
    },
    {
        "key": "Sport habit change",
        "memory_type": "UserMemory",
        "value": "Due to a knee injury, the user decides to no longer play badminton.",
        "tags": ["sport", "health", "badminton"],
        "source_candidate_ids": [],
        "conflicted_candidate_ids": ["201"]
    },
    {
        "key": "Pet status",
        "memory_type": "UserMemory",
        "value": "The user recently (June 2025) adopted a cat.",
        "tags": ["life", "pet", "cat"],
        "source_candidate_ids": [],
        "conflicted_candidate_ids": []
    }
  ],
  "restored_memories": [
    {
      "key": "Sports preference",
      "memory_type": "UserMemory",
      "value": "The user dislikes skiing.",
      "tags": ["sport", "skiing", "preference"],
      "source_candidate_id": "201"
    }
  ],
  "summary": "In this update, the user refined their latte preference (adds oat milk), and due to a knee injury updated their sports habit (stop playing badminton). The system preserves the record that the user dislikes skiing. Additionally, a new memory is added that the user adopted a cat. Weather preference is unaffected."
}

Always reply in the same language as the conversation. The latest input is below:

1. **Duplicate/Related Candidates**:
${duplicate_candidates}

2. **Conflict Candidates**:
${conflict_candidates}

3. **Possibly unrelated candidates that require further judgment (Unrelated Candidates)**:
${unrelated_candidates}

**Conversation time**:
${conversation_time}

**Conversation**:
${conversation}

**Output:**"""

ASYNC_MEMORY_UPDATE_PROMPT_DICT = {
    "zh": ASYNC_MEMORY_UPDATE_PROMPT_ZH,
    "en": ASYNC_MEMORY_UPDATE_PROMPT_EN,
}

MEMORY_MERGE_PROMPT_ZH = """
您是记忆库维护专家。
我们尝试更新一个记忆节点，但该节点在数据库中的内容在处理期间发生了变化（版本冲突）。
我们需要将“本次处理得出的更新内容”合并到“当前数据库中最新的记忆内容”中。

**原始记忆（数据库中的最新版本）:**
${latest_memory}

**本次尝试的更新内容（基于旧版本得出的结论）:**
${proposed_update}

**任务:**
将“本次尝试的更新内容”合并到“原始记忆”中。
- 如果更新内容包含新信息，请将其整合进去。
- 如果更新内容与原始记忆冲突，请优先采纳更新内容（假设它是基于最新对话的修正），但请尽量保留原始记忆中依然有效的细节。
- 确保合并后的结果是一个连贯、通顺的完整记忆片段。

请只返回合并后的记忆内容字符串，不要包含任何解释。
"""

MEMORY_MERGE_PROMPT_EN = """
You are a memory maintenance expert.
We attempted to update a memory node, but the content of that node changed in the database during processing (version conflict).
We need to merge "the update derived in this attempt" into "the latest memory content currently stored in the database".

Original memory (latest version in the database):
${latest_memory}

Proposed update (derived based on an old version):
${proposed_update}

Task:
Merge "the proposed update" into "the original memory".
- If the update contains new information, integrate it.
- If the update conflicts with the original memory, prefer the update (assuming it is a correction based on the latest conversation), while preserving any details from the original memory that remain valid.
- Ensure the merged result is a coherent, fluent, and complete memory passage.

Return ONLY the merged memory content string. Do not include any explanation.
"""

MEMORY_MERGE_PROMPT_DICT = {
    "zh": MEMORY_MERGE_PROMPT_ZH,
    "en": MEMORY_MERGE_PROMPT_EN,
}
