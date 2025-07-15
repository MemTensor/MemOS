import json
import os

from datetime import datetime
from typing import Any

from tenacity import retry, retry_if_exception_type, stop_after_attempt

from memos.configs.memory import GeneralTextMemoryConfig
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.llms.factory import LLMFactory, OllamaLLM, OpenAILLM, AzureLLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList
from memos.vec_dbs.factory import QdrantVecDB, VecDBFactory
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class GeneralTextMemory(BaseTextMemory):
    """General textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: GeneralTextMemoryConfig):
        """Initialize memory with the given configuration."""
        self.config: GeneralTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.vector_db: QdrantVecDB = VecDBFactory.from_config(config.vector_db)
        self.embedder: OllamaEmbedder = EmbedderFactory.from_config(config.embedder)

    @retry(
        stop=stop_after_attempt(3),
        retry=retry_if_exception_type(json.JSONDecodeError),
        before_sleep=lambda retry_state: logger.warning(
            EXTRACTION_RETRY_LOG.format(
                error=retry_state.outcome.exception(),
                attempt_number=retry_state.attempt_number,
                max_attempt_number=3,
            )
        ),
    )
    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.

        Args:
            messages: List of message dictionaries to extract memories from.

        Returns:
            List of TextualMemoryItem objects representing the extracted memories.
        """
        str_messages = json.dumps(messages)
        user_query = EXTRACTION_PROMPT_PART_1 + EXTRACTION_PROMPT_PART_2.format(
            messages=str_messages
        )
        response = self.extractor_llm.generate([{"role": "user", "content": user_query}])
        raw_extracted_memories = json.loads(response)
        extracted_memories = [
            TextualMemoryItem(**memory_dict) for memory_dict in raw_extracted_memories
        ]

        return extracted_memories

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> None:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """
        memory_items = [TextualMemoryItem(**m) if isinstance(m, dict) else m for m in memories]

        # Memory encode
        embed_memories = self.embedder.embed([m.memory for m in memory_items])

        # Create vector db items
        vec_db_items = []
        for item, emb in zip(memory_items, embed_memories, strict=True):
            vec_db_items.append(
                VecDBItem(
                    id=item.id,
                    payload=item.model_dump(),
                    vector=emb,
                )
            )

        # Add to vector db
        self.vector_db.add(vec_db_items)

    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""
        memory_item = (
            TextualMemoryItem(**new_memory) if isinstance(new_memory, dict) else new_memory
        )
        memory_item.id = memory_id

        vec_db_item = VecDBItem(
            id=memory_item.id,
            payload=memory_item.model_dump(),
            vector=self._embed_one_sentence(memory_item.memory),
        )

        self.vector_db.update(memory_id, vec_db_item)

    def search(self, query: str, top_k: int) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        query_vector = self._embed_one_sentence(query)
        search_results = self.vector_db.search(query_vector, top_k)
        search_results = sorted(  # make higher score first
            search_results, key=lambda x: x.score, reverse=True
        )
        result_memories = [
            TextualMemoryItem(**search_item.payload) for search_item in search_results
        ]
        return result_memories

    def get(self, memory_id: str) -> TextualMemoryItem:
        """Get a memory by its ID."""
        result = self.vector_db.get_by_id(memory_id)
        if result is None:
            raise ValueError(f"Memory with ID {memory_id} not found")
        return TextualMemoryItem(**result.payload)

    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        """Get memories by their IDs.
        Args:
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs.
        """
        db_items = self.vector_db.get_by_ids(memory_ids)
        memories = [TextualMemoryItem(**db_item.payload) for db_item in db_items]
        return memories

    def get_all(self) -> list[TextualMemoryItem]:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """
        all_items = self.vector_db.get_all()
        all_memories = [TextualMemoryItem(**memo.payload) for memo in all_items]
        return all_memories

    def delete(self, memory_ids: list[str]) -> None:
        """Delete a memory."""
        self.vector_db.delete(memory_ids)

    def delete_all(self) -> None:
        """Delete all memories."""
        self.vector_db.delete_collection(self.vector_db.config.collection_name)
        self.vector_db.create_collection()

    def load(self, dir: str) -> None:
        try:
            memory_file = os.path.join(dir, self.config.memory_filename)

            if not os.path.exists(memory_file):
                logger.warning(f"Memory file not found: {memory_file}")
                return

            with open(memory_file, encoding="utf-8") as f:
                memories = json.load(f)

            vec_db_items = [VecDBItem.from_dict(m) for m in memories]
            self.vector_db.add(vec_db_items)
            logger.info(f"Loaded {len(memories)} memories from {memory_file}")

        except FileNotFoundError:
            logger.error(f"Memory file not found in directory: {dir}")
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding JSON from memory file: {e}")
        except Exception as e:
            logger.error(f"An error occurred while loading memories: {e}")

    def dump(self, dir: str) -> None:
        """Dump memories to os.path.join(dir, self.config.memory_filename)"""
        try:
            all_vec_db_items = self.vector_db.get_all()
            json_memories = [memory.to_dict() for memory in all_vec_db_items]

            os.makedirs(dir, exist_ok=True)
            memory_file = os.path.join(dir, self.config.memory_filename)
            with open(memory_file, "w", encoding="utf-8") as f:
                json.dump(json_memories, f, indent=4, ensure_ascii=False)

            logger.info(f"Dumped {len(all_vec_db_items)} memories to {memory_file}")

        except Exception as e:
            logger.error(f"An error occurred while dumping memories: {e}")
            raise

    def drop(
        self,
    ) -> None:
        pass

    def _embed_one_sentence(self, sentence: str) -> list[float]:
        """Embed a single sentence."""
        return self.embedder.embed(sentence)[0]


