from typing import Any, ClassVar

from memos.configs.mem_agent import MemAgentConfigFactory
from memos.mem_agent.base import BaseMemAgent
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent


class MemAgentFactory:
    """Factory class for creating MemAgent instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "deep_search": DeepSearchMemAgent,
    }

    @classmethod
    def from_config(
        cls, config_factory: MemAgentConfigFactory, llm: Any, memory_retriever: Any | None = None
    ) -> BaseMemAgent:
        """
        Create a MemAgent instance from configuration.

        Args:
            config_factory: Configuration factory for the agent
            llm: Language model instance
            memory_retriever: Memory retrieval interface (e.g., naive_mem_cube.text_mem)

        Returns:
            Initialized MemAgent instance
        """
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        mem_agent_class = cls.backend_to_class[backend]
        return mem_agent_class(
            llm=llm, memory_retriever=memory_retriever, config=config_factory.config
        )
