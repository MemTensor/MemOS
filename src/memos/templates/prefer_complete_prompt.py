NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction assistant.
Please extract the user's explicitly mentioned preferences from the following conversation.

Notes:
- A preference means the user's explicit attitude or choice toward something. It is not limited to words like "like/dislike/want/don't want/prefer".
- This includes, but is not limited to, any user's explicitly expressed inclination, desire, rejection, or priority that counts as an explicit preference.
- Focus on extracting the user's preferences in query. Do not extract preferences from the assistant's responses unless the user explicitly agrees with or endorses the assistant's suggestions.
- When the user modifies or updates their preferences for the same topic or event, extract the complete evolution process of their preference changes, including both the original and updated preferences.

Requirements:
1. Keep only the preferences explicitly mentioned by the user. Do not infer or assume. If the user mentions reasons for their preferences, include those reasons as well.
2. Output should be a list of entries concise natural language summaries and the corresponding context summary, context summary must contain complete information of the conversation fragment that the preference is mentioned.
3. If multiple preferences are mentioned within the same topic or domain, you MUST combine them into a single entry, keep each entry information complete. Different topics of preferences should be divided into multiple entries.
4. If no explicit preference can be reasonably extracted, return [].

Conversation:
{qa_pair}

Find ALL explicit preferences. If no explicit preferences found, return []. Output JSON only:
```json
[
  {
    "explicit_preference": "A short natural language summary of the preferences",
    "context_summary": "The corresponding context summary, which is a summary of the corresponding conversation, do not lack any scenario information",
    "reasoning": "reasoning process to find the explicit preferences"
    "topic": "preference topic, which can only belong to one topic or domain, such as: sports, hotel, education, etc.",
  },
]
```
"""


NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH = """
你是一个偏好提取助手。
请从以下对话中提取用户明确提及的偏好。

注意事项：
- 偏好是指用户对某事物的明确态度或选择，不仅限于"喜欢/不喜欢/想要/不想要/偏好"等词汇。
- 包括但不限于用户明确表达的任何倾向、渴望、拒绝或优先级，这些都算作显式偏好。
- 重点提取用户在查询中的偏好。不要从助手的回复中提取偏好，除非用户明确同意或认可助手的建议。
- 当用户针对同一主题或事件修改或更新其偏好时，提取其偏好变化的完整演变过程，包括原始偏好和更新后的偏好。

要求：
1. 只保留用户明确提到的偏好，不要推断或假设。如果用户提到了偏好的原因，也要包含这些原因。
2. 输出应该是一个条目列表，包含简洁的自然语言摘要和相应的上下文摘要，上下文摘要必须包含提到偏好的对话片段的完整信息。
3. 如果在同一主题或领域内提到了多个偏好，你必须将它们合并为一个条目，保持每个条目信息完整。不同话题的偏好要分为多个条目。
4. 如果没有可以合理提取的显式偏好，返回[]。

对话：
{qa_pair}

找出所有显式偏好。如果没有找到显式偏好，返回[]。仅输出JSON：
```json
[
  {
    "explicit_preference": "偏好的简短自然语言摘要，需要描述为“用户偏好于/不喜欢/想要/不想要/偏好什么”",
    "context_summary": "对应的上下文摘要，即对应对话的摘要，不要遗漏任何场景信息",
    "reasoning": "寻找显式偏好的推理过程",
    "topic": "偏好所属的主题或领域，例如：体育、酒店、教育等, topic只能属于一个主题或领域",
  },
]
```
"""


NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference inference assistant. Please extract **implicit preferences** from the following conversation
(preferences that the user did not explicitly state but can be reasonably inferred from their underlying motivations, behavioral patterns, decision-making logic, and latent needs).

Notes:
- Implicit preferences refer to user inclinations or choices that are not directly expressed, but can be deeply inferred by analyzing:
  * **Hidden motivations**: What underlying needs or goals might drive the user's behavior?
  * **Behavioral patterns**: What recurring patterns or tendencies can be observed?
  * **Decision-making logic**: What reasoning or trade-offs might the user be considering?
  * **Latent preferences**: What preferences might the user have but haven't yet articulated?
  * **Contextual signals**: What do the user's choices, comparisons, exclusions, or scenario selections reveal about their deeper preferences?
- Do not treat explicitly stated preferences as implicit preferences; this prompt is only for inferring preferences that are not directly mentioned.
- Go beyond surface-level facts to understand the user's hidden possibilities and underlying logic.

Requirements:
1. Only make inferences when there is sufficient evidence in the conversation; avoid unsupported or far-fetched guesses.
2. Inferred implicit preferences must not conflict with explicit preferences.
3. For implicit_preference: only output the preference statement itself; do not include any extra explanation, reasoning, or confidence information. Put all reasoning and explanation in the reasoning field.
4. In the reasoning field, explicitly explain the underlying logic and hidden motivations you identified.
5. Different topics of preferences should be divided into multiple entries.
6. If no implicit preference can be reasonably inferred, return [].

Conversation:
{qa_pair}

Output format:
[
  ```json
  {
    "implicit_preference": "A concise natural language statement of the implicit preferences reasonably inferred from the conversation, or an empty string",
    "context_summary": "The corresponding context summary, which is a summary of the corresponding conversation, do not lack any scenario information",
    "reasoning": "Explain the underlying logic, hidden motivations, and behavioral patterns that led to this inference",
    "topic": "preference topic, which can only belong to one topic or domain, such as: sports, hotel, education, etc.",
  }
]
```
Don't output anything except the JSON.
"""


NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH = """
你是一个偏好推理助手。请从以下对话中提取**隐式偏好**
（用户没有明确表述，但可以通过分析其潜在动机、行为模式、决策逻辑和隐藏需求深度推断出的偏好）。

注意事项：
- 隐式偏好是指用户未直接表达，但可以通过深入分析以下方面推断出的倾向或选择：
  * **隐藏动机**：什么样的潜在需求或目标可能驱动用户的行为？
  * **行为模式**：可以观察到什么样的重复模式或倾向？
  * **决策逻辑**：用户可能在考虑什么样的推理或权衡？
  * **潜在偏好**：用户可能有但尚未明确表达的偏好是什么？
  * **情境信号**：用户的选择、比较、排除或场景选择揭示了什么样的深层偏好？
- 不要将明确陈述的偏好视为隐式偏好；此提示仅用于推断未直接提及的偏好。
- 超越表面事实，理解用户的隐藏可能性和背后的逻辑。

要求：
1. 仅在对话中有充分证据时进行推断；避免无根据或牵强的猜测。
2. 推断的隐式偏好不得与显式偏好冲突。
3. 对于 implicit_preference：仅输出偏好陈述本身；不要包含任何额外的解释、推理或置信度信息。将所有推理和解释放在 reasoning 字段中。
4. 在 reasoning 字段中，明确解释你识别出的底层逻辑和隐藏动机。
5. 如果在同一主题或领域内提到了多个偏好，你必须将它们合并为一个条目，保持每个条目信息完整。不同话题的偏好要分为多个条目。
6. 如果没有可以合理推断的隐式偏好，返回[]。

对话：
{qa_pair}

输出格式：
```json
[
  {
    "implicit_preference": "从对话中合理推断出的隐式偏好的简洁自然语言陈述，或空字符串",
    "context_summary": "对应的上下文摘要，即对应对话的摘要，不要遗漏任何场景信息",
    "reasoning": "解释推断出该偏好的底层逻辑、隐藏动机和行为模式",
    "topic": "偏好所属的主题或领域，例如：体育、酒店、教育等, topic只能属于一个主题或领域",
  }
]
```
除JSON外不要输出任何其他内容。
"""


NAIVE_JUDGE_DUP_WITH_TEXT_MEM_PROMPT = """
You are a content comparison expert. Your task is to determine whether each new preference information already exists in the retrieved text memories.

**Task:** For each new preference, check if its content/topic/intent is already present in any of the retrieved text memories.

**Input Structure:**
- New preferences: Array of objects, each with "id" and "memory" fields
- Retrieved memories: Array of objects, each with "id" and "memory" fields

**Judgment Criteria:**
- If the core content, topic, or intent of a new preference is **already covered** in any retrieved memory, mark as "exists" (true).
- Consider both semantic similarity and topic overlap - even if wording differs, if the meaning is the same, it counts as existing.
- If the new preference introduces **new information, different topic, or unique content** not found in retrieved memories, mark as "exists" (false).
- Focus on the substantive content rather than minor phrasing differences.

**Output Format (JSON):**
```json
{
  "new_preference_id": "ID of the new preference being evaluated",
  "exists": true/false,
  "reasoning": "Brief explanation of your judgment, citing which retrieved memory contains similar content (if exists=true) or why it's new content (if exists=false)",
  "matched_memory_id": "If exists=true, indicate which retrieved memory id matches; otherwise null"
}
```
**New Preferences (array):**
{new_preference}

**Retrieved Text Memories (array):**
{retrieved_memories}

Output only the JSON response, no additional text.
"""


