import json
import os

from datetime import datetime
from typing import Any

from tenacity import retry, retry_if_exception_type, stop_after_attempt

from memos.configs.memory import GeneralTextMemoryConfig
from memos.embedders.factory import ArkEmbedder, EmbedderFactory, OllamaEmbedder
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.templates.mem_reader_prompts import SIMPLE_STRUCT_MEM_READER_PROMPT
from memos.types import MessageList
from memos.vec_dbs.factory import QdrantVecDB, VecDBFactory
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class GeneralTextMemory(BaseTextMemory):
    """General textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: GeneralTextMemoryConfig):
        """Initialize memory with the given configuration."""
        # Set mode from class default or override if needed
        self.mode = getattr(self.__class__, "mode", "sync")
        self.config: GeneralTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.vector_db: QdrantVecDB = VecDBFactory.from_config(config.vector_db)
        self.embedder: OllamaEmbedder | ArkEmbedder = EmbedderFactory.from_config(config.embedder)

    @retry(
        stop=stop_after_attempt(3),
        retry=retry_if_exception_type(json.JSONDecodeError),
        before_sleep=lambda retry_state: logger.warning(
            f"Extracting memory failed due to JSON decode error: {retry_state.outcome.exception()}, Attempt retry: {retry_state.attempt_number} / {3}"
        ),
    )
    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.

        Args:
            messages: List of message dictionaries to extract memories from.

        Returns:
            List of TextualMemoryItem objects representing the extracted memories.
        """

        str_messages = "\n".join(
            [message["role"] + ":" + message["content"] for message in messages]
        )

        prompt = SIMPLE_STRUCT_MEM_READER_PROMPT.replace("${conversation}", str_messages).replace(
            "${custom_tags_prompt}", ""
        )
        messages = [{"role": "user", "content": prompt}]
        response_text = self.extractor_llm.generate(messages)
        response_json = self.parse_json_result(response_text)

        extracted_memories = [
            TextualMemoryItem(
                memory=memory_dict["value"],
                metadata={
                    "key": memory_dict["key"],
                    "source": "conversation",
                    "tags": memory_dict["tags"],
                    "updated_at": datetime.now().isoformat(),
                },
            )
            for memory_dict in response_json["memory list"]
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

    def search(self, query: str, top_k: int, info=None, **kwargs) -> list[TextualMemoryItem]:
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

    def get(self, memory_id: str, user_name: str | None = None) -> TextualMemoryItem:
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
        return self.embedder.embed([sentence])[0]

    def parse_json_result(self, response_text):
        try:
            json_start = response_text.find("{")
            response_text = response_text[json_start:]
            response_text = response_text.replace("```", "").strip()
            if response_text[-1] != "}":
                response_text += "}"
            response_json = json.loads(response_text)
            return response_json
        except json.JSONDecodeError as e:
            logger.warning(
                f"Failed to parse LLM response as JSON: {e}\nRaw response:\n{response_text}"
            )
            return {}
