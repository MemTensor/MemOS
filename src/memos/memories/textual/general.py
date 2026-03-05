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

    def add(
        self, memories: list[TextualMemoryItem | dict[str, Any]], user_name: str | None = None, **kwargs
    ) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
            user_name: Optional user scope (ignored for general_text; kept for API compatibility).
            **kwargs: Extra args for compatibility with tree_text callers.

        Returns:
            List of successfully added memory IDs.
        """
        memory_items = [TextualMemoryItem(**m) if isinstance(m, dict) else m for m in memories]

        if not memory_items:
            return []

        # Memory encode (fallback safely if batch embedding returns None/partial)
        embed_memories = self.embedder.embed([m.memory for m in memory_items])
        if embed_memories is None:
            logger.warning("Embedding service returned None; attempting per-item fallback")
            embed_memories = []
            for memo in memory_items:
                try:
                    embed_memories.append(self._embed_one_sentence(memo.memory))
                except Exception as exc:
                    logger.error(f"Failed embedding for memory {memo.id}: {exc}")
                    continue
        
        # Create vector db items for successfully embedded memories only
        vec_db_items: list[VecDBItem] = []
        added_ids: list[str] = []
        for idx, item in enumerate(memory_items):
            if idx >= len(embed_memories):
                break
            emb = embed_memories[idx]
            if emb is None:
                logger.warning(f"Skipping memory {item.id}: embedding missing")
                continue

            vec_db_items.append(
                VecDBItem(
                    id=item.id,
                    payload=item.model_dump(),
                    vector=emb,
                )
            )
            added_ids.append(item.id)

        if not vec_db_items:
            return []

        # Add to vector db
        self.vector_db.add(vec_db_items)
        return added_ids

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

    def get_all(
        self,
        user_name: str | None = None,
        user_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        filter: dict[str, Any] | None = None,
        memory_type: list[str] | None = None,
    ) -> dict[str, Any]:
        """Get memories with compatibility pagination/filtering.

        Returns a tree_text-compatible payload shape:
        {"nodes": [...], "total_nodes": N}
        """
        if page is None:
            page = 1
        if page_size is None:
            page_size = int(os.getenv("MOS_GENERAL_TEXT_PAGE_SIZE", "100"))

        page = max(1, int(page))
        page_size = max(1, int(page_size))

        qdrant_filter: dict[str, Any] = {}
        if user_id is not None:
            qdrant_filter["metadata.user_id"] = user_id
        elif user_name is not None:
            qdrant_filter["metadata.mem_cube_id"] = user_name

        # Apply optional flat filter keys directly to payload filter map.
        if filter:
            for k, v in filter.items():
                qdrant_filter[k] = v

        all_items = self.vector_db.get_by_filter(
            qdrant_filter,
            scroll_limit=min(max(page_size, 50), 500),
            page=page,
            page_size=page_size,
            include_vectors=False,
        )
        all_memories = [TextualMemoryItem(**memo.payload).model_dump() for memo in all_items]

        def _match(item: dict[str, Any]) -> bool:
            md = item.get("metadata") or {}

            # Strict scoping to avoid accidental global scans in user-scoped endpoints.
            if user_id is not None and md.get("user_id") != user_id:
                return False

            if user_name is not None:
                md_user_name = md.get("user_name")
                md_mem_cube = md.get("mem_cube_id")
                if md_user_name is not None and md_user_name != user_name:
                    return False
                if md_mem_cube is not None and md_mem_cube != user_name:
                    return False
                if md_user_name is None and md_mem_cube is None and user_id is None:
                    return False

            if memory_type:
                md_type = md.get("memory_type")
                if md_type not in memory_type:
                    return False

            if filter:
                for k, v in filter.items():
                    if item.get(k) != v and md.get(k) != v:
                        return False

            return True

        filtered = [m for m in all_memories if _match(m)]

        # Count is best-effort; if unsupported for nested filters, fallback to page length.
        try:
            total_nodes = int(self.vector_db.count(qdrant_filter if qdrant_filter else None))
        except Exception:
            total_nodes = len(filtered)

        return {"nodes": filtered, "total_nodes": total_nodes}

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

    def add_rawfile_nodes_n_edges(self, *args, **kwargs) -> None:
        """Compatibility no-op for tree_text API.

        general_text backend does not maintain graph nodes/edges for raw files.
        """
        return None

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