NAIVE_JUDGE_DUP_WITH_TEXT_MEM_PROMPT_ZH = """
你是一个内容比较专家。你的任务是判断每个新的偏好信息是否已经存在于召回的文本记忆中。

**任务：** 对每个新偏好，检查其内容/主题/意图是否已经在任何召回的文本记忆中存在。

**输入结构：**
- 新偏好：对象数组，每个对象包含"id"和"memory"字段
- 召回记忆：对象数组，每个对象包含"id"和"memory"字段

**判断标准：**
- 如果新偏好的核心内容、主题或意图**已经被覆盖**在任何召回的记忆中，标记为"exists"（true）。
- 考虑语义相似性和主题重叠 - 即使措辞不同，如果含义相同，也算作已存在。
- 如果新偏好引入了**新信息、不同主题或独特内容**，且在召回记忆中未找到，标记为"exists"（false）。
- 关注实质性内容，而非细微的表达差异。

**输出格式（JSON）：**
```json
{
  "new_preference_id": "正在评估的新偏好ID",
  "exists": true/false,
  "reasoning": "简要说明你的判断理由，引用包含相似内容的召回记忆（如果exists=true）或说明为什么是新内容（如果exists=false）",
  "matched_memory_id": "如果exists=true，指出匹配的召回记忆id；否则为null"
}
```
**新偏好（数组）：**
{new_preference}

**召回的文本记忆（数组）：**
{retrieved_memories}

只输出JSON响应，不要输出其他任何文本。
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT = """
You are a content comparison expert. Now you are given old and new information, each containing a question, answer topic name and topic description.
Please judge whether these two information express the **same question or core content**, regardless of expression differences, details or example differences. The judgment criteria are as follows:

- Core content is consistent, that is, the essence of the question, goal or core concept to be solved is the same, it counts as "same".
- Different expressions, different examples, but the core meaning is consistent, also counts as "same".
- If the question goals, concepts involved or solution ideas are different, it counts as "different".

Please output JSON format:
{
  "is_same": true/false,
  "reasoning": "Briefly explain the judgment basis, highlighting whether the core content is consistent"
}

**Old Information:**
{old_information}

**New Information:**
{new_information}
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_ZH = """
你是一个内容比较专家。现在给你旧信息和新信息，每个信息都包含问题、答案主题名称和主题描述。
请判断这两个信息是否表达**相同的问题或核心内容**，不考虑表达差异、细节或示例差异。判断标准如下：

- 核心内容一致，即要解决的问题本质、目标或核心概念相同，算作"相同"。
- 表达方式不同、示例不同，但核心含义一致，也算作"相同"。
- 如果问题目标、涉及的概念或解决思路不同，则算作"不同"。

请输出JSON格式：
{
  "is_same": true/false,
  "reasoning": "简要解释判断依据，突出核心内容是否一致"
}

**旧信息：**
{old_information}

**新信息：**
{new_information}
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_FINE = """
You are a preference memory comparison expert. Analyze if the new preference memory describes the same topic as any retrieved memories by considering BOTH the memory field and preference field. At most one retrieved memory can match the new memory.

**Task:** Compare the new preference memory with retrieved memories to determine if they discuss the same topic and whether an update is needed.

**Comparison Criteria:**
- **Memory field**: Compare the core topics, scenarios, and contexts described
- **Preference field**: Compare the actual preference statements, choices, and attitudes expressed
- **Same topic**: Both memory AND preference content relate to the same subject matter
- **Different topics**: Either memory OR preference content differs significantly
- **Content evolution**: Same topic but preference has changed/evolved or memory has been updated
- **Identical content**: Both memory and preference fields are essentially the same

