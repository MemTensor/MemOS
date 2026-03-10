"""PromptStrategyPlugin — classify messages and select specialised prompts."""

from __future__ import annotations

import logging

from collections import defaultdict
from functools import partial

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H


logger = logging.getLogger(__name__)


class PromptStrategyPlugin(MemOSPlugin):
    name = "prompt_strategy"
    version = "0.1.0"
    description = "Classify messages and apply category-specific extraction prompts"

    def on_load(self) -> None:
        from memos_prompt_strategy_plugin.classifier import MessageClassifier
        from memos_prompt_strategy_plugin.strategies import StrategyRegistry

        self.classifier = MessageClassifier()
        self.registry = StrategyRegistry()
        self.registry.register_defaults()
        self.stats: dict[str, int] = defaultdict(int)
        logger.info("[PromptStrategy] plugin loaded")

    def init_app(self) -> None:
        from memos_prompt_strategy_plugin.hooks import on_pre_extract
        from memos_prompt_strategy_plugin.routes import create_router

        self.register_router(create_router(self))
        self.register_hook(H.MEM_READER_PRE_EXTRACT, partial(on_pre_extract, self))
        logger.info("[PromptStrategy] plugin initialized")

    def on_shutdown(self) -> None:
        logger.info(
            "[PromptStrategy] plugin shutdown — classification stats: %s",
            dict(self.stats),
        )
