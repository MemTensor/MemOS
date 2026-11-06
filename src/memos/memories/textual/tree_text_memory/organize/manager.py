import re
import traceback
import uuid

from concurrent.futures import as_completed
from datetime import datetime

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.exceptions import GraphDBError
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.reorganizer import (
    GraphStructureReorganizer,
    QueueMessage,
)


logger = get_logger(__name__)


def extract_working_binding_ids(mem_items: list[TextualMemoryItem | dict]) -> set[str]:
    """Read structured bindings, with compatibility for legacy background hints.

    Historical self-bindings are not Working nodes and must never be deleted
    as a side effect of cleaning up a separate memory.
    """
    bindings: set[str] = set()
    pattern = re.compile(r"\[working_binding:([0-9a-fA-F-]{36})\]")
    for item in mem_items:
        if isinstance(item, dict):
            primary_id, metadata = item.get("id"), item.get("metadata") or {}
        else:
            primary_id, metadata = item.id, item.metadata
        get_metadata = (
            metadata.get
            if isinstance(metadata, dict)
            else lambda key, metadata=metadata: getattr(metadata, key, None)
        )
        binding = get_metadata("working_binding")
        if not binding:
            background = get_metadata("background") or ""
            match = pattern.search(background) if isinstance(background, str) else None
            binding = match.group(1) if match else None
        try:
            parsed = uuid.UUID(binding) if isinstance(binding, str) else None
        except ValueError:
            continue
        if parsed is not None and binding != primary_id and str(parsed) != str(primary_id).lower():
            bindings.add(binding)
    return bindings


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
            "RawFileMemory": 0,
            "UserMemory": 0,
        }
        if not memory_size:
            self.memory_size = {
                "WorkingMemory": 20,
                "LongTermMemory": 1500,
                "RawFileMemory": 1500,
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
        self,
        memories: list[TextualMemoryItem],
        user_name: str | None = None,
        mode: str = "sync",
        use_batch: bool = True,
    ) -> list[str]:
        """
        Add new memories to different memory types.

        Args:
            memories: List of memory items to add.
            user_name: Optional user name for the memories.
            mode: "sync" to cleanup and refresh after adding, "async" to skip.
            use_batch: If True, use batch database operations (more efficient for large batches).
                       If False, submit each memory (including its Working pair) independently.

        Returns:
            List of added memory IDs.
        """
        added_ids: list[str] = []
        if use_batch:
            added_ids = self._add_memories_batch(memories, user_name)
        else:
            added_ids = self._add_memories_parallel(memories, user_name)

        if mode == "sync":
            self._cleanup_working_memory(user_name)

        return added_ids

    def _add_memories_parallel(
        self, memories: list[TextualMemoryItem], user_name: str | None = None
    ) -> list[str]:
        """Submit memories independently while preserving their return order."""
        with ContextThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(self._process_memory, m, user_name) for m in memories]
            # Keep correspondence with the input even when writes finish out of order.
            added_ids = [node_id for future in futures for node_id in future.result()]
        logger.info("[MemoryManager: _add_memories_parallel] Added %s memories", len(added_ids))
        return added_ids

    def _add_memories_batch(
        self, memories: list[TextualMemoryItem], user_name: str | None = None, batch_size: int = 5
    ) -> list[str]:
        """Write batches of input memories without splitting a Working/graph pair."""
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        if not memories:
            return []
        prepared = [self._prepare_memory_nodes(memory) for memory in memories]
        added_ids = [node_id for _, ids in prepared for node_id in ids]
        with ContextThreadPoolExecutor(max_workers=min(8, len(memories))) as executor:
            futures = []
            for offset in range(0, len(prepared), batch_size):
                nodes = [
                    node for group, _ in prepared[offset : offset + batch_size] for node in group
                ]
                if nodes:
                    futures.append(
                        executor.submit(
                            self.graph_store.add_nodes_batch, nodes, user_name=user_name
                        )
                    )
            for future in futures:
                future.result()
        if added_ids and self.is_reorganize:
            self.reorganizer.add_message(
                QueueMessage(op="add", after_node=added_ids, user_name=user_name)
            )
        return added_ids

    def _prepare_memory_nodes(self, memory: TextualMemoryItem) -> tuple[list[dict], list[str]]:
        """Preserve the primary ID and derive a stable, separate Working identity."""
        kind = memory.metadata.memory_type
        paired = kind in ("LongTermMemory", "UserMemory")
        working_only = kind in ("WorkingMemory", "OuterMemory")
        graph = paired or kind in (
            "ToolSchemaMemory",
            "ToolTrajectoryMemory",
            "RawFileMemory",
            "SkillMemory",
            "PreferenceMemory",
        )
        if not working_only and not graph:
            return [], []

        metadata = memory.metadata.model_dump(exclude_none=True)
        metadata["updated_at"] = datetime.now().isoformat()
        metadata.pop("working_binding", None)
        if "background" in metadata:
            metadata["background"] = re.sub(
                r"\[working_binding:[^\]]*\]", "", metadata["background"]
            )
        nodes = []
        working_id = (
            str(uuid.uuid5(uuid.NAMESPACE_URL, "memos:working:" + memory.id))
            if paired
            else memory.id
        )
        if paired or working_only:
            nodes.append(
                {
                    "id": working_id,
                    "memory": memory.memory,
                    "metadata": {**metadata, "memory_type": "WorkingMemory"},
                }
            )
        if graph:
            if paired:
                metadata["working_binding"] = working_id
                if "mode:fast" in (metadata.get("tags") or []):
                    metadata["is_fast"] = True
                    hint = f"[working_binding:{working_id}] direct built from raw inputs"
                    background = metadata.get("background") or ""
                    metadata["background"] = f"{background} || {hint}" if background else hint
            nodes.append({"id": memory.id, "memory": memory.memory, "metadata": metadata})
        return nodes, [memory.id] if graph else []

    def _cleanup_working_memory(self, user_name: str | None = None) -> None:
        """
        Remove oldest WorkingMemory nodes to keep within size limit.
        """
        try:
            self.graph_store.remove_oldest_memory(
                memory_type="WorkingMemory",
                keep_latest=self.memory_size["WorkingMemory"],
                user_name=user_name,
            )
        except (GraphDBError, ValueError):
            raise
        except Exception:
            logger.warning(f"Remove WorkingMemory error: {traceback.format_exc()}")

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
        self.current_memory_size = {
            record["memory_type"]: int(record["count"]) for record in results
        }
        logger.info(f"[MemoryManager] Refreshed memory sizes: {self.current_memory_size}")

    def _process_memory(self, memory: TextualMemoryItem, user_name: str | None = None) -> list[str]:
        """Write a complete pair in one backend call; return only the graph ID."""
        nodes, ids = self._prepare_memory_nodes(memory)
        if nodes:
            self.graph_store.add_nodes_batch(nodes, user_name=user_name)
        if ids and self.is_reorganize:
            self.reorganizer.add_message(
                QueueMessage(op="add", after_node=ids, user_name=user_name)
            )
        return ids

    def _add_memory_to_db(
        self,
        memory: TextualMemoryItem,
        memory_type: str,
        user_name: str | None = None,
        forced_id: str | None = None,
    ) -> str:
        """
        Add a single memory item to the graph store, with FIFO logic for WorkingMemory.
        If forced_id is provided, use that as the node id.
        """
        metadata = memory.metadata.model_copy(update={"memory_type": memory_type}).model_dump(
            exclude_none=True
        )
        metadata["updated_at"] = datetime.now().isoformat()
        node_id = forced_id or str(uuid.uuid4())
        working_memory = TextualMemoryItem(id=node_id, memory=memory.memory, metadata=metadata)
        # Insert node into graph
        self.graph_store.add_node(working_memory.id, working_memory.memory, metadata, user_name)
        return node_id

    def _add_to_graph_memory(
        self,
        memory: TextualMemoryItem,
        memory_type: str,
        user_name: str | None = None,
        working_binding: str | None = None,
    ):
        """
        Generalized method to add memory to a graph-based memory type (e.g., LongTermMemory, UserMemory).
        """
        node_id = memory.id if hasattr(memory, "id") else str(uuid.uuid4())
        # Step 2: Add new node to graph
        metadata_dict = memory.metadata.model_dump(exclude_none=True)
        if working_binding:
            metadata_dict["working_binding"] = working_binding
        tags = metadata_dict.get("tags") or []
        if working_binding and ("mode:fast" in tags):
            metadata_dict["is_fast"] = True  # Temporal fix
            prev_bg = metadata_dict.get("background", "") or ""
            binding_line = f"[working_binding:{working_binding}] direct built from raw inputs"
            if prev_bg:
                metadata_dict["background"] = prev_bg + " || " + binding_line
            else:
                metadata_dict["background"] = binding_line
        self.graph_store.add_node(
            node_id,
            memory.memory,
            metadata_dict,
            user_name=user_name,
        )
        self.reorganizer.add_message(
            QueueMessage(
                op="add",
                after_node=[node_id],
                user_name=user_name,
            )
        )
        return node_id

    def _inherit_edges(self, from_id: str, to_id: str, user_name: str | None = None) -> None:
        """
        Migrate all non-lineage edges from `from_id` to `to_id`,
        and remove them from `from_id` after copying.
        """
        edges = self.graph_store.get_edges(
            from_id, type="ANY", direction="ANY", user_name=user_name
        )

        for edge in edges:
            if edge["type"] == "MERGED_TO":
                continue  # Keep lineage edges

            new_from = to_id if edge["from"] == from_id else edge["from"]
            new_to = to_id if edge["to"] == from_id else edge["to"]

            if new_from == new_to:
                continue

            # Add edge to merged node if it doesn't already exist
            if not self.graph_store.edge_exists(
                new_from, new_to, edge["type"], direction="ANY", user_name=user_name
            ):
                self.graph_store.add_edge(new_from, new_to, edge["type"], user_name=user_name)

            # Remove original edge if it involved the archived node
            self.graph_store.delete_edge(
                edge["from"], edge["to"], edge["type"], user_name=user_name
            )

    def _ensure_structure_path(
        self,
        memory_type: str,
        metadata: TreeNodeTextualMemoryMetadata,
        user_name: str | None = None,
    ) -> str:
        """
        Ensure structural path exists (ROOT → ... → final node), return last node ID.

        Args:
            memory_type: Memory type for the structure node.
            metadata: Metadata containing key and other fields.
            user_name: Optional user name for multi-tenant isolation.

        Returns:
            Final node ID of the structure path.
        """
        # Step 1: Try to find an existing memory node with content == tag
        existing = self.graph_store.get_by_metadata(
            [
                {"field": "memory", "op": "=", "value": metadata.key},
                {"field": "memory_type", "op": "=", "value": memory_type},
            ],
            user_name=user_name,
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
                new_node.id,
                new_node.memory,
                new_node.metadata.model_dump(exclude_none=True),
                user_name=user_name,
            )
            self.reorganizer.add_message(
                QueueMessage(
                    op="add",
                    after_node=[new_node.id],
                    user_name=user_name,
                )
            )

            node_id = new_node.id

        # Step 3: Return this structure node ID as the parent_id
        return node_id

    def remove_and_refresh_memory(self, user_name: str | None = None):
        self._cleanup_memories_if_needed(user_name=user_name)
        self._refresh_memory_size(user_name=user_name)

    def _cleanup_memories_if_needed(self, user_name: str | None = None) -> None:
        """
        Only clean up memories if we're close to or over the limit.
        This reduces unnecessary database operations.
        """
        cleanup_threshold = 0.8  # Clean up when 80% full

        logger.info(f"self.memory_size: {self.memory_size}")
        for memory_type, limit in self.memory_size.items():
            current_count = self.current_memory_size.get(memory_type, 0)
            threshold = int(int(limit) * cleanup_threshold)

            # Only clean up if we're at or above the threshold
            if current_count >= threshold:
                try:
                    self.graph_store.remove_oldest_memory(
                        memory_type=memory_type, keep_latest=limit, user_name=user_name
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