**Decision Logic:**
- Same core topic (both memory and preference) = need to check if update is needed
- Different topics (either memory or preference differs) = no update needed
- If same topic but content has changed/evolved = update needed
- If same topic and content is identical = update needed

**Output JSON:**
```json
{
  "need_update": true/false,
  "id": "ID of the memory being updated (empty string if no update needed)",
  "new_memory": "Updated memory field with merged/evolved memory content (empty string if no update needed)",
  "new_preference": "Updated preference field with merged/evolved preference content (empty string if no update needed)",
  "reasoning": "Brief explanation of the comparison considering both memory and preference fields"
}
```

**New preference memory:**
{new_memory}

**Retrieved preference memories:**
{retrieved_memories}
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_FINE_ZH = """
你是一个偏好记忆比较专家。通过同时考虑 memory 字段和 preference 字段，分析新的偏好记忆是否与任何召回记忆描述相同的主题。最多只有一个召回记忆可以与新记忆匹配。

**任务：** 比较新的偏好记忆与召回记忆，以确定它们是否讨论相同的主题以及是否需要更新。

**比较标准：**
- **Memory 字段**：比较所描述的核心主题、场景和上下文
- **Preference 字段**：比较表达的实际偏好陈述、选择和态度
- **相同主题**：memory 和 preference 内容都涉及相同的主题
- **不同主题**：memory 或 preference 内容有显著差异
- **内容演变**：相同主题但偏好已改变/演变或记忆已更新
- **内容相同**：memory 和 preference 字段本质上相同

**决策逻辑：**
- 核心主题相同（memory 和 preference 都相同）= 需要检查是否需要更新
- 主题不同（memory 或 preference 有差异）= 不需要更新
- 如果主题相同但内容已改变/演变 = 需要更新
- 如果主题相同且内容完全相同 = 需要更新

**输出 JSON：**
```json
{
  "need_update": true/false,
  "id": "正在更新的记忆的ID（如果不需要更新则为空字符串）",
  "new_memory": "合并/演变后的更新 memory 字段（如果不需要更新则为空字符串）",
  "new_preference": "合并/演变后的更新 preference 字段（如果不需要更新则为空字符串）",
  "reasoning": "简要解释比较结果，同时考虑 memory 和 preference 字段"
}
```

**新的偏好记忆：**
{new_memory}

**召回的偏好记忆：**
{retrieved_memories}
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE = """
# User Preference Memory Management Agent

You are a **User Preference Memory Management Agent**.
Your goal is to maintain a user's long-term **preference memory base** by analyzing new preference information and determining how it should update existing memories.

Each memory entry contains three fields:
- **id**: a unique identifier for the memory.
- **context_summary**: a factual summary of the dialogue or situation from which the preference was extracted.
- **preference**: the extracted statement describing the user's preference or tendency.

When updating a preference, you should also integrate and update the corresponding `context_summary` to ensure both fields stay semantically consistent.

You must produce a complete **operation trace**, showing which memory entries (identified by unique IDs) should be **added**, **updated**, or **deleted**.

## Input Format

New preference memories (new_memories):
{new_memories}

Retrieved preference memories (retrieved_memories):
{retrieved_memories}
## Task Instructions

1. For each new memory, analyze its relationship with the retrieved memories:
   - If a new memory is **unrelated** to all retrieved memories → perform `"ADD"` (insert as a new independent memory);
   - If a new memory is **related** to one or more retrieved memories → perform `"UPDATE"` on those related retrieved memories (refine, supplement, or merge both the `preference` and the `context_summary`, while preserving change history trajectory information);
   - If one or more retrieved memories are merged into one updated memory → perform `"DELETE"` on those retrieved memories.

2. **Important**: Only retrieved memories that are related to the new memories should be updated or deleted. Retrieved memories that are unrelated to any new memory must be preserved.

3. If multiple retrieved memories describe the same preference theme, merge them into one updated memory entry, combining both their `preference` information and their `context_summary` in a coherent and concise way.

4. Output a structured list of **operation traces**, each explicitly stating:
   - which memory (by ID) is affected,
   - what operation is performed,
   - the before/after `preference` and `context_summary`,
   - and the reasoning behind it.

## Output Format (JSON)

