from typing import Any, ClassVar

from memos.configs.mem_agent import MemAgentConfigFactory
from memos.mem_agent.base import BaseMemAgent
from memos.mem_agent.deepsearch_agent import DeepSearchAgent


class MemAgentFactory:
    """Factory class for creating MemAgent instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "deep_search": DeepSearchAgent,
    }

    @classmethod
    def from_config(cls, config_factory: MemAgentConfigFactory) -> BaseMemAgent:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        mem_agent_class = cls.backend_to_class[backend]
        return mem_agent_class(config_factory.config)