EXTRACTION_PROMPT_PART_1 = f"""You are a memory extractor. Your task is to extract memories from the given messages.
* You will receive a list of messages, each with a role (user or assistant) and content.
* Your job is to extract memories related to the user's long-term goals, interests, and emotional states.
* Each memory should be a dictionary with the following keys:
    - "memory": The content of the memory (string). Rephrase the content if necessary.
    - "metadata": A dictionary containing additional information about the memory.
* The metadata dictionary should include:
    - "type": The type of memory (string), e.g., "procedure", "fact", "event", "opinion", etc.
    - "memory_time": The time the memory occurred or refers to (string). Must be in standard `YYYY-MM-DD` format. Relative expressions such as "yesterday" or "tomorrow" are not allowed.
    - "source": The origin of the memory (string), e.g., `"conversation"`, `"retrieved"`, `"web"`, `"file"`.
    - "confidence": A numeric score (float between 0 and 100) indicating how certain you are about the accuracy or reliability of the memory.
    - "entities": A list of key entities (array of strings) mentioned in the memory, e.g., people, places, organizations, e.g., `["Alice", "Paris", "OpenAI"]`.
    - "tags": A list of keywords or thematic labels (array of strings) associated with the memory for categorization or retrieval, e.g., `["travel", "health", "project-x"]`.
    - "visibility": The accessibility scope of the memory (string), e.g., `"private"`, `"public"`, `"session"`, determining who or what contexts can access it.
    - "updated_at": The timestamp of the last modification to the memory (string). Useful for tracking memory freshness or change history. Format: ISO 8601 or natural language.
* Current date and time is {datetime.now().isoformat()}.
* Only return the list of memories in JSON format.
* Do not include any explanations
* Do not include any extra text
* Do not include code blocks (```json```)

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
  {{
    "memory": "The user plans to visit Paris on 05-26-2025.",
    "metadata": {{
      "type": "event",
      "memory_time": "2025-05-26",
      "source": "conversation",
      "confidence": 90.0,
      "entities": ["Paris"],
      "tags": ["travel", "plans"],
      "visibility": "private",
      "updated_at": "2025-05-19T00:00:00"
    }}
  }},
  {{
    "memory": "The user loves the Eiffel Tower.",
    "metadata": {{
      "type": "opinion",
      "memory_time": "2025-05-19",
      "source": "conversation",
      "confidence": 100.0,
      "entities": ["Eiffel Tower"],
      "tags": ["opinions", "landmarks"],
      "visibility": "session",
      "updated_at": "2025-05-19T00:00:00"
    }}
  }}
]

"""

EXTRACTION_PROMPT_PART_2 = """
## Query

### Input

{messages}

### Output

"""

EXTRACTION_RETRY_LOG = """Extracting memory failed due to JSON decode error: {error},
Attempt retry: {attempt_number} / {max_attempt_number}
"""
