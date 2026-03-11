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
    """[mem_reader.pre_extract] If a classifier rule matches and a
    corresponding strategy is registered, swap in the specialised prompt;
    otherwise return None to keep the default."""
    category = plugin.classifier.classify(sources, mem_str, prompt_type, info={})

    if category is None:
        return None

    plugin.stats[category] += 1
    logger.info("[PromptStrategy] Matched rule: %s", category)

    custom_prompt = plugin.registry.build_prompt(
        category=category,
        lang=lang,
        mem_str=mem_str,
    )
    if custom_prompt is not None:
        logger.debug("[PromptStrategy] Using strategy prompt for %s", category)
        return custom_prompt

    return None
