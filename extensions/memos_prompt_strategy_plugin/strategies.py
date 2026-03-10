"""Prompt strategy registry — maps message categories to specialised prompts.

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
    """Thread-safe registry that maps category labels to prompt strategies."""

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
                else f"\nAdditional: try to associate extracted memories with these tags: {custom_tags}"
            )
        else:
            tags_instruction = ""
        prompt = prompt.replace("${custom_tags_prompt}", tags_instruction)
        prompt = prompt.replace("{custom_tags_prompt}", tags_instruction)

        return prompt

    def register_defaults(self) -> None:
        """Register built-in strategies for all standard categories."""
        for strategy in _DEFAULT_STRATEGIES:
            self.register(strategy)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Default prompt templates per category
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_CASUAL_CHAT_EN = """\
You are a memory extraction expert specialised in casual conversations.
Extract lightweight memories focusing on the user's **personal preferences, habits, opinions, and lifestyle details**.
Skip trivial greetings or filler. Only retain information the user would realistically remember.

Conversation:
${conversation}

${custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<concise title>", "memory_type": "UserMemory", "value": "<third-person statement>", "tags": ["<tag>", ...]}
  ],
  "summary": "<1-2 sentence summary from the user's perspective>"
}
"""

_CASUAL_CHAT_ZH = """\
你是一位擅长提取日常闲聊记忆的专家。
请提取**用户的个人偏好、习惯、观点和生活细节**相关的轻量级记忆。
跳过无意义的寒暄和填充语。只保留用户真正会记住的信息。

对话内容：
${conversation}

${custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<简短标题>", "memory_type": "UserMemory", "value": "<第三人称陈述>", "tags": ["<标签>", ...]}
  ],
  "summary": "<1-2 句话从用户视角总结>"
}
"""

_TASK_ORIENTED_EN = """\
You are a memory extraction expert specialised in task-oriented conversations.
Focus on extracting **tasks, plans, deadlines, action items, constraints, and commitments** the user discussed.
Resolve all time references to absolute dates when possible.

Conversation:
${conversation}

${custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<concise title>", "memory_type": "LongTermMemory", "value": "<third-person, detailed statement including dates and constraints>", "tags": ["<tag>", ...]}
  ],
  "summary": "<paragraph summarising tasks and deadlines, 80-150 words>"
}
"""

_TASK_ORIENTED_ZH = """\
你是一位擅长提取任务型对话记忆的专家。
专注提取用户讨论的**任务、计划、截止日期、行动项、约束条件和承诺**。
尽可能将所有时间引用转换为绝对日期。

对话内容：
${conversation}

${custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<简短标题>", "memory_type": "LongTermMemory", "value": "<第三人称，包含日期和约束的详细陈述>", "tags": ["<标签>", ...]}
  ],
  "summary": "<总结任务和截止日期的段落，80-150字>"
}
"""

_KNOWLEDGE_SHARING_EN = """\
You are a memory extraction expert specialised in knowledge-sharing content.
Extract **key concepts, definitions, explanations, facts, and learned insights** from the conversation.
Treat this like document-level extraction: capture knowledge points completely.

Content:
{chunk_text}

{custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<concept or topic>", "memory_type": "LongTermMemory", "value": "<complete, self-contained explanation>", "tags": ["<tag>", ...]}
  ],
  "summary": "<paragraph summarising the knowledge shared, 100-200 words>"
}
"""

_KNOWLEDGE_SHARING_ZH = """\
你是一位擅长提取知识分享内容的记忆专家。
提取对话中的**核心概念、定义、解释、事实和学习到的见解**。
像文档级别提取一样，完整捕获知识点。

内容：
{chunk_text}

{custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<概念或主题>", "memory_type": "LongTermMemory", "value": "<完整、自包含的解释>", "tags": ["<标签>", ...]}
  ],
  "summary": "<总结分享知识的段落，100-200字>"
}
"""

_EMOTIONAL_EN = """\
You are a memory extraction expert specialised in emotional and relational conversations.
Focus on extracting the user's **emotional states, feelings, relationship dynamics, personal concerns, and significant life events**.
Preserve emotional nuance — do not flatten sentiment into generic labels.

Conversation:
${conversation}

${custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<concise title>", "memory_type": "UserMemory", "value": "<third-person statement capturing emotion and context>", "tags": ["<tag>", ...]}
  ],
  "summary": "<empathetic summary from the user's perspective, 80-150 words>"
}
"""

_EMOTIONAL_ZH = """\
你是一位擅长提取情感与人际关系对话记忆的专家。
专注提取用户的**情感状态、感受、人际关系动态、个人关切和重要生活事件**。
保留情感细节，不要将情绪简化为泛泛的标签。

对话内容：
${conversation}

${custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<简短标题>", "memory_type": "UserMemory", "value": "<第三人称陈述，捕获情感和上下文>", "tags": ["<标签>", ...]}
  ],
  "summary": "<从用户视角出发的共情式总结，80-150字>"
}
"""

_CODE_DISCUSSION_EN = """\
You are a memory extraction expert specialised in technical and code discussions.
Extract **tools, frameworks, libraries, technical decisions, code patterns, bugs, solutions, and architecture choices** discussed by the user.
Include version numbers, configuration details, and error descriptions when available.

Conversation:
${conversation}

${custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<technical topic>", "memory_type": "LongTermMemory", "value": "<third-person statement with technical specifics>", "tags": ["<tag>", ...]}
  ],
  "summary": "<technical summary, 80-150 words>"
}
"""

_CODE_DISCUSSION_ZH = """\
你是一位擅长提取技术和代码讨论记忆的专家。
提取用户讨论的**工具、框架、库、技术决策、代码模式、Bug、解决方案和架构选择**。
在可用时包含版本号、配置细节和错误描述。

对话内容：
${conversation}

${custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<技术主题>", "memory_type": "LongTermMemory", "value": "<第三人称陈述，包含技术细节>", "tags": ["<标签>", ...]}
  ],
  "summary": "<技术总结，80-150字>"
}
"""

_MULTI_TURN_QA_EN = """\
You are a memory extraction expert specialised in multi-turn Q&A conversations.
Extract the **conclusions, clarifications, and final answers** that emerged through the Q&A process.
Focus on what the user learned or decided, not intermediate back-and-forth.

Conversation:
${conversation}

${custom_tags_prompt}

Return a single valid JSON object:
{
  "memory list": [
    {"key": "<question topic>", "memory_type": "LongTermMemory", "value": "<third-person statement of conclusion or answer>", "tags": ["<tag>", ...]}
  ],
  "summary": "<summary of key conclusions from the Q&A, 80-150 words>"
}
"""

_MULTI_TURN_QA_ZH = """\
你是一位擅长提取多轮问答对话记忆的专家。
提取通过问答过程得出的**结论、澄清和最终答案**。
关注用户学到了什么或做了什么决定，而非中间的来回讨论。

对话内容：
${conversation}

${custom_tags_prompt}

返回一个合法 JSON 对象：
{
  "memory list": [
    {"key": "<问题主题>", "memory_type": "LongTermMemory", "value": "<第三人称陈述结论或答案>", "tags": ["<标签>", ...]}
  ],
  "summary": "<总结问答中的关键结论，80-150字>"
}
"""

_DEFAULT_STRATEGIES = [
    PromptStrategy(
        name="casual_chat",
        template_en=_CASUAL_CHAT_EN,
        template_zh=_CASUAL_CHAT_ZH,
        description="Lightweight extraction for casual conversation — preferences, habits, opinions",
    ),
    PromptStrategy(
        name="task_oriented",
        template_en=_TASK_ORIENTED_EN,
        template_zh=_TASK_ORIENTED_ZH,
        description="Structured extraction for tasks, plans, deadlines, and action items",
    ),
    PromptStrategy(
        name="knowledge_sharing",
        template_en=_KNOWLEDGE_SHARING_EN,
        template_zh=_KNOWLEDGE_SHARING_ZH,
        description="Document-style extraction for concepts, definitions, and learned insights",
    ),
    PromptStrategy(
        name="emotional",
        template_en=_EMOTIONAL_EN,
        template_zh=_EMOTIONAL_ZH,
        description="Emotion-aware extraction for feelings, relationships, and personal concerns",
    ),
    PromptStrategy(
        name="code_discussion",
        template_en=_CODE_DISCUSSION_EN,
        template_zh=_CODE_DISCUSSION_ZH,
        description="Technical extraction for tools, frameworks, bugs, and architecture decisions",
    ),
    PromptStrategy(
        name="multi_turn_qa",
        template_en=_MULTI_TURN_QA_EN,
        template_zh=_MULTI_TURN_QA_ZH,
        description="Conclusion-focused extraction for multi-turn Q&A conversations",
    ),
]