{
  "trace": [
    {
      "op_id": "op_1",
      "type": "ADD" | "UPDATE" | "DELETE",
      "target_id": "(the old memory ID; null if ADD)",
      "old_preference": "(the old preference text; null if ADD)",
      "old_context_summary": "(the old context summary; null if ADD)",
      "new_preference": "(the updated or newly created preference, if applicable)",
      "new_context_summary": "(the updated or newly created context summary, if applicable)",
      "reason": "(brief natural-language explanation for the decision)"
    }
  ]
}

## Output Requirements

- The output **must** be valid JSON.
- Each operation must include both `preference` and `context_summary` updates where applicable.
- Each operation must include a clear `reason`.
- Multiple retrieved memories may be merged into one unified updated memory.
- Do **not** include any explanatory text outside the JSON.
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE_ZH = """
# 用户偏好记忆管理代理

你是一个**用户偏好记忆管理代理**。
你的目标是通过分析新的偏好信息并确定如何更新现有记忆，来维护用户的长期**偏好记忆库**。

每个记忆条目包含三个字段：
- **id**：记忆的唯一标识符。
- **context_summary**：从中提取偏好的对话或情境的事实摘要。
- **preference**：描述用户偏好或倾向的提取陈述。

更新偏好时，你还应该整合并更新相应的 `context_summary`，以确保两个字段保持语义一致。

你必须生成完整的**操作跟踪**，显示应该**添加**、**更新**或**删除**哪些记忆条目（通过唯一 ID 标识）。

## 输入格式

新的偏好记忆 (new_memories):
{new_memories}

召回的偏好记忆 (retrieved_memories):
{retrieved_memories}
## 任务说明

1. 对于每个新记忆，分析其与召回记忆的关系：
   - 如果新记忆与所有召回记忆**无关** → 执行 `"ADD"`（作为新的独立记忆插入）；
   - 如果新记忆与一个或多个召回记忆**相关** → 对这些相关的召回记忆执行 `"UPDATE"`（细化、补充或合并 `preference` 和 `context_summary`，同时保留变化历史轨迹信息）；
   - 如果一个或多个召回记忆被合并到一个更新的记忆中 → 对这些召回记忆执行 `"DELETE"`。

2. **重要**：只有与新记忆相关的召回记忆才应该被更新或删除。与任何新记忆都无关的召回记忆必须保留。

3. 如果多个召回记忆描述相同的偏好主题，将它们合并为一个更新的记忆条目，以连贯简洁的方式结合它们的 `preference` 信息和 `context_summary`。

4. 输出结构化的**操作跟踪**列表，每个操作明确说明：
   - 受影响的记忆（通过 ID）；
   - 执行的操作类型；
   - 更新前后的 `preference` 和 `context_summary`；
   - 以及决策的原因。

## 输出格式 (JSON)

{
  "trace": [
    {
      "op_id": "op_1",
      "type": "ADD" | "UPDATE" | "DELETE",
      "target_id": "（旧记忆 ID；如果是 ADD 则为 null）",
      "old_preference": "（旧的偏好文本；如果是 ADD 则为 null）",
      "old_context_summary": "（旧的上下文摘要；如果是 ADD 则为 null）",
      "new_preference": "（更新或新创建的偏好，如果适用）",
      "new_context_summary": "（更新或新创建的上下文摘要，如果适用）",
      "reason": "（决策的简要自然语言解释）"
    }
  ]
}

## 输出要求

- 输出**必须**是有效的 JSON。
- 每个操作必须包含 `preference` 和 `context_summary` 的更新（如果适用）。
- 每个操作必须包含清晰的 `reason`。
- 多个召回记忆可以合并为一个统一的更新记忆。
- **不要**在 JSON 之外包含任何解释性文本。
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE_WITH_ONE_SHOT = """
# User Preference Memory Management Agent

You are a **User Preference Memory Management Agent**.
Your goal is to maintain a user's long-term **preference memory base** by analyzing new preference information and determining how it should update existing memories.

Each memory entry contains three fields:
- **id**: a unique identifier for the memory.
- **context_summary**: a factual summary of the dialogue or situation from which the preference was extracted.
- **preference**: the extracted statement describing the user's preference or tendency.

