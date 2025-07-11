import uuid

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.factory import OllamaLLM, OpenAILLM
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
        llm: OpenAILLM | OllamaLLM,
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
                "LongTermMemory": 10000,
                "UserMemory": 10000,
            }
        self._threshold = threshold
        self.is_reorganize = is_reorganize
        self.reorganizer = GraphStructureReorganizer(
            graph_store, llm, embedder, is_reorganize=is_reorganize
        )
        self._merged_threshold = merged_threshold

    def add(self, memories: list[TextualMemoryItem]) -> None:
        """
        Add new memories in parallel to different memory types (WorkingMemory, LongTermMemory, UserMemory).
        """
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(self._process_memory, memory) for memory in memories]
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.exception("Memory processing error: ", exc_info=e)

        self.graph_store.remove_oldest_memory(
            memory_type="WorkingMemory", keep_latest=self.memory_size["WorkingMemory"]
        )
        self.graph_store.remove_oldest_memory(
            memory_type="LongTermMemory", keep_latest=self.memory_size["LongTermMemory"]
        )
        self.graph_store.remove_oldest_memory(
            memory_type="UserMemory", keep_latest=self.memory_size["UserMemory"]
        )

        self._refresh_memory_size()

    def replace_working_memory(self, memories: list[TextualMemoryItem]) -> None:
        """
        Replace WorkingMemory
        """
        working_memory_top_k = memories[: self.memory_size["WorkingMemory"]]
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self._add_memory_to_db, memory, "WorkingMemory")
                for memory in working_memory_top_k
            ]
            for future in as_completed(futures):
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
        # Add to WorkingMemory
        self._add_memory_to_db(memory, "WorkingMemory")

        # Add to LongTermMemory and UserMemory
        if memory.metadata.memory_type in ["LongTermMemory", "UserMemory"]:
            self._add_to_graph_memory(
                memory=memory,
                memory_type=memory.metadata.memory_type,
            )

    def _add_memory_to_db(self, memory: TextualMemoryItem, memory_type: str):
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
        embedding = memory.metadata.embedding

        # Step 1: Find similar nodes for possible merging
        similar_nodes = self.graph_store.search_by_embedding(
            vector=embedding,
            top_k=3,
            scope=memory_type,
            threshold=self._threshold,
            status="activated",
        )

        if similar_nodes and similar_nodes[0]["score"] > self._merged_threshold:
            self._merge(memory, similar_nodes)
        else:
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

    def _merge(self, source_node: TextualMemoryItem, similar_nodes: list[dict]) -> None:
        """
        TODO: Add node traceability support by optionally preserving source nodes and linking them with MERGED_FROM edges.

        Merge the source memory into the most similar existing node (only one),
        and establish a MERGED_FROM edge in the graph.

        Parameters:
            source_node: The new memory item (not yet in the graph)
            similar_nodes: A list of dicts returned by search_by_embedding(), ordered by similarity
        """
        original_node = similar_nodes[0]
        original_id = original_node["id"]
        original_data = self.graph_store.get_node(original_id)

        target_text = original_data.get("memory", "")
        merged_text = f"{target_text}\n⟵MERGED⟶\n{source_node.memory}"

        original_meta = TreeNodeTextualMemoryMetadata(**original_data["metadata"])
        source_meta = source_node.metadata

        merged_key = source_meta.key or original_meta.key
        merged_tags = list(set((original_meta.tags or []) + (source_meta.tags or [])))
        merged_sources = list(set((original_meta.sources or []) + (source_meta.sources or [])))
        merged_background = f"{original_meta.background}\n⟵MERGED⟶\n{source_meta.background}"
        merged_embedding = self.embedder.embed([merged_text])[0]

        merged_confidence = float((original_meta.confidence + source_meta.confidence) / 2)
        merged_usage = list(set((original_meta.usage or []) + (source_meta.usage or [])))

        # Create new merged node
        merged_id = str(uuid.uuid4())
        merged_metadata = source_meta.model_copy(
            update={
                "embedding": merged_embedding,
                "updated_at": datetime.now().isoformat(),
                "key": merged_key,
                "tags": merged_tags,
                "sources": merged_sources,
                "background": merged_background,
                "confidence": merged_confidence,
                "usage": merged_usage,
            }
        )

        self.graph_store.add_node(
            merged_id, merged_text, merged_metadata.model_dump(exclude_none=True)
        )

        # Add traceability edges: both original and new point to merged node
        self.graph_store.add_edge(original_id, merged_id, type="MERGED_TO")
        self.graph_store.update_node(original_id, {"status": "archived"})
        source_id = str(uuid.uuid4())
        source_metadata = source_node.metadata.model_copy(update={"status": "archived"})
        self.graph_store.add_node(source_id, source_node.memory, source_metadata.model_dump())
        self.graph_store.add_edge(source_id, merged_id, type="MERGED_TO")
        # After creating merged node and tracing lineage
        self._inherit_edges(original_id, merged_id)

        # Relate other similar nodes to merged if needed
        for related_node in similar_nodes[1:]:
            if not self.graph_store.edge_exists(
                merged_id, related_node["id"], type="ANY", direction="ANY"
            ):
                self.graph_store.add_edge(merged_id, related_node["id"], type="RELATE")

        # log to reorganizer before updating the graph
        self.reorganizer.add_message(
            QueueMessage(
                op="merge",
                before_node=[
                    original_id,
                    source_node.id,
                ],
                after_node=[merged_id],
            )
        )

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
