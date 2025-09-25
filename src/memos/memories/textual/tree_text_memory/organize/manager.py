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

    def add(self, memories: list[TextualMemoryItem]) -> list[str]:
        """
        Add new memories in parallel to different memory types (WorkingMemory, LongTermMemory, UserMemory).
        """
        added_ids: list[str] = []

        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(self._process_memory, m): m for m in memories}
            for future in as_completed(futures, timeout=60):
                try:
                    ids = future.result()
                    added_ids.extend(ids)
                except Exception as e:
                    logger.exception("Memory processing error: ", exc_info=e)

        try:
            self.graph_store.remove_oldest_memory(
                memory_type="WorkingMemory", keep_latest=self.memory_size["WorkingMemory"]
            )
        except Exception:
            logger.warning(f"Remove WorkingMemory error: {traceback.format_exc()}")

        try:
            self.graph_store.remove_oldest_memory(
                memory_type="LongTermMemory", keep_latest=self.memory_size["LongTermMemory"]
            )
        except Exception:
            logger.warning(f"Remove LongTermMemory error: {traceback.format_exc()}")

        try:
            self.graph_store.remove_oldest_memory(
                memory_type="UserMemory", keep_latest=self.memory_size["UserMemory"]
            )
        except Exception:
            logger.warning(f"Remove UserMemory error: {traceback.format_exc()}")

        self._refresh_memory_size()
        return added_ids

    def replace_working_memory(self, memories: list[TextualMemoryItem]) -> None:
        """
        Replace WorkingMemory
        """
        working_memory_top_k = memories[: self.memory_size["WorkingMemory"]]
        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self._add_memory_to_db, memory, "WorkingMemory")
                for memory in working_memory_top_k
            ]
            for future in as_completed(futures, timeout=60):
                try:
                    future.result()
                except Exception as e:
                    logger.exception("Memory processing error: ", exc_info=e)

        self.graph_store.remove_oldest_memory(
            memory_type="WorkingMemory", keep_latest=self.memory_size["WorkingMemory"]
        )
        self._refresh_memory_size()

    def get_current_memory_size(self) -> dict[str, int]:
        """
        Return the cached memory type counts.
        """
        self._refresh_memory_size()
        return self.current_memory_size

    def _refresh_memory_size(self) -> None:
        """
        Query the latest counts from the graph store and update internal state.
        """
        results = self.graph_store.get_grouped_counts(group_fields=["memory_type"])
        self.current_memory_size = {record["memory_type"]: record["count"] for record in results}
        logger.info(f"[MemoryManager] Refreshed memory sizes: {self.current_memory_size}")

    def _process_memory(self, memory: TextualMemoryItem):
        """
        Process and add memory to different memory types (WorkingMemory, LongTermMemory, UserMemory).
        This method runs asynchronously to process each memory item.
        """
        ids = []

        # Add to WorkingMemory
        working_id = self._add_memory_to_db(memory, "WorkingMemory")
        ids.append(working_id)

        # Add to LongTermMemory and UserMemory
        if memory.metadata.memory_type in ["LongTermMemory", "UserMemory"]:
            added_id = self._add_to_graph_memory(
                memory=memory,
                memory_type=memory.metadata.memory_type,
            )
            ids.append(added_id)

        return ids

    def _add_memory_to_db(self, memory: TextualMemoryItem, memory_type: str) -> str:
        """
        Add a single memory item to the graph store, with FIFO logic for WorkingMemory.
        """
        metadata = memory.metadata.model_copy(update={"memory_type": memory_type}).model_dump(
            exclude_none=True
        )
        metadata["updated_at"] = datetime.now().isoformat()
        working_memory = TextualMemoryItem(memory=memory.memory, metadata=metadata)

        # Insert node into graph
        self.graph_store.add_node(working_memory.id, working_memory.memory, metadata)
        return working_memory.id

    def _add_to_graph_memory(self, memory: TextualMemoryItem, memory_type: str):
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
            node_id, memory.memory, memory.metadata.model_dump(exclude_none=True)
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