When updating a preference, you should also integrate and update the corresponding `context_summary` to ensure both fields stay semantically consistent.

You must produce a complete **operation trace**, showing which memory entries (identified by unique IDs) should be **added**, **updated**, or **deleted**, and then output the **final memory state** after all operations.

## Input Format

New preference memories (new_memories):
{new_memories}

Retrieved preference memories (retrieved_memories):
{retrieved_memories}
## Task Instructions

1. For each new memory, analyze its relationship with the retrieved memories:
   - If a new memory is **unrelated** to all retrieved memories → perform `"ADD"` (insert as a new independent memory);
   - If a new memory is **related** to one or more retrieved memories → perform `"UPDATE"` on those related retrieved memories (refine, supplement, or merge both the `preference` and the `context_summary`, while preserving change history trajectory information);
   - If one or more retrieved memories are merged into one updated memory → perform `"DELETE"` on those retrieved memories.

2. **Important**: Only retrieved memories that are related to the new memories should be updated or deleted. Retrieved memories that are unrelated to any new memory must be preserved as-is in the final state.

3. If multiple retrieved memories describe the same preference theme, merge them into one updated memory entry, combining both their `preference` information and their `context_summary` in a coherent and concise way.

4. Output a structured list of **operation traces**, each explicitly stating:
   - which memory (by ID) is affected,
   - what operation is performed,
   - the before/after `preference` and `context_summary`,
   - and the reasoning behind it.

5. Output the **final memory state (after_update_state)**, representing the complete preference memory base after applying all operations. This must include:
   - All newly added memories (from ADD operations)
   - All updated memories (from UPDATE operations)
   - All unrelated retrieved memories that were preserved unchanged

## Output Format (JSON)

{
  "trace": [
    {
      "op_id": "op_1",
      "type": "ADD" | "UPDATE" | "DELETE",
      "target_id": "(the old memory ID; null if ADD)",
      "old_preference": "(the old preference text; null if ADD)",
      "old_context_summary": "(the old context summary; null if ADD)",
      "new_preference": "(the updated or newly created preference, if applicable)",
      "new_context_summary": "(the updated or newly created context summary, if applicable)",
      "reason": "(brief natural-language explanation for the decision)"
    }
  ],
  "after_update_state": [
    {
      "id": "id1",
      "context_summary": "updated factual summary of the context",
      "preference": "updated or final preference text"
    }
  ]
}

## Example

**Input:**
new_memories:
[
  {
    "id": "new_id1",
    "context_summary": "During a recent chat about study habits, the user mentioned that he often studies in quiet coffee shops and has started preferring lattes over Americanos, which he only drinks occasionally.",
    "preference": "User now prefers lattes but occasionally drinks Americanos; he also enjoys studying in quiet coffee shops."
  },
  {
    "id": "new_id2",
    "context_summary": "The user mentioned in a conversation about beverages that he has recently started enjoying green tea in the morning.",
    "preference": "User now enjoys drinking green tea in the morning."
  },
  {
    "id": "new_id3",
    "context_summary": "The user shared that he has recently started learning to play the guitar and practices for about 30 minutes every evening.",
    "preference": "User enjoys playing guitar and practices regularly in the evenings."
  }
]

retrieved_memories:
[
  {
    "id": "id1",
    "context_summary": "The user previously said he likes coffee in general.",
    "preference": "User likes coffee."
  },
  {
    "id": "id2",
    "context_summary": "The user once mentioned preferring Americanos during work breaks.",
    "preference": "User prefers Americanos."
  },
  {
    "id": "id3",
    "context_summary": "The user said he often works from home",
    "preference": "User likes working from home."
  },
  {
    "id": "id4",
    "context_summary": "The user noted he doesn't drink tea very often.",
    "preference": "User has no particular interest in tea."
  },
  {
    "id": "id5",
    "context_summary": "The user mentioned he enjoys running in the park on weekends.",
    "preference": "User likes running outdoors on weekends."
  }
]

