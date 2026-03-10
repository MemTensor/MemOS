"""Prompt strategy plugin hook callbacks.

All callbacks are bound to the plugin instance via functools.partial(callback, plugin_instance).
"""

from __future__ import annotations

import logging

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

logger = logging.getLogger(__name__)


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
    """[mem_reader.pre_extract] Classify the message and swap in a tailored prompt."""
    category = plugin.classifier.classify(sources, mem_str, prompt_type, info={})
    plugin.stats[category] += 1

    if category != prompt_type:
        logger.info("[PromptStrategy] Classified as %s (was %s)", category, prompt_type)

    custom_prompt = plugin.registry.build_prompt(
        category=category,
        lang=lang,
        mem_str=mem_str,
        custom_tags=None,
    )
    if custom_prompt is not None:
        logger.debug("[PromptStrategy] Using strategy prompt for %s", category)
        return custom_prompt

    return None
