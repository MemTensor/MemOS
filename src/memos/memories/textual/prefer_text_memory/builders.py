from abc import ABC, abstractmethod
from typing import Optional
from memos.llms.base import BaseLLM

class BaseBuilder(ABC):
    """
    Abstract base class for memory builders.
    
    Each builder implements a specific build strategy for creating
    procedural memory content from task trajectories.
    """
    
    @abstractmethod
    def __init__(self, llm_provider: Optional[BaseLLM] = None):
        """
        Initialize the memory builder.
        
        Args:
            llm_provider: LLM provider for script generation (required for some strategies)
        """
        self.llm_provider = llm_provider
    
    @abstractmethod
    def build(self, task_description: str, trajectory: str) -> str:
        """
        Build memory content from task description and trajectory.
        
        Args:
            task_description: Natural language description of the task
            trajectory: Detailed step-by-step trajectory of task execution
            
        Returns:
            Memory content string formatted according to the build strategy
            
        Raises:
            RuntimeError: If memory building fails
        """
        pass


class NaiveBuilder(BaseBuilder):
    """Naive memory builder."""
    def __init__(self, llm_provider: Optional[BaseLLM] = None):
        """Initialize the naive memory builder."""
        super().__init__(llm_provider)

    def build(self, task_description: str, trajectory: str) -> str:
        """Build memory content from task description and trajectory."""
        pass