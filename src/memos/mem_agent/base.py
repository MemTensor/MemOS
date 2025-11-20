from typing import List, Dict, Any, Optional
from abc import ABC, abstractmethod
from pydantic import BaseModel
from memos.configs.mem_agent import BaseAgentConfig

class BaseMemAgent(ABC):
    """
    Base class for all agents.
    """
    def __init__(self, config: BaseAgentConfig):
        """Initialize the BaseMemAgent with the given configuration."""

    @abstractmethod
    def run(self, input: str) -> str:
        """
        Run the agent.
        """