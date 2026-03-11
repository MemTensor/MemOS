"""Prompt strategy registry — maps classifier categories to specialised prompts.

Currently only one strategy is registered (identity_relation). To add a new
strategy, create a ``PromptStrategy`` and call ``register()`` or append it to
``_DEFAULT_STRATEGIES``.

All strategy prompts produce the same JSON output format as the default
mem-reader (memory list + summary) so downstream processing stays unchanged.
"""

from __future__ import annotations

import logging

from dataclasses import dataclass


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PromptStrategy:
    name: str
    template_en: str
    template_zh: str
    description: str


class StrategyRegistry:
    """Registry that maps category labels to prompt strategies."""

    def __init__(self):
        self._strategies: dict[str, PromptStrategy] = {}

    def register(self, strategy: PromptStrategy) -> None:
        self._strategies[strategy.name] = strategy
        logger.info("[PromptStrategy] Registered strategy: %s", strategy.name)

    def get(self, name: str) -> PromptStrategy | None:
        return self._strategies.get(name)

    def all_strategies(self) -> dict[str, PromptStrategy]:
        return dict(self._strategies)

    def build_prompt(
        self,
        category: str,
        lang: str,
        mem_str: str,
        custom_tags: list[str] | None = None,
    ) -> str | None:
        """Build a prompt for *category*. Returns ``None`` when the category
        has no registered strategy (caller should fall back to the default)."""
        strategy = self._strategies.get(category)
        if strategy is None:
            return None

        template = strategy.template_zh if lang == "zh" else strategy.template_en
        prompt = template.replace("${conversation}", mem_str)
        prompt = prompt.replace("{chunk_text}", mem_str)

        if custom_tags:
            tags_instruction = (
                f"\n额外要求：提取的记忆请尽量关联以下标签：{custom_tags}"
                if lang == "zh"
                else f"\nAdditional: associate extracted memories with these tags: {custom_tags}"
            )
        else:
            tags_instruction = ""
        prompt = prompt.replace("${custom_tags_prompt}", tags_instruction)
        prompt = prompt.replace("{custom_tags_prompt}", tags_instruction)

        return prompt

    def register_defaults(self) -> None:
        """Register built-in strategies."""
        for strategy in _DEFAULT_STRATEGIES:
            self.register(strategy)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Default prompt templates
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_IDENTITY_RELATION_EN = """\
You are a memory extraction expert. Extract all kinds of memories, including accurate identity and relationship information about people.

Your task is to extract memories from the perspective of the user based on the conversation between the user and the assistant. This means identifying information that the user may remember — including the user’s own experiences, thoughts, plans, or relevant statements and actions made by others (such as the assistant) that affect the user or are acknowledged by the user.

Please perform the following:

1. If the current conversation contains the user’s self-reported name or information about family/social relationships, the extracted content must precisely include:
    - The user’s own name (e.g., "My name is xxx", "I am xxx")
    - All related persons mentioned by the user: relationship type + name (e.g., "My son’s name is xxx", "My wife is xxx")
    - If there are further relationship descriptions among related persons, extract them as well
    - If other content exists, extract it as usual

    Extraction requirements:
    - **Absolutely do not omit any name or relationship**
    - Use third person ("The user’s son is named Wang Mingze" rather than "My son is Wang Mingze")
    - Each identity/relationship item must be extracted as a separate memory

2. Identify information that reflects the user’s experiences, beliefs, concerns, decisions, plans, or reactions — including meaningful factual information from the assistant that the user acknowledges or responds to.
If the message is from the user, extract memories related to the user. If the message is from the assistant, only extract factual memories that are acknowledged or responded to by the user.

3. Clearly resolve all references to time, people, and events:
   - If possible, use message timestamps to convert relative temporal expressions (such as “yesterday” or “next Friday”) into absolute dates.
   - Clearly distinguish between event time and message time.
   - If uncertainty exists, explicitly state it (e.g., “around June 2025”, “exact date unclear”).
   - If a specific location is mentioned, include it.
   - Resolve all pronouns, aliases, and vague references into full names or explicit identities.
   - If there are multiple people with the same name, distinguish them clearly.

4. Always write from the third-person perspective, using “the user” or the user’s name to refer to the user, rather than first person (“I”, “we”, “my”).
For example, write “The user feels tired...” rather than “I feel tired...”.

5. Do not omit any information that the user may remember.
   - Include all key experiences, thoughts, emotional reactions, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over brevity.
   - Do not generalize or skip details that may have personal significance to the user.

6. Please avoid including any content in the extracted memories that violates laws or regulations or involves politically sensitive information.

Return a valid JSON object with the following structure:

{
  "memory list": [
    {
      "key": <string, a unique and concise memory title>,
      "memory_type": <string, either "LongTermMemory" or "UserMemory">,
      "value": <a detailed, standalone, and unambiguous memory statement — if the input conversation is in English, output in English; if the input is in Chinese, output in Chinese>,
      "tags": <a list of relevant topic keywords (e.g., ["deadline", "team", "plan"])>
    },
    ...
  ],
  "summary": <a natural paragraph summarizing the above memories from the user’s perspective, 120–200 words, in the same language as the input>
}

Language rules:
- The fields `key`, `value`, `tags`, and `summary` must match the main language of the input conversation. **If the input is Chinese, output in Chinese.**
- `memory_type` must remain in English.

${custom_tags_prompt}

Example:
Conversation:
user: [June 26, 2025, 3:00 PM]: Hi Jerry, my name is Tom! Yesterday at 3:00 PM I had a meeting with my team to discuss a new project.
assistant: Do you think the team can finish by December 15?
user: [June 26, 2025, 3:00 PM]: I’m a little worried. The backend won’t be finished until December 10, so testing time will be tight.
assistant: [June 26, 2025, 3:00 PM]: Maybe suggest postponing it?
user: [June 26, 2025, 4:21 PM]: Good idea. I’ll bring it up at tomorrow’s 9:30 AM meeting — maybe push the deadline to January 5.

Output:
{
  "memory list": [
    {
      "key": "User name",
      "memory_type": "UserMemory",
      "value": "The user’s name is Tom.",
      "tags": ["identity information", "name"]
    },
    {
      "key": "Initial project meeting",
      "memory_type": "LongTermMemory",
      "value": "On June 25, 2025 at 3:00 PM, Tom met with his team to discuss a new project. The meeting involved the timeline and raised concerns about whether the December 15, 2025 deadline was feasible.",
      "tags": ["project", "timeline", "meeting", "deadline"]
    },
    {
      "key": "Planned deadline adjustment",
      "memory_type": "UserMemory",
      "value": "Tom plans to suggest at the June 27, 2025 9:30 AM meeting that the team reprioritize work and postpone the project deadline to January 5, 2026.",
      "tags": ["plan", "deadline change", "prioritization"]
    }
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After the team meeting on June 25, 2025, he realized that the original December 15, 2025 deadline might not be achievable because the backend is expected to be completed only by December 10, leaving very little time for testing. Because of this concern, Tom accepted Jerry’s suggestion to propose a delay. He plans to raise the idea of postponing the deadline to January 5, 2026 at the next morning’s meeting. His actions reflect concern about the timeline as well as a proactive, team-oriented approach to problem solving."
}

Input:
    user: [July 1, 2025, 10:00 AM]: My name is Li Ming. My wife’s name is Wang Ting, and my son’s name is Li Haoran. Next week we are planning to travel to Shanghai together.
    assistant: That sounds great. How many days are you planning to stay?
    user: [July 1, 2025, 10:05 AM]: About three days.

Output:
{
  "memory list": [
    {
      "key": "User name",
      "memory_type": "UserMemory",
      "value": "The user’s name is Li Ming.",
      "tags": ["identity information", "name"]
    },
    {
      "key": "Spouse's name",
      "memory_type": "UserMemory",
      "value": "The user’s wife is named Wang Ting.",
      "tags": ["relationship information", "wife", "name"]
    },
    {
      "key": "Son's name",
      "memory_type": "UserMemory",
      "value": "The user’s son is named Li Haoran.",
      "tags": ["relationship information", "son", "name"]
    },
    {
      "key": "Family travel plan",
      "memory_type": "LongTermMemory",
      "value": "The user plans to travel to Shanghai together with his wife Wang Ting and son Li Haoran during the week following July 1, 2025, and expects the trip to last about three days. The exact departure date is not specified.",
      "tags": ["travel", "family", "plan", "Shanghai"]
    }
  ],
  "summary": "Li Ming is planning a family trip to Shanghai in the week after July 1, 2025, and expects the trip to last about three days. The conversation explicitly states that the user’s wife is named Wang Ting and the user’s son is named Li Haoran. This indicates that the user has a near-term travel plan involving close family members."
}

Please always reply in the same language as the conversation.

Conversation:
${conversation}

Your output:
"""

