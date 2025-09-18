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

    def _preference_integration(self, query: str, 
                                explicit_prefs: List[Dict[str, Any]], 
                               implicit_prefs: List[Dict[str, Any]],
                               topic_prefs: List[Dict[str, Any]],
                               user_prefs: List[Dict[str, Any]]) -> str:
        """Integrate preferences."""
        explicit_prefs_str = json.dumps(explicit_prefs, ensure_ascii=False, indent=2)
        implicit_prefs_str = json.dumps(implicit_prefs, ensure_ascii=False, indent=2)
        topic_prefs_str = json.dumps(topic_prefs, ensure_ascii=False, indent=2)
        user_prefs_str = json.dumps(user_prefs, ensure_ascii=False, indent=2)

        prompt = NAIVE_PREFERENCE_INTEGRATION_PROMPT.format(
            query_preference=query,
            explicit_preference=explicit_prefs_str,
            implicit_preference=implicit_prefs_str,
            topic_preference=topic_prefs_str,
            user_preference=user_prefs_str
        )
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result["final_prompt"]
        except Exception as e:
            print(f"Error in preference_integration: {e}")
            return ""

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
        elif assemble_strategy == "full":
            return self._preference_integration(query, explicit_prefs, implicit_prefs, topic_prefs, user_prefs)
        else:
            raise ValueError(f"Invalid assemble strategy: {assemble_strategy}")

