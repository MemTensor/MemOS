from abc import ABC, abstractmethod
from typing import Any
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from memos.memories.textual.item import TextualMemoryItem
from memos.vec_dbs.item import VecDBItem
from memos.templates.prefer_complete_prompt import NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT
from memos.types import MessageList


class BaseAdder(ABC):
    """Abstract base class for adders."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the adder."""

    @abstractmethod
    def add(self, memories: list[TextualMemoryItem | dict[str, Any]], *args, **kwargs) -> list[str]:
        """Add the instruct preference memories.
        Args:
            memories (list[TextualMemoryItem | dict[str, Any]]): The memories to add.
            **kwargs: Additional keyword arguments.
        Returns:
            list[str]: List of added memory IDs.
        """

class NaiveAdder(BaseAdder):
    """Naive adder."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive adder."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def _judge_update_or_add(self, old_msg: MessageList, new_msg: MessageList) -> bool:
        """Judge if the new message expresses the same core content as the old message."""
        # Convert messages to string format for comparison
        old_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in old_msg])
        new_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in new_msg])
        
        # Use the template prompt with placeholders
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT.replace("{old_information}", old_str).replace("{new_information}", new_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            response = result.get("is_same", False)
            return response if isinstance(response, bool) else response == "true"
        except Exception as e:
            print(f"Error in judge_update_or_add: {e}")
            # Fallback to simple string comparison
            return old_str == new_str
    
    def _process_single_memory(self, memory: TextualMemoryItem) -> str | None:
        """Process a single memory and return its ID if added successfully."""
        try:
            payload = {**memory.metadata.model_dump()}
            vec_db_item = VecDBItem(
                id=memory.id,
                vector=memory.metadata.dialog_vector,
                payload=payload
            )

            recall = self.vector_db.search(memory.metadata.dialog_vector, "explicit_preference", top_k=1)[0]
            if not recall or (recall.score is not None and recall.score < 0.5):
                self.vector_db.update("explicit_preference", memory.id, vec_db_item)
                return memory.id
        
            old_msg_str = recall.payload.get("dialog_str", "")
            new_msg_str = memory.metadata.dialog_str
            is_same = self._judge_update_or_add(old_msg_str, new_msg_str)
            if is_same:
                self.vector_db.delete("explicit_preference", [recall.id])
            self.vector_db.update("explicit_preference", memory.id, vec_db_item)
            return memory.id
        
        except Exception as e:
            print(f"Error processing memory {memory.id}: {e}")
            return None

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]], max_workers: int = 10, *args, **kwargs) -> list[str]:
        """Add the instruct preference memories using thread pool for acceleration."""
        if not memories:
            return []

        added_ids = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(memories))) as executor:
            future_to_memory = {
                executor.submit(self._process_single_memory, memory): memory 
                for memory in memories
            }
            
            for future in as_completed(future_to_memory):
                try:
                    memory_id = future.result()
                    if memory_id:
                        added_ids.append(memory_id)
                except Exception as e:
                    memory = future_to_memory[future]
                    print(f"Error processing memory {memory.id}: {e}")
                    continue

        return added_ids
