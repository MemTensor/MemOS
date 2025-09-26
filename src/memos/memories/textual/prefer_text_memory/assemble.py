from abc import ABC, abstractmethod
from typing import Any, Dict, List
import json
from memos.templates.prefer_complete_prompt import NAIVE_PREFERENCE_INTEGRATION_PROMPT
from memos.memories.textual.item import TextualMemoryItem

class BaseAssembler(ABC):
    """Abstract base class for assemblers."""
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the assembler."""

    @abstractmethod
    def assemble(self, query: str, memories: list[TextualMemoryItem], assemble_strategy: str="semi") -> str:
        """Assemble query and memories into a single memory.
        Args:
            query: The query to assemble.
            memories: The memories to assemble.
            assemble_strategy: The strategy to assemble the memories. option: [raw, semi, full]
        Returns:
            The assembled prompt.
        """


class NaiveAssembler(BaseAssembler):
    """Naive assembler."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive assembler."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def assemble(self, query: str, memories: list[TextualMemoryItem], assemble_strategy: str="semi") -> str:
        """Assemble query and memories into a single memory."""

        explicit_prefs = [{"dialog_str": memory.metadata.dialog_str, 
                        "explicit_preference": memory.metadata.explicit_preference} 
                        for memory in memories if memory.metadata.preference_type == "explicit_preference"]
        implicit_prefs = [{"center_dialog_str": memory.metadata.center_dialog, 
                        "implicit_preference": memory.metadata.implicit_preference} 
                        for memory in memories if memory.metadata.preference_type == "implicit_preference"]
        topic_prefs = [{"center_dialog_str": memory.metadata.center_dialog, 
                        "topic_preferences": memory.metadata.topic_preferences} 
                        for memory in memories if memory.metadata.preference_type == "topic_preference"]
        user_prefs = [{"user_preferences": memory.metadata.user_preferences} 
                        for memory in memories if memory.metadata.preference_type == "user_preference"]

        if assemble_strategy == "raw":
            return memories
        elif assemble_strategy == "semi":
            return f"Query: {query}\n\n In addition to the above Query, you can refer to the following preference below memories. \n\nMemories: {memories}. \n\nWhen encountering conflicts, prioritize following the query."
        else:
            raise ValueError(f"Invalid assemble strategy: {assemble_strategy}")

