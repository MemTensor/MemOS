import traceback
import uuid

from concurrent.futures import as_completed
from datetime import datetime

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.reorganizer import (
    GraphStructureReorganizer,
    QueueMessage,
)


logger = get_logger(__name__)


class MemoryManager:
    def __init__(
        self,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        llm: OpenAILLM | OllamaLLM | AzureLLM,
        memory_size: dict | None = None,
        threshold: float | None = 0.80,
        merged_threshold: float | None = 0.92,
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
        self._merged_threshold = merged_threshold

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

        # if mode == "sync":
        #     for mem_type in ["WorkingMemory", "LongTermMemory", "UserMemory"]:
        #         try:
        #             self.graph_store.remove_oldest_memory(
        #                 memory_type="WorkingMemory",
        #                 keep_latest=self.memory_size[mem_type],
        #                 user_name=user_name,
        #             )
        #         except Exception:
        #             logger.warning(f"Remove {mem_type} error: {traceback.format_exc()}")
        #
        #     self._refresh_memory_size(user_name=user_name)
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
            # f_working = ex.submit(self._add_memory_to_db, memory, "WorkingMemory", user_name)
            # futures.append(f_working)

            if memory.metadata.memory_type in ("LongTermMemory", "UserMemory", "WorkingMemory"):
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
        self.reorganizer.add_message(
            QueueMessage(
                op="add",
                after_node=[node_id],
            )
        )
        return node_id

    def _inherit_edges(self, from_id: str, to_id: str) -> None:
        """
        Migrate all non-lineage edges from `from_id` to `to_id`,
        and remove them from `from_id` after copying.
        """
        edges = self.graph_store.get_edges(from_id, type="ANY", direction="ANY")

        for edge in edges:
            if edge["type"] == "MERGED_TO":
                continue  # Keep lineage edges

            new_from = to_id if edge["from"] == from_id else edge["from"]
            new_to = to_id if edge["to"] == from_id else edge["to"]

            if new_from == new_to:
                continue

            # Add edge to merged node if it doesn't already exist
            if not self.graph_store.edge_exists(new_from, new_to, edge["type"], direction="ANY"):
                self.graph_store.add_edge(new_from, new_to, edge["type"])

            # Remove original edge if it involved the archived node
            self.graph_store.delete_edge(edge["from"], edge["to"], edge["type"])

    def _ensure_structure_path(
        self, memory_type: str, metadata: TreeNodeTextualMemoryMetadata
    ) -> str:
        """
        Ensure structural path exists (ROOT → ... → final node), return last node ID.

        Args:
            path: like ["hobby", "photography"]

        Returns:
            Final node ID of the structure path.
        """
        # Step 1: Try to find an existing memory node with content == tag
        existing = self.graph_store.get_by_metadata(
            [
                {"field": "memory", "op": "=", "value": metadata.key},
                {"field": "memory_type", "op": "=", "value": memory_type},
            ]
        )
        if existing:
            node_id = existing[0]  # Use the first match
        else:
            # Step 2: If not found, create a new structure node
            new_node = TextualMemoryItem(
                memory=metadata.key,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=metadata.user_id,
                    session_id=metadata.session_id,
                    memory_type=memory_type,
                    status="activated",
                    tags=[],
                    key=metadata.key,
                    embedding=self.embedder.embed([metadata.key])[0],
                    usage=[],
                    sources=[],
                    confidence=0.99,
                    background="",
                ),
            )
            self.graph_store.add_node(
                id=new_node.id,
                memory=new_node.memory,
                metadata=new_node.metadata.model_dump(exclude_none=True),
            )
            self.reorganizer.add_message(
                QueueMessage(
                    op="add",
                    after_node=[new_node.id],
                )
            )

            node_id = new_node.id

        # Step 3: Return this structure node ID as the parent_id
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

    def wait_reorganizer(self):
        """
        Wait for the reorganizer to finish processing all messages.
        """
        logger.debug("Waiting for reorganizer to finish processing messages...")
        self.reorganizer.wait_until_current_task_done()

    def close(self):
        self.wait_reorganizer()
        self.reorganizer.stop()

    def __del__(self):
        self.close()