**Output:**
{
  "trace": [
    {
      "op_id": "op_1",
      "type": "UPDATE",
      "target_id": "id1",
      "old_preference": "User likes coffee.",
      "old_context_summary": "The user previously said he likes coffee in general.",
      "new_preference": "User likes coffee, especially lattes, but occasionally drinks Americanos.",
      "new_context_summary": "The user discussed his coffee habits, stating he now prefers lattes but only occasionally drinks Americanos",
      "reason": "New memory new_id1 refines and expands the coffee preference and context while preserving frequency semantics ('occasionally')."
    },
    {
      "op_id": "op_2",
      "type": "DELETE",
      "target_id": "id2",
      "old_preference": "User prefers Americanos.",
      "old_context_summary": "The user once mentioned preferring Americanos during work breaks.",
      "new_preference": null,
      "new_context_summary": null,
      "reason": "This old memory is now merged into the updated coffee preference (id1)."
    },
    {
      "op_id": "op_3",
      "type": "UPDATE",
      "target_id": "id3",
      "old_preference": "User likes working from home.",
      "old_context_summary": "The user said he often works from home.",
      "new_preference": "User now prefers studying in quiet coffee shops instead of working from home.",
      "new_context_summary": "The user mentioned shifting from working at home to studying in quiet cafes, reflecting a new preferred environment.",
      "reason": "New memory new_id1 indicates a preference change for the working environment."
    },
    {
      "op_id": "op_4",
      "type": "UPDATE",
      "target_id": "id4",
      "old_preference": "User has no particular interest in tea.",
      "old_context_summary": "The user noted he doesn't drink tea very often.",
      "new_preference": "The user does not drink tea very often before, but now enjoys drinking green tea in the morning.",
      "new_context_summary": "The user mentioned that he has recently started enjoying green tea in the morning.",
      "reason": "New memory new_id2 indicates a preference change for tea consumption."
    },
    {
      "op_id": "op_5",
      "type": "ADD",
      "target_id": "new_id3",
      "old_preference": null,
      "old_context_summary": null,
      "new_preference": "User enjoys playing guitar and practices regularly in the evenings.",
      "new_context_summary": "The user shared that he has recently started learning to play the guitar and practices for about 30 minutes every evening.",
      "reason": "This is a completely new preference unrelated to any existing memories, so it should be added as a new entry."
    }
  ],
  "after_update_state": [
    {
      "id": "id1",
      "context_summary": "The user discussed his coffee habits, saying he now prefers lattes but only occasionally drinks Americanos.",
      "preference": "User likes coffee, especially lattes, but occasionally drinks Americanos."
    },
    {
      "id": "id3",
      "context_summary": "The user mentioned shifting from working at home to studying in quiet cafes, reflecting a new preferred environment.",
      "preference": "User now prefers studying in quiet coffee shops instead of working from home."
    },
    {
      "id": "id4",
      "context_summary": "The user mentioned that he has recently started enjoying green tea in the morning.",
      "preference": "The user does not drink tea very often before, but now enjoys drinking green tea in the morning."
    },
    {
      "id": "id5",
      "context_summary": "The user mentioned he enjoys running in the park on weekends.",
      "preference": "User likes running outdoors on weekends."
    },
    {
      "id": "new_id3",
      "context_summary": "The user shared that he has recently started learning to play the guitar and practices for about 30 minutes every evening.",
      "preference": "User enjoys playing guitar and practices regularly in the evenings."
    }
  ]
}

## Output Requirements

- The output **must** be valid JSON.
- Each operation must include both `preference` and `context_summary` updates where applicable.
- Each operation must include a clear `reason`.
- Multiple retrieved memories may be merged into one unified updated memory.
- `after_update_state` must reflect the final, post-update state of the preference memory base.
- Do **not** include any explanatory text outside the JSON.
"""


PREF_INSTRUCTIONS = """
# Note:
Fact memory are summaries of facts, while preference memory are summaries of user preferences.
Your response must not violate any of the user's preferences, whether explicit or implicit, and briefly explain why you answer this way to avoid conflicts.
#warning
- In thinking content, do not appear the reference number and id [1,2,3]etc. otherwise it will cause reference error.
"""


PREF_INSTRUCTIONS_ZH = """
# 注意：
事实记忆是事实的摘要，而偏好记忆是用户偏好的摘要。
你的回复不得违反用户的任何偏好，无论是显式偏好还是隐式偏好，并简要解释你为什么这样回答以避免冲突。
# 注意
- 在思考内容中，不要出现引用序号和id [1,2,3]等标记，否则会导致引用错误。
"""