_IDENTITY_RELATION_ZH = """\

您是记忆提取专家，提取各类记忆，包括准确的人物身份和关系信息。
您的任务是根据用户与助手之间的对话，从用户的角度提取记忆。这意味着要识别出用户可能记住的信息——包括用户自身的经历、想法、计划，或他人（如助手）做出的并对用户产生影响或被用户认可的相关陈述和行为。

请执行以下操作：
1. 如果当前对话中包含用户自述的姓名或亲属/社交关系信息。你提取的内容需要精确包括
    - 用户本人的姓名（如"我叫xxx"、"我是xxx"）
    - 用户提及的所有关系人：关系类型 + 姓名（如"我的儿子叫xxx"、"我老婆是xxx"）
    - 关系人之间如果存在进一步的关系描述，也要提取；
    - 其他内容如果存在照常提取；
    提取要求：
    - **绝对不能遗漏任何人名和关系**
    - 使用第三人称（"用户的儿子叫王明泽"而非"我的儿子叫王明泽"）
    - 每组身份/关系信息单独作为一条记忆

2. 识别反映用户经历、信念、关切、决策、计划或反应的信息——包括用户认可或回应的来自助手的有意义信息。
如果消息来自用户，请提取与用户相关的记忆；如果来自助手，则仅提取用户认可或回应的事实性记忆。

3. 清晰解析所有时间、人物和事件的指代：
   - 如果可能，使用消息时间戳将相对时间表达（如“昨天”、“下周五”）转换为绝对日期。
   - 明确区分事件时间和消息时间。
   - 如果存在不确定性，需明确说明（例如，“约2025年6月”，“具体日期不详”）。
   - 若提及具体地点，请包含在内。
   - 将所有代词、别名和模糊指代解析为全名或明确身份。
   - 如有同名人物，需加以区分。

4. 始终以第三人称视角撰写，使用“用户”或提及的姓名来指代用户，而不是使用第一人称（“我”、“我们”、“我的”）。
例如，写“用户感到疲惫……”而不是“我感到疲惫……”。

5. 不要遗漏用户可能记住的任何信息。
   - 包括所有关键经历、想法、情绪反应和计划——即使看似微小。
   - 优先考虑完整性和保真度，而非简洁性。
   - 不要泛化或跳过对用户具有个人意义的细节。

6. 请避免在提取的记忆中包含违反国家法律法规或涉及政治敏感的信息。

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
user: [2025年6月26日下午3:00]：嗨Jerry，我叫Tom！昨天下午3点我和团队开了个会，讨论新项目。
assistant: 你觉得团队能在12月15日前完成吗？
user: [2025年6月26日下午3:00]：我有点担心。后端要到12月10日才能完成，所以测试时间会很紧。
assistant: [2025年6月26日下午3:00]：也许提议延期？
user: [2025年6月26日下午4:21]：好主意。我明天上午9:30的会上提一下——也许把截止日期推迟到1月5日。

输出：
{
  "memory list": [
    {
      "key": "用户姓名",
      "memory_type": "UserMemory",
      "value": "用户名叫Tom。",
      "tags": ["身份信息", "姓名"]
    },
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

输入：
    user: [2025年7月1日上午10:00]：我叫李明，我老婆叫王婷，我儿子叫李浩然。下周我们打算一起去上海旅游。
    assistant: 听起来很不错，你们准备去几天？
    user: [2025年7月1日上午10:05]：大概三天。

输出：
{
  "memory list": [
    {
      "key": "用户姓名",
      "memory_type": "UserMemory",
      "value": "用户名叫李明。",
      "tags": ["身份信息", "姓名"]
    },
    {
      "key": "配偶姓名",
      "memory_type": "UserMemory",
      "value": "用户的妻子叫王婷。",
      "tags": ["关系信息", "妻子", "姓名"]
    },
    {
      "key": "儿子姓名",
      "memory_type": "UserMemory",
      "value": "用户的儿子叫李浩然。",
      "tags": ["关系信息", "儿子", "姓名"]
    },
    {
      "key": "家庭出行计划",
      "memory_type": "LongTermMemory",
      "value": "用户计划于2025年7月8日所在周与妻子王婷和儿子李浩然一起前往上海旅游，预计行程约三天。具体出发日期未明确。",
      "tags": ["旅行", "家庭", "计划", "上海"]
    }
  ],
  "summary": "李明计划在2025年7月1日之后的下一周与家人一起去上海旅游，预计停留约三天。对话中明确提到用户的妻子名叫王婷，儿子名叫李浩然。这表明用户近期有一项与家庭相关的出行安排。"
}

请始终使用与对话相同的语言进行回复。

对话：
${conversation}

您的输出：
"""

_DEFAULT_STRATEGIES = [
    PromptStrategy(
        name="identity_relation",
        template_en=_IDENTITY_RELATION_EN,
        template_zh=_IDENTITY_RELATION_ZH,
        description="Precise extraction of names and family/social relationships",
    ),
]
