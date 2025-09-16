import json
import os

from datetime import datetime
from typing import Any

from memos.configs.memory import NaiveTextMemoryConfig
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.types import MessageList


logger = get_logger(__name__)


EXTRACTION_PROMPT_PART_1 = f"""You are a memory extractor. Your task is to extract memories from the given messages.
* You will receive a list of messages, each with a role (user or assistant) and content.
* Your job is to extract the memories from these messages.
* Each memory should be a dictionary with the following keys:
    - "memory": The content of the memory (string). Rephrase the content if necessary.
    - "type": The type of memory (string), e.g., "procedure", "fact", "event", "opinion", etc.
* Current date and time is {datetime.now().isoformat()}.
* Only return the list of memories in JSON format.
* Do not include any other text or explanation.

## Example

### Input

[
    {{"role": "user", "content": "I plan to visit Paris next week."}},
    {{"role": "assistant", "content": "Paris is a beautiful city with many attractions."}},
    {{"role": "user", "content": "I love the Eiffel Tower."}},
    {{"role": "assistant", "content": "The Eiffel Tower is a must-see landmark in Paris."}}
]

### Output

[
    {{"memory": "User plans to visit Paris next week.", "metadata": {{"type": "event"}}}},
    {{"memory": "User loves the Eiffel Tower.", "metadata": {{"type": "opinion"}}}},
]
"""

EXTRACTION_PROMPT_PART_2 = """
## Query

### Input

{messages}

### Output

"""


class NaiveTextMemory(BaseTextMemory):
    """Naive textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: NaiveTextMemoryConfig):
        """Initialize memory with the given configuration."""
        self.config = config
        self.extractor_llm = LLMFactory.from_config(config.extractor_llm)
        self.memories = []

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages."""
        str_messages = json.dumps(messages)
        user_query = EXTRACTION_PROMPT_PART_1 + EXTRACTION_PROMPT_PART_2.format(
            messages=str_messages
        )
        response = self.extractor_llm.generate([{"role": "user", "content": user_query}])
        raw_extracted_memories = json.loads(response)

        # Convert raw dictionaries to TextualMemoryItem objects
        extracted_memories = []
        for memory_dict in raw_extracted_memories:
            # Ensure proper structure with memory and metadata
            memory_content = memory_dict.get("memory", "")
            metadata_dict = memory_dict.get("metadata", {})

            # Create a TextualMemoryItem with properly structured metadata
            memory_item = TextualMemoryItem(memory=memory_content, metadata=metadata_dict)
            extracted_memories.append(memory_item)

        return extracted_memories

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> None:
        """Add memories."""
        for m in memories:
            # Convert dict to TextualMemoryItem if needed
            memory_item = TextualMemoryItem(**m) if isinstance(m, dict) else m

            # Convert to dictionary for storage
            memory_dict = memory_item.model_dump()

            if memory_dict["id"] not in [m["id"] for m in self.memories]:
                self.memories.append(memory_dict)

    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""
        # Convert dict to TextualMemoryItem if needed
        memory_item = (
            TextualMemoryItem(**new_memory) if isinstance(new_memory, dict) else new_memory
        )

        # Ensure the memory item has the correct ID
        memory_item.id = memory_id
        memory_dict = memory_item.model_dump()

        for i, memory in enumerate(self.memories):
            if memory["id"] == memory_id:
                self.memories[i] = memory_dict
                break

    def search(self, query: str, top_k: int, **kwargs) -> list[TextualMemoryItem]:
        """Search for memories based on a query."""
        sims = [
            (memory, len(set(query.split()) & set(memory["memory"].split())))
            for memory in self.memories
        ]
        sims.sort(key=lambda x: x[1], reverse=True)
        # Convert search results to TextualMemoryItem objects
        return [TextualMemoryItem(**memory) for memory, _ in sims[:top_k]]

    def get(self, memory_id: str) -> TextualMemoryItem:
        """Get a memory by its ID."""
        for memory in self.memories:
            if memory["id"] == memory_id:
                return TextualMemoryItem(**memory)
        # Return empty memory item if not found
        return TextualMemoryItem(id=memory_id, memory="", metadata=TextualMemoryMetadata())

    def get_all(self) -> list[TextualMemoryItem]:
        """Get all memories."""
        return [TextualMemoryItem(**memory) for memory in self.memories]

    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        """Get memories by their IDs.
        Args:
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs.
        """
        return [self.get(memory_id) for memory_id in memory_ids]

    def delete(self, memory_ids: list[str]) -> None:
        """Delete memories.
        Args:
            memory_ids (list[str]): List of memory IDs to delete.
        """
        self.memories = [m for m in self.memories if m["id"] not in memory_ids]

    def delete_all(self) -> None:
        """Delete all memories."""
        self.memories = []

    def load(self, dir: str) -> None:
        try:
            with open(os.path.join(dir, self.config.memory_filename), encoding="utf-8") as file:
                raw_memories = json.load(file)
                self.add(raw_memories)
        except FileNotFoundError:
            logger.error(f"Directory not found: {dir}")
        except json.JSONDecodeError:
            logger.error(f"Error decoding JSON from file in directory: {dir}")
        except Exception as e:
            logger.error(f"An error occurred while loading memories: {e}")

    def dump(self, dir: str) -> None:
        try:
            os.makedirs(dir, exist_ok=True)
            memory_file = os.path.join(dir, self.config.memory_filename)
            with open(memory_file, "w", encoding="utf-8") as file:
                json.dump(self.memories, file, indent=4, ensure_ascii=False)
        except Exception as e:
            logger.error(f"An error occurred while dumping memories: {e}")
            raise

    def drop(
        self,
    ) -> None:
        pass
