"""Prompt strategy plugin hook callbacks.

All callbacks are bound to the plugin instance via functools.partial(callback, plugin_instance).
"""

from __future__ import annotations

import logging

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

logger = logging.getLogger(__name__)

_IDENTITY_SUPPLEMENT_ZH = """

【特别注意 - 身份与关系提取】
检测到当前对话包含用户的姓名或亲属/社交关系信息。请在完成上述所有处理步骤的同时，
**额外确保**以下内容被完整提取，绝对不能遗漏：
1. 用户本人的姓名
2. 用户提及的所有关系人（关系类型 + 姓名）
3. 每个身份/关系信息需要作为独立的记忆条目
4. tags 中必须包含 "identity" 或 "relationship"
"""

_IDENTITY_SUPPLEMENT_EN = """

[IMPORTANT - Identity & Relationship Extraction]
The current conversation contains the user's name or family/social relationship information.
In addition to all the above processing steps, **make sure** to extract the following completely
— do NOT miss any:
1. The user's own name
2. All people mentioned with their relationship type and name
3. Each identity/relationship should be a separate memory item
4. Tags must include "identity" or "relationship"
"""


def on_pre_extract(
    plugin: PromptStrategyPlugin,
    *,
    prompt: str,
    prompt_type: str,
    mem_str: str,
    lang: str,
    sources: list,
    **_kw: Any,
) -> str | None:
    """[mem_reader.pre_extract] If a classifier rule matches:
    - For normal extraction: swap in the specialised identity/relation prompt.
    - For version pipeline: append identity/relation emphasis to the existing prompt.
    If no rule matches, return None to keep the default."""
    category = plugin.classifier.classify(sources, mem_str, prompt_type, info={})

    if category is None:
        return None

    plugin.stats[category] += 1
    logger.info(
        "[PromptStrategy] Matched rule: %s | prompt_type=%s, lang=%s, text=%s",
        category,
        prompt_type,
        lang,
        mem_str[:120] + ("..." if len(mem_str) > 120 else ""),
    )

    if prompt_type == "version":
        supplement = _IDENTITY_SUPPLEMENT_ZH if lang == "zh" else _IDENTITY_SUPPLEMENT_EN
        logger.info("[PromptStrategy] Version pipeline — appending identity/relation supplement")
        return prompt + supplement

    custom_prompt = plugin.registry.build_prompt(
        category=category,
        lang=lang,
        mem_str=mem_str,
    )
    if custom_prompt is not None:
        logger.info("[PromptStrategy] Prompt swapped to strategy: %s", category)
        return custom_prompt

    return None
