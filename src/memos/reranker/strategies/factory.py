# memos/reranker/factory.py
from __future__ import annotations

from typing import TYPE_CHECKING, Any,ClassVar
from .base import BaseRerankerStrategy
from .single_turn import SingleTurnStrategy
from .concat_background import ConcatBackgroundStrategy
from .singleturn_outmem import SingleTurnOutMemStrategy

class RerankerStrategyFactory():
    """Factory class for creating reranker strategy instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "single_turn": SingleTurnStrategy,
        "concat_background": ConcatBackgroundStrategy,
        "singleturn_outputmem": SingleTurnOutMemStrategy,
    }

    @classmethod
    def from_config(
        cls, config_factory: str = "single_turn"
    ) -> BaseRerankerStrategy:
        if config_factory not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        strategy_class = cls.backend_to_class[config_factory]
        return strategy_class()
