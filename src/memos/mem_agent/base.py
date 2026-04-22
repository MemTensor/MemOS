from abc import ABC, abstractmethod

from memos.configs.mem_agent import BaseAgentConfig


class BaseMemAgent(ABC):
    """
    Base class for all agents.
    """

    def __init__(self, config: BaseAgentConfig):
        """Initialize the BaseMemAgent with the given configuration."""
        self.config = config

    @abstractmethod
    def run(self, input: str) -> str:
        """
        Run the agent.
        """
