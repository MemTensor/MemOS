import traceback
import uuid

from concurrent.futures import as_completed
from datetime import datetime

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.reorganizer import GraphStructureReorganizer


logger = get_logger(__name__)


class MemoryManager:
    def __init__(
        self,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        llm: OpenAILLM | OllamaLLM | AzureLLM,
        memory_size: dict | None = None,
        threshold: float | None = 0.80,
        is_reorganize: bool = False,
    ):
        self.graph_store = graph_store
        self.embedder = embedder
        self.memory_size = memory_size
        self.current_memory_size = {
            "WorkingMemory": 0,
            "LongTermMemory": 0,
            "UserMemory": 0,
        }
        if not memory_size:
            self.memory_size = {
                "WorkingMemory": 20,
                "LongTermMemory": 1500,
                "UserMemory": 480,
            }
        logger.info(f"MemorySize is {self.memory_size}")
        self._threshold = threshold
        self.is_reorganize = is_reorganize
        self.reorganizer = GraphStructureReorganizer(
            graph_store, llm, embedder, is_reorganize=is_reorganize
        )

    def add(
        self, memories: list[TextualMemoryItem], user_name: str | None = None, mode: str = "sync"
    ) -> list[str]:
        """
        Add new memories in parallel to different memory types.
        """
        added_ids: list[str] = []

        with ContextThreadPoolExecutor(max_workers=20) as executor:
            futures = {executor.submit(self._process_memory, m, user_name): m for m in memories}
            for future in as_completed(futures, timeout=60):
                try:
                    ids = future.result()
                    added_ids.extend(ids)
                except Exception as e:
                    logger.exception("Memory processing error: ", exc_info=e)

        if mode == "sync":
            for mem_type in ["WorkingMemory", "LongTermMemory", "UserMemory"]:
                try:
                    self.graph_store.remove_oldest_memory(
                        memory_type="WorkingMemory",
                        keep_latest=self.memory_size[mem_type],
                        user_name=user_name,
                    )
                except Exception:
                    logger.warning(f"Remove {mem_type} error: {traceback.format_exc()}")

            self._refresh_memory_size(user_name=user_name)
        return added_ids

    def replace_working_memory(
        self, memories: list[TextualMemoryItem], user_name: str | None = None
    ) -> None:
        """
        Replace WorkingMemory
        """
        working_memory_top_k = memories[: self.memory_size["WorkingMemory"]]
        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(
                    self._add_memory_to_db, memory, "WorkingMemory", user_name=user_name
                )
                for memory in working_memory_top_k
            ]
            for future in as_completed(futures, timeout=60):
                try:
                    future.result()
                except Exception as e:
                    logger.exception("Memory processing error: ", exc_info=e)

        self.graph_store.remove_oldest_memory(
            memory_type="WorkingMemory",
            keep_latest=self.memory_size["WorkingMemory"],
            user_name=user_name,
        )
        self._refresh_memory_size(user_name=user_name)

    def get_current_memory_size(self, user_name: str | None = None) -> dict[str, int]:
        """
        Return the cached memory type counts.
        """
        self._refresh_memory_size(user_name=user_name)
        return self.current_memory_size

    def _refresh_memory_size(self, user_name: str | None = None) -> None:
        """
        Query the latest counts from the graph store and update internal state.
        """
        results = self.graph_store.get_grouped_counts(
            group_fields=["memory_type"], user_name=user_name
        )
        self.current_memory_size = {record["memory_type"]: record["count"] for record in results}
        logger.info(f"[MemoryManager] Refreshed memory sizes: {self.current_memory_size}")

    def _process_memory(self, memory: TextualMemoryItem, user_name: str | None = None):
        """
        Process and add memory to different memory types (WorkingMemory, LongTermMemory, UserMemory).
        This method runs asynchronously to process each memory item.
        """
        ids: list[str] = []
        futures = []

        with ContextThreadPoolExecutor(max_workers=2, thread_name_prefix="mem") as ex:
            f_working = ex.submit(self._add_memory_to_db, memory, "WorkingMemory", user_name)
            futures.append(f_working)

            if memory.metadata.memory_type in ("LongTermMemory", "UserMemory"):
                f_graph = ex.submit(
                    self._add_to_graph_memory,
                    memory=memory,
                    memory_type=memory.metadata.memory_type,
                    user_name=user_name,
                )
                futures.append(f_graph)

            for fut in as_completed(futures):
                try:
                    res = fut.result()
                    if isinstance(res, str) and res:
                        ids.append(res)
                except Exception:
                    logger.warning("Parallel memory processing failed:\n%s", traceback.format_exc())

        return ids

    def _add_memory_to_db(
        self, memory: TextualMemoryItem, memory_type: str, user_name: str | None = None
    ) -> str:
        """
        Add a single memory item to the graph store, with FIFO logic for WorkingMemory.
        """
        metadata = memory.metadata.model_copy(update={"memory_type": memory_type}).model_dump(
            exclude_none=True
        )
        metadata["updated_at"] = datetime.now().isoformat()
        working_memory = TextualMemoryItem(memory=memory.memory, metadata=metadata)

        # Insert node into graph
        self.graph_store.add_node(working_memory.id, working_memory.memory, metadata, user_name)

    def _add_to_graph_memory(
        self, memory: TextualMemoryItem, memory_type: str, user_name: str | None = None
    ):
        """
        Generalized method to add memory to a graph-based memory type (e.g., LongTermMemory, UserMemory).

        Parameters:
        - memory: memory item to insert
        - memory_type: "LongTermMemory" | "UserMemory"
        - similarity_threshold: deduplication threshold
        - topic_summary_prefix: summary node id prefix if applicable
        - enable_summary_link: whether to auto-link to a summary node
        """
        node_id = str(uuid.uuid4())
        # Step 2: Add new node to graph
        self.graph_store.add_node(
            node_id,
            memory.memory,
            memory.metadata.model_dump(exclude_none=True),
            user_name=user_name,
        )
        return node_id

    def remove_and_refresh_memory(self):
        self._cleanup_memories_if_needed()
        self._refresh_memory_size()

    def _cleanup_memories_if_needed(self) -> None:
        """
        Only clean up memories if we're close to or over the limit.
        This reduces unnecessary database operations.
        """
        cleanup_threshold = 0.8  # Clean up when 80% full

        for memory_type, limit in self.memory_size.items():
            current_count = self.current_memory_size.get(memory_type, 0)
            threshold = int(limit * cleanup_threshold)

            # Only clean up if we're at or above the threshold
            if current_count >= threshold:
                try:
                    self.graph_store.remove_oldest_memory(
                        memory_type=memory_type, keep_latest=limit
                    )
                    logger.debug(f"Cleaned up {memory_type}: {current_count} -> {limit}")
                except Exception:
                    logger.warning(f"Remove {memory_type} error: {traceback.format_exc()}")
