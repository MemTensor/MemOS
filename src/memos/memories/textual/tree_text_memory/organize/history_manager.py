import logging
import time

from typing import Literal

from memos.context.context import ContextThreadPoolExecutor
from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.types import NLIResult
from memos.graph_dbs.base import BaseGraphDB
from memos.memories.textual.item import ArchivedTextualMemory, TextualMemoryItem


logger = logging.getLogger(__name__)

CONFLICT_MEMORY_TITLE = "[possibly conflicting memories]"
DUPLICATE_MEMORY_TITLE = "[possibly duplicate memories]"


def _append_related_content(
    new_item: TextualMemoryItem, duplicates: list[str], conflicts: list[str]
) -> None:
    """
    Append duplicate and conflict memory contents to the new item's memory text,
    truncated to avoid excessive length.
    """
    max_per_item_len = 200
    max_section_len = 1000

    def _format_section(title: str, items: list[str]) -> str:
        if not items:
            return ""

        section_content = ""
        for mem in items:
            # Truncate individual item
            snippet = mem[:max_per_item_len] + "..." if len(mem) > max_per_item_len else mem
            # Check total section length
            if len(section_content) + len(snippet) + 5 > max_section_len:
                section_content += "\n- ... (more items truncated)"
                break
            section_content += f"\n- {snippet}"

        return f"\n\n{title}:{section_content}"

    append_text = ""
    append_text += _format_section(CONFLICT_MEMORY_TITLE, conflicts)
    append_text += _format_section(DUPLICATE_MEMORY_TITLE, duplicates)

    if append_text:
        new_item.memory += append_text


def _detach_related_content(new_item: TextualMemoryItem) -> None:
    """
    Detach duplicate and conflict memory contents from the new item's memory text.
    """
    markers = [f"\n\n{CONFLICT_MEMORY_TITLE}:", f"\n\n{DUPLICATE_MEMORY_TITLE}:"]

    cut_index = -1
    for marker in markers:
        idx = new_item.memory.find(marker)
        if idx != -1 and (cut_index == -1 or idx < cut_index):
            cut_index = idx

    if cut_index != -1:
        new_item.memory = new_item.memory[:cut_index]

    return


def _rebuild_fast_node_history(
    item: TextualMemoryItem,
    replacements: dict[int, list[ArchivedTextualMemory]],
) -> None:
    """
    Reconstruct the history list of a fast node:
    1. Replace resolved items with their evolved versions.
    2. Deduplicate by ID while preserving newest versions.
    """
    new_history = {}

    def _add(history_item):
        item_id = history_item.archived_memory_id
        current = new_history.get(item_id)

        if current is None or history_item.version > current.version:
            new_history[item_id] = history_item

    # Apply replacements and filter superseded items
    for i, h in enumerate(item.metadata.history):
        if i in replacements:
            # This item is resolved, insert its replacements
            for replacement_item in replacements[i]:
                _add(replacement_item)
        else:
            _add(h)

    item.metadata.history = list(new_history.values())


class MemoryHistoryManager:
    def __init__(self, nli_client: NLIClient, graph_db: BaseGraphDB) -> None:
        """
        Initialize the MemoryHistoryManager.

        Args:
            nli_client: NLIClient for conflict/duplicate detection.
            graph_db: GraphDB instance for marking operations during history management.
        """
        self.nli_client = nli_client
        self.graph_db = graph_db

    def _check_and_fetch_replacements(
        self, item: TextualMemoryItem, pending_indices: list[int]
    ) -> tuple[dict[int, list[ArchivedTextualMemory]], list[str]]:
        """
        Check DB status for pending items. If 'deleted', fetch evolved nodes.

        Returns:
            replacements: Dict mapping original history index to list of new ArchivedTextualMemory items.
        """
        pending_ids = [item.metadata.history[i].archived_memory_id for i in pending_indices]

        # Batch fetch pending nodes to check status
        nodes_data = self.graph_db.get_nodes(ids=pending_ids) or []
        nodes_map = {n["id"]: n for n in nodes_data if n and "id" in n}

        replacements = {}

        for i in pending_indices:
            h_item = item.metadata.history[i]
            node_data = nodes_map.get(h_item.archived_memory_id)

            if not node_data:
                continue

            metadata = node_data.get("metadata", {})
            status = metadata.get("status")

            # Condition: Fast node is processed when it is marked as 'deleted'
            if status == "deleted":
                evolve_to_ids = metadata.get("evolve_to", [])

                new_items = self._fetch_evolved_nodes(evolve_to_ids, h_item.update_type)
                replacements[i] = new_items

                logger.info(
                    f"[MemoryHistoryManager] Resolved fast history item {h_item.archived_memory_id} -> {evolve_to_ids}"
                )

        return replacements

    def _fetch_evolved_nodes(
        self, evolve_to_ids: list[str], update_type: str
    ) -> list[ArchivedTextualMemory]:
        """Fetch the actual nodes that the fast node evolved into and convert to archive format."""
        if not evolve_to_ids:
            return []

        evolved_nodes = self.graph_db.get_nodes(ids=evolve_to_ids) or []
        results = []

        for enode in evolved_nodes:
            if not enode or "id" not in enode:
                continue

            enode_meta = enode.get("metadata", {})

            # Create new archived memory inheriting the update_type (conflict/duplicate)
            new_archived = ArchivedTextualMemory(
                version=enode_meta.get("version", 1),
                is_fast=enode_meta.get("is_fast", False),
                memory=enode.get("memory", ""),
                update_type=update_type,
                archived_memory_id=enode.get("id"),
                created_at=enode_meta.get("created_at"),
            )
            results.append(new_archived)

        return results

    def resolve_history_via_nli(
        self, new_item: TextualMemoryItem, related_items: list[TextualMemoryItem]
    ) -> list[TextualMemoryItem]:
        """
        Detect relationships (Duplicate/Conflict) between the new item and related items using NLI,
        and attach them as history to the new fast item.

        Args:
            new_item: The new memory item being added.
            related_items: Existing memory items that might be related.

        Returns:
            List of duplicate or conflicting memory items judged by the NLI service.
        """
        if not related_items:
            return []

        # 1. Call NLI
        nli_results = self.nli_client.compare_one_to_many(
            new_item.memory, [r.memory for r in related_items]
        )

        # 2. Process results and attach to history
        duplicate_memories = []
        conflict_memories = []

        for r_item, nli_res in zip(related_items, nli_results, strict=False):
            if nli_res == NLIResult.DUPLICATE:
                update_type = "duplicate"
                duplicate_memories.append(r_item.memory)
            elif nli_res == NLIResult.CONTRADICTION:
                update_type = "conflict"
                conflict_memories.append(r_item.memory)
            else:
                update_type = "unrelated"

            # Safely get created_at, fallback to updated_at
            created_at = getattr(r_item.metadata, "created_at", None) or r_item.metadata.updated_at

            archived = ArchivedTextualMemory(
                version=r_item.metadata.version or 1,
                is_fast=r_item.metadata.is_fast or False,
                memory=r_item.memory,
                update_type=update_type,
                archived_memory_id=r_item.id,
                created_at=created_at,
            )
            new_item.metadata.history.append(archived)
            logger.info(
                f"[MemoryHistoryManager] Archived related memory {r_item.id} as {update_type} for new item {new_item.id}"
            )

        # 3. Concat duplicate/conflict memories to new_item.memory
        # We will mark those old memories as invisible during fine processing, this op helps to avoid information loss.
        _append_related_content(new_item, duplicate_memories, conflict_memories)

        return duplicate_memories + conflict_memories

    def wait_and_update_fast_history(self, item: TextualMemoryItem, timeout_sec: int = 30) -> None:
        """
        Scan the item's history. If any history item is marked as `is_fast`,
        wait for it to be resolved (i.e., status becomes 'deleted' in the DB).
        When resolved, replace the fast item with the nodes referenced in its `evolve_to` field.
        Finally, deduplicate the history.

        Args:
            item: The memory item containing the history to check.
            timeout_sec: Maximum time to wait for resolution in seconds.
        """
        start_time = time.time()

        # 1. Identify pending items (fast nodes)
        pending_indices = [
            i
            for i, h in enumerate(item.metadata.history)
            if getattr(h, "is_fast", False) and h.archived_memory_id
        ]

        while True:
            if not pending_indices:
                # All fast nodes resolved or none existed
                break

            if time.time() - start_time > timeout_sec:
                logger.warning(
                    f"[MemoryHistoryManager] Timeout waiting for fast history resolution for item {item.id}"
                )
                # Remove pending fast nodes from history
                item.metadata.history = [
                    h
                    for h in item.metadata.history
                    if not (getattr(h, "is_fast", False) and h.archived_memory_id)
                ]
                break

            # 2. Check status of the fast nodes and fetch replacements for evolved ones
            replacements = self._check_and_fetch_replacements(item, pending_indices)

            # 3. If we have any resolved items, rebuild the history
            if replacements:
                _rebuild_fast_node_history(item, replacements)

            # Check if we are done (no pending items left)
            pending_indices = [
                i
                for i, h in enumerate(item.metadata.history)
                if getattr(h, "is_fast", False) and h.archived_memory_id
            ]

            if pending_indices:
                time.sleep(1)  # This avoids visiting the DB too frequently

        return

    def mark_memory_status(
        self,
        memory_items: list[TextualMemoryItem],
        status: Literal["activated", "resolving", "archived", "deleted"],
    ) -> None:
        """
        Support status marking operations during history management. Common usages are:
        1. Mark conflict/duplicate old memories' status as "resolving",
           to make them invisible to /search api, but still visible for PreUpdateRetriever.
        2. Mark resolved memories' status as "activated", to restore their visibility.
        """
        # Execute the actual marking operation - in db.
        with ContextThreadPoolExecutor() as executor:
            futures = []
            for mem in memory_items:
                futures.append(
                    executor.submit(
                        self.graph_db.update_node,
                        id=mem.id,
                        fields={"status": status},
                    )
                )

            # Wait for all tasks to complete and raise any exceptions
            for future in futures:
                future.result()
        return
