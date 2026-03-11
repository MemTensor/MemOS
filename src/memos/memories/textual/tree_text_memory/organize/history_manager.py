import json
import logging
import re
import time
import uuid

from datetime import datetime
from typing import Any, Literal

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.base import BaseEmbedder
from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.types import NLIResult
from memos.graph_dbs.base import BaseGraphDB
from memos.llms.base import BaseLLM
from memos.mem_reader.read_multi_modal.utils import detect_lang
from memos.memories.textual.item import (
    ArchivedTextualMemory,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.memories.textual.tree_text_memory.retrieve.pre_update import PreUpdateRetriever
from memos.templates.mem_reader_mem_version_prompts import (
    ASYNC_MEMORY_UPDATE_PROMPT_DICT,
    MEMORY_MERGE_PROMPT_DICT,
)


logger = logging.getLogger(__name__)


def _rebuild_fast_node_history(
    item: TextualMemoryItem, replacements: dict[int, list[ArchivedTextualMemory]]
) -> None:
    """
    Reconstruct the history list of a fast node:
    1. Replace resolved items with their evolved versions.
    2. Deduplicate by ID while preserving the newest versions.
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


def _sanitize_metadata_dict(data: dict[str, Any] | None) -> dict[str, Any]:
    if not data:
        return {}
    sanitized = data.copy()
    for key in ("id", "memory", "graph_id"):
        sanitized.pop(key, None)
    return sanitized


def _sanitize_metadata_model(
    metadata: TreeNodeTextualMemoryMetadata,
) -> TreeNodeTextualMemoryMetadata:
    data = _sanitize_metadata_dict(metadata.model_dump(exclude_none=True))
    return metadata.__class__(**data)


def _determine_lang(sources: list | None, fallback_text: str) -> str:
    lang = None
    if sources:
        for source in sources:
            if hasattr(source, "lang") and source.lang:
                lang = source.lang
                break
            if isinstance(source, dict) and source.get("lang"):
                lang = source.get("lang")
                break
    if lang is None:
        lang = detect_lang(fallback_text)
    return lang


def _parse_json_result(response_text: str) -> dict:
    s = (response_text or "").strip()

    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.I)
    s = (m.group(1) if m else s.replace("```", "")).strip()

    i = s.find("{")
    if i == -1:
        return {}
    s = s[i:].strip()

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    j = max(s.rfind("}"), s.rfind("]"))
    if j != -1:
        try:
            return json.loads(s[: j + 1])
        except json.JSONDecodeError:
            pass

    def _cheap_close(t: str) -> str:
        t += "}" * max(0, t.count("{") - t.count("}"))
        t += "]" * max(0, t.count("[") - t.count("]"))
        return t

    t = _cheap_close(s)
    try:
        return json.loads(t)
    except json.JSONDecodeError as e:
        if "Invalid \\escape" in str(e):
            s = s.replace("\\", "\\\\")
            return json.loads(s)
        logger.warning(
            f"[JSONParse] Failed to decode JSON: {e}\nTail: Raw {response_text} \
            json: {s}"
        )
        return {}


class MemoryHistoryManager:
    def __init__(
        self,
        nli_client: NLIClient,
        graph_db: BaseGraphDB,
        llm: BaseLLM | None = None,
        embedder: BaseEmbedder | None = None,
        pre_update_retriever: PreUpdateRetriever | None = None,
    ) -> None:
        """
        Initialize the MemoryHistoryManager.

        Args:
            nli_client: NLIClient for conflict/duplicate detection.
            graph_db: GraphDB instance for marking operations during history management.
            llm: Optional LLM instance for memory merging during conflicts.
        """
        self.nli_client = nli_client
        self.graph_db = graph_db
        self.llm = llm
        self.embedder = embedder
        self.pre_update_retriever = pre_update_retriever

    def _compute_embedding(self, text: str) -> list[float] | None:
        if not self.embedder:
            return None
        try:
            return self.embedder.embed([text])[0]
        except Exception as e:
            logger.error(f"[MemoryHistoryManager] Failed to compute embedding: {e}")
            return None

    @staticmethod
    def is_applicable(item: TextualMemoryItem) -> bool:
        # Only deals with:
        # 1. From doc or chat
        # 2. LongTermMemory, UserMemory
        allowed_sources = ["doc", "chat"]
        allowed_memory_types = ["LongTermMemory", "UserMemory"]
        return (
            item.metadata.sources[0].type in allowed_sources
            and item.metadata.memory_type in allowed_memory_types
        )

    @staticmethod
    def update_node_with_history(
        item: TextualMemoryItem,
        new_memory: str,
        update_type: str,
        tags: list[str] | None = None,
        key: str | None = None,
    ) -> tuple[TextualMemoryItem, TextualMemoryItem]:
        """
        This method is used to update a given item.
        It updates the item.memory to new_memory, and pushes the old item.memory content to its history.
        Instead, it also creates an archived_item to store the embeddings and sources of the old memory content,
        and stores it to the graph_db.
        """
        now = datetime.now().isoformat()
        last_update_time = item.metadata.updated_at

        old_id = item.id
        archived_id = str(uuid.uuid4())
        # archived memory(need to store this node to the db later)
        archived_item = item.model_copy(deep=True)
        archived_item.id = archived_id
        archived_item.metadata.evolve_to = [old_id]
        archived_item.metadata.status = "archived"
        archived_item.metadata.created_at = last_update_time
        archived_item.metadata.updated_at = now

        # original memory with updated contents and history
        history_item = ArchivedTextualMemory(
            version=item.metadata.version or 1,
            is_fast=item.metadata.is_fast or False,
            memory=item.memory,
            update_type=update_type,
            archived_memory_id=archived_id,
            created_at=getattr(item.metadata, "updated_at", None) or last_update_time,
        )
        item.memory = new_memory
        item.metadata.version = (item.metadata.version or 1) + 1
        item.metadata.status = "activated"
        item.metadata.updated_at = now
        if tags is not None:
            item.metadata.tags = tags
        if key is not None:
            item.metadata.key = key
        if item.metadata.history is None:
            item.metadata.history = []
        item.metadata.history.append(history_item)

        return item, archived_item

    def resolve_history_via_nli(
        self, new_item: TextualMemoryItem, related_items: list[TextualMemoryItem]
    ) -> list[str]:
        """
        Detect relationships (Duplicate/Conflict) between the new item and related items using NLI,
        and attach them as history to the new fast item.

        Args:
            new_item: The new memory item being added.
            related_items: Existing memory items that might be related.

        Returns:
            List of duplicate or conflicting memory ids judged by the NLI service.
        """
        if not related_items:
            return []

        # 1. Call NLI
        nli_results = self.nli_client.compare_one_to_many(
            new_item.memory, [r.memory for r in related_items]
        )

        # 2. Process results and attach to history
        duplicate_memory_ids = []
        conflict_memory_ids = []
        duplicate_memories = []
        conflict_memories = []

        for r_item, nli_res in zip(related_items, nli_results, strict=False):
            if nli_res == NLIResult.DUPLICATE:
                update_type = "duplicate"
                duplicate_memory_ids.append(r_item.id)
                duplicate_memories.append(r_item.memory)
            elif nli_res == NLIResult.CONTRADICTION:
                update_type = "conflict"
                conflict_memory_ids.append(r_item.id)
                conflict_memories.append(r_item.memory)
            else:
                update_type = "unrelated"

            # Safely get created_at, fallback to updated_at
            created_at = getattr(r_item.metadata, "created_at", None) or r_item.metadata.updated_at

            # TODO: change the way of marking fast nodes by directly using is_fast field.
            archived = ArchivedTextualMemory(
                version=r_item.metadata.version or 1,
                is_fast=(
                    r_item.metadata.is_fast
                    or ("mode:fast" in (getattr(r_item.metadata, "tags", None) or []))
                ),
                memory=r_item.memory,
                update_type=update_type,
                archived_memory_id=r_item.id,
                created_at=created_at,
            )
            new_item.metadata.history.append(archived)

        return duplicate_memory_ids + conflict_memory_ids

    def wait_and_update_fast_history(
        self, item: TextualMemoryItem, user_name: str, timeout_sec: int = 30
    ) -> None:
        """
        Scan the item's history. If any history item is marked as `is_fast`,
        wait for it to be resolved (i.e., status becomes 'deleted' in the DB).
        When resolved, replace the fast item with the nodes referenced in its `evolve_to` field.
        Finally, deduplicate the history.

        Args:
            item: The memory item containing the history to check.
            user_name: Required for db query.
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
            replacements = self._check_and_fetch_replacements(item, pending_indices, user_name)

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

    def format_prompt(self, item: TextualMemoryItem, custom_tags_prompt: str = "") -> str:
        """
        Format the prompt for asynchronous memory update.

        Args:
            item: The TextualMemoryItem containing history candidates.
            custom_tags_prompt: Optional custom prompt for tags.

        Returns:
            Formatted prompt string.
        """
        duplicate_candidates = []
        conflict_candidates = []
        unrelated_candidates = []

        def _fmt_time(ts: str | None) -> str | None:
            if not ts or not isinstance(ts, str):
                return None
            try:
                t = datetime.fromisoformat(ts.replace("Z", ""))
                return t.strftime("%Y/%m/%d %H:%M:%S")
            except Exception:
                return ts

        for h in item.metadata.history or []:
            created = getattr(h, "created_at", None)
            tstr = _fmt_time(created)
            time_suffix = f"[Time: {tstr}] " if tstr else ""
            candidate_str = f"[ID:{h.archived_memory_id}]{time_suffix}{h.memory}"

            if h.update_type == "duplicate":
                duplicate_candidates.append(candidate_str)
            elif h.update_type == "conflict":
                conflict_candidates.append(candidate_str)
            else:
                # Includes "unrelated" and any other types
                unrelated_candidates.append(candidate_str)

        sources = item.metadata.sources if item.metadata else None
        lang = _determine_lang(sources, item.memory)
        empty_label = "None"

        def format_list(candidates):
            return "\n".join(candidates) if candidates else empty_label

        prompt_template = ASYNC_MEMORY_UPDATE_PROMPT_DICT.get(
            lang, ASYNC_MEMORY_UPDATE_PROMPT_DICT["en"]
        )
        conversation_time_raw = getattr(item.metadata, "created_at", None)
        conversation_time = _fmt_time(conversation_time_raw) or conversation_time_raw

        return (
            prompt_template.replace("${duplicate_candidates}", format_list(duplicate_candidates))
            .replace("${conflict_candidates}", format_list(conflict_candidates))
            .replace("${unrelated_candidates}", format_list(unrelated_candidates))
            .replace("${custom_tags_prompt}", custom_tags_prompt)
            .replace("${conversation_time}", conversation_time)
            .replace("${conversation}", item.memory)
        )

    def apply_llm_memory_updates(
        self, llm_response: dict[str, Any], source_item: TextualMemoryItem, user_name: str
    ) -> tuple[list[TextualMemoryItem], list[TextualMemoryItem]]:
        """
        Apply the updates from the LLM response to the memory graph.

        Args:
            llm_response: The parsed JSON response from the LLM.
            source_item: The original fast item A whose history contains ArchivedTextualMemory entries.
                         We derive expected versions and candidate IDs from A.history.
            user_name: user_name

        Returns:
            List of new or updated memory items.
        """
        memory_list = llm_response.get("memory list", [])
        restored_memories = llm_response.get("restored_memories", [])

        expected_versions = {}  # For concurrency control, need to get the recorded versions of the old memories
        # Recover candidate IDs and their expected versions from the source item's history
        if source_item.metadata and source_item.metadata.history:
            for h in source_item.metadata.history:
                if h.archived_memory_id:
                    expected_versions[h.archived_memory_id] = h.version

        updated_items: list[TextualMemoryItem] = []
        new_items: list[TextualMemoryItem] = []

        # 1. Handle Unrelated Candidates - Do nothing
        # 2. Handle Memory List (Update or New)
        processed_updates, created_items = self._process_memory_updates(
            memory_list, expected_versions, user_name, source_item
        )
        updated_items.extend(processed_updates)
        new_items.extend(created_items)

        # 3. Handle Restored Memories (Extract from conflict)
        new_items.extend(self._handle_restored_memories(restored_memories, source_item, user_name))

        return updated_items, new_items

    def build_fallback_new_items(
        self, item: TextualMemoryItem, user_name: str | None = None
    ) -> list[TextualMemoryItem]:
        latest_item = item.model_copy(deep=True)

        latest_item.id = str(uuid.uuid4())
        latest_item.metadata.is_fast = False
        latest_item.metadata.status = "activated"
        latest_item.metadata.history = []
        latest_item.metadata.working_binding = None
        if hasattr(latest_item.metadata, "background"):
            latest_item.metadata.background = ""

        if hasattr(latest_item.metadata, "tags") and latest_item.metadata.tags:
            latest_item.metadata.tags = [t for t in latest_item.metadata.tags if t != "mode:fast"]

        latest_item.metadata = _sanitize_metadata_model(latest_item.metadata)

        return [latest_item]

    def mark_memory_status(
        self,
        memory_ids: list[str],
        status: Literal["activated", "resolving", "archived", "deleted"],
        user_name: str,
    ) -> None:
        """
        Support status marking operations during history management. Common usages are:
        1. Mark conflict/duplicate old memories' status as "resolving",
           to make them invisible to /search api, but still visible for PreUpdateRetriever.
        2. Mark resolved memories' status as "activated", to recover their visibility.
        """
        # Execute the actual marking operation - in db.
        with ContextThreadPoolExecutor() as executor:
            futures = []
            for mid in memory_ids:
                futures.append(
                    executor.submit(
                        self.graph_db.update_node,
                        id=mid,
                        fields={"status": status},
                        user_name=user_name,
                    )
                )

            # Wait for all tasks to complete and raise any exceptions
            for future in futures:
                future.result()
        return

    def prepare_history_candidates_via_nli(self, item: TextualMemoryItem, user_name: str) -> None:
        """
        1. Recall related memories
        2. Fast conflict/duplication check with NLI model
        3. Attach conflicting/duplicate old memory contents onto fast memory items
        """
        if not self.is_applicable(item):
            return

        if not self.pre_update_retriever:
            logger.warning("[MemoryHistoryManager] PreUpdateRetriever is not initialized.")
            return

        try:
            # recall related memories
            retrieve_start = time.perf_counter()
            related = self.pre_update_retriever.retrieve(
                item=item,
                user_name=user_name,
            )
            retrieve_ms = (time.perf_counter() - retrieve_start) * 1000
            logger.info(
                "[MemoryHistoryManager] pre_update_retriever.retrieve latency_ms=%.2f item_id=%s",
                retrieve_ms,
                getattr(item, "id", None),
            )
            # NLI check & attaching contents
            nli_start = time.perf_counter()
            conflicting_or_duplicate_ids = self.resolve_history_via_nli(item, related)
            nli_ms = (time.perf_counter() - nli_start) * 1000
            logger.info(
                "[MemoryHistoryManager] history_manager.resolve_history_via_nli latency_ms=%.2f item_id=%s related_count=%s result_count=%s",
                nli_ms,
                getattr(item, "id", None),
                len(related),
                len(conflicting_or_duplicate_ids),
            )

        except Exception as e:
            logger.warning(f"[MultiModalStruct] Fast recall failed: {e}")

    def apply_mem_version_update(
        self,
        original_item: TextualMemoryItem,
        user_name: str,
        llm: BaseLLM | None,
        custom_tags: dict[str, str] | None,
        custom_tags_prompt_template: str | None,
        timeout_sec: int = 30,
    ) -> list[TextualMemoryItem]:
        """
        1. Wait for 'fast histories' in the item to resolve, and rebuild its history
        2. Build memory extraction/update prompt (include custom tags and conversation context)
        3. Call LLM and parse JSON response
        4. Apply LLM updates to memory graph and return new items
        """
        self.prepare_history_candidates_via_nli(original_item, user_name)
        self.wait_and_update_fast_history(original_item, user_name, timeout_sec=timeout_sec)

        custom_tags_prompt = (
            custom_tags_prompt_template.replace("{custom_tags}", str(custom_tags))
            if custom_tags_prompt_template and custom_tags
            else ""
        )
        prompt = self.format_prompt(original_item, custom_tags_prompt)
        try:
            if llm is None:
                raise ValueError("LLM is not initialized")
            response_text = llm.generate([{"role": "user", "content": prompt}])
            if not response_text:
                raise ValueError("Empty LLM response")
            response_json = _parse_json_result(response_text)
            if not response_json:
                raise ValueError("Empty LLM JSON response")

            _, new_items = self.apply_llm_memory_updates(
                response_json, original_item, user_name=user_name
            )
            return new_items

        except Exception as e:
            logger.warning(
                f"[MemoryHistoryManager] Memory extraction/update fallback due to LLM failure: {e}"
            )
            return self.build_fallback_new_items(original_item, user_name=user_name)

    def update_from_feedback(
        self,
        old_item: TextualMemoryItem,
        new_item: TextualMemoryItem,
        user_name: str,
        update_type: Literal[
            "conflict", "duplicate", "extract", "unrelated", "feedback"
        ] = "feedback",
    ) -> tuple[TextualMemoryItem, TextualMemoryItem, dict[str, Any], dict[str, Any]]:
        current_item, archived_item = self.update_node_with_history(
            item=old_item.model_copy(deep=True),
            new_memory=new_item.memory,
            update_type=update_type,
            tags=new_item.metadata.tags,
            key=new_item.metadata.key,
        )
        current_item.metadata.background = new_item.metadata.background
        if getattr(new_item.metadata, "sources", None) is not None:
            current_sources = list(current_item.metadata.sources or [])
            current_item.metadata.sources = list(new_item.metadata.sources or []) + current_sources
        if getattr(new_item.metadata, "embedding", None) is not None:
            current_item.metadata.embedding = new_item.metadata.embedding
        elif self.embedder:
            current_item.metadata.embedding = self._compute_embedding(current_item.memory)
        if current_item.metadata.memory_type == "PreferenceMemory":
            current_item.metadata.preference = current_item.memory

        archived_embedding = getattr(old_item.metadata, "embedding", None)
        if archived_embedding is None:
            archived_embedding = TextualMemoryItem(
                **self.graph_db.get_node(old_item.id, user_name=user_name, include_embedding=True)
            ).metadata.embedding
        arch_meta = _sanitize_metadata_dict(archived_item.metadata.model_dump(exclude_none=True))
        arch_meta["embedding"] = archived_embedding
        metadata_fields = _sanitize_metadata_dict(
            current_item.metadata.model_dump(exclude_none=True)
        )
        history_dump = [
            h.model_dump(exclude_none=True) for h in (current_item.metadata.history or [])
        ]
        update_fields = {
            **metadata_fields,
            "memory": current_item.memory,
            "history": history_dump,
            "version": current_item.metadata.version,
            "covered_history": archived_item.id,
        }
        return current_item, archived_item, arch_meta, update_fields

    def _check_and_fetch_replacements(
        self, item: TextualMemoryItem, pending_indices: list[int], user_name: str
    ) -> tuple[dict[int, list[ArchivedTextualMemory]], list[str]]:
        """
        Check DB status for pending items. If 'deleted', fetch evolved nodes.

        Returns:
            replacements: Dict mapping original history index to list of new ArchivedTextualMemory items.
        """
        pending_ids = [item.metadata.history[i].archived_memory_id for i in pending_indices]

        # Batch fetch pending nodes to check status
        nodes_data = self.graph_db.get_nodes(ids=pending_ids, user_name=user_name) or []
        nodes_map = {n["id"]: TextualMemoryItem(**n) for n in nodes_data if n and "id" in n}

        replacements = {}

        for i in pending_indices:
            h_item = item.metadata.history[i]
            node = nodes_map.get(h_item.archived_memory_id)

            if not node:
                continue

            metadata = _sanitize_metadata_model(node.metadata)  # deal with embedded metadata
            # Condition: Fast node is processed when it is marked as 'deleted'
            if metadata.status == "deleted":
                evolve_to_ids = metadata.evolve_to

                new_items = self._fetch_evolved_nodes(evolve_to_ids, h_item.update_type, user_name)
                replacements[i] = new_items

        return replacements

    def _fetch_evolved_nodes(
        self, evolve_to_ids: list[str], update_type: str, user_name: str
    ) -> list[ArchivedTextualMemory]:
        """Fetch the actual nodes that the fast node evolved into and convert to archive format."""
        if not evolve_to_ids:
            return []

        evolved_nodes = self.graph_db.get_nodes(ids=evolve_to_ids, user_name=user_name) or []
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

    def _process_memory_updates(
        self,
        memory_list: list[dict[str, Any]],
        expected_versions: dict[str, int],
        user_name: str,
        source_item: TextualMemoryItem,
    ) -> tuple[list[TextualMemoryItem], list[TextualMemoryItem]]:
        """Process Memory List (Update or Create)."""
        updated_items: list[TextualMemoryItem] = []
        new_items: list[TextualMemoryItem] = []
        for mem_data in memory_list:
            source_ids = mem_data.get("source_candidate_ids", [])
            conflict_ids = mem_data.get("conflicted_candidate_ids", [])

            # Determine if this is an update or a creation
            target_ids = source_ids + conflict_ids

            if target_ids:
                updated_item, new_item = self._update_existing_memory(
                    mem_data, target_ids, source_ids, expected_versions, user_name, source_item
                )
                if updated_item:
                    updated_items.append(updated_item)
                if new_item:
                    new_items.append(new_item)
            else:
                item = self._create_new_memory(mem_data, source_item)
                new_items.append(item)
        return updated_items, new_items

    def _update_existing_memory(
        self,
        mem_data: dict[str, Any],
        target_ids: list[str],
        source_ids: list[str],
        expected_versions: dict[str, int],
        user_name: str,
        fast_item: TextualMemoryItem,
    ) -> tuple[TextualMemoryItem | None, TextualMemoryItem | None]:
        """
        Update existing memory nodes using the LLM result.

        The first ID in target_ids is treated as the primary node. If additional target IDs
        are provided, they are treated as secondary candidates and will be merged into the
        primary. Merging means:
        1) Mark secondary nodes as archived and append the primary ID to evolve_to
        2) Merge their history entries into the primary history and re-order by created_at

        The method also applies CAS validation via expected_versions, archives the previous
        version of the primary node, and persists the updated node back to the graph DB.

        Returns the updated primary TextualMemoryItem and optional new item when fallback is used.
        """
        primary_id, secondary_ids = target_ids[0], target_ids[1:]
        new_memory_value, tags, key = (
            mem_data.get("value", ""),
            mem_data.get("tags", []),
            mem_data.get("key", ""),
        )

        # Fetch candidate nodes in batch and then select the primary
        # We update the primary and then merge the secondaries to the primary
        nodes_data = self.graph_db.get_nodes(target_ids, user_name=user_name) or []
        nodes_map = {n["id"]: n for n in nodes_data if n and "id" in n}
        node_data = nodes_map.get(primary_id)
        if not node_data:
            logger.warning(
                f"[MemoryHistoryManager] Target node {primary_id} not found for update. Skipping."
            )
            # Fallback to create new item when the source_id is not valid(hallucination from llm)
            new_item = self._create_new_memory(mem_data, fast_item)
            return None, new_item
        current_item = TextualMemoryItem(**node_data)

        # For concurrency control, need to make sure the primary item has not been modified by others during the run.
        # If it has(version changed), then we need to use llm to merge again.
        new_memory_value = self._apply_cas_merge(
            primary_id, current_item, expected_versions, new_memory_value
        )

        update_type = "duplicate" if primary_id in source_ids else "conflict"
        current_item, archived_item = self.update_node_with_history(
            current_item,
            new_memory_value,
            update_type,
            tags=tags,
            key=key,
        )

        # create archived node for storing older versions of the memory, preserving the embedding
        emb = TextualMemoryItem(
            **self.graph_db.get_node(primary_id, user_name=user_name, include_embedding=True)
        ).metadata.embedding
        arch_meta = _sanitize_metadata_dict(archived_item.metadata.model_dump(exclude_none=True))
        arch_meta["embedding"] = emb
        self.graph_db.add_node(
            id=archived_item.id,
            memory=archived_item.memory,
            metadata=arch_meta,
            user_name=user_name,
        )

        fields = _sanitize_metadata_dict(current_item.metadata.model_dump(exclude_none=True))
        merged_history = list(current_item.metadata.history or [])
        new_primary_version = current_item.metadata.version or 1
        # Multiple related ids indicates existing duplicates/conflicts to be merged
        if secondary_ids:
            merged_history, new_primary_version = self._merge_secondary_nodes(
                secondary_ids, primary_id, nodes_map, user_name, merged_history
            )
            current_item.metadata.history = merged_history
            current_item.metadata.version = new_primary_version
        merged_history_dump = [h.model_dump(exclude_none=True) for h in merged_history]
        embedding = self._compute_embedding(current_item.memory)
        sources = [s.model_dump(exclude_none=True) for s in (fast_item.metadata.sources or [])]
        # update old memory node with new content and updated history
        self.graph_db.update_node(
            id=primary_id,
            fields={
                **fields,
                "memory": current_item.memory,
                "history": merged_history_dump,
                "version": new_primary_version,
                "embedding": embedding,
                "sources": sources,
                "session_id": fast_item.metadata.session_id,
            },
            user_name=user_name,
        )
        working_binding = getattr(current_item.metadata, "working_binding", None)
        if working_binding and working_binding != current_item.id:
            try:
                self.mark_memory_status([str(working_binding)], "deleted", user_name=user_name)
            except Exception as e:
                logger.warning(
                    f"[MemoryHistoryManager] Failed to mark WorkingMemory {working_binding} as deleted: {e}"
                )

        return current_item, None

    def _apply_cas_merge(
        self,
        primary_id: str,
        current_item: TextualMemoryItem,
        expected_versions: dict[str, int],
        new_memory_value: str,
    ) -> str:
        expected_version = expected_versions.get(primary_id)
        current_version = current_item.metadata.version or 1
        if expected_version is not None and current_version != expected_version:
            logger.warning(
                f"[MemoryHistoryManager] Version conflict for node {primary_id}: "
                f"Expected v{expected_version}, but found v{current_version} in DB. "
                "Triggering merge logic."
            )
            merged_content = self._merge_conflicting_memory(
                latest_memory=current_item.memory,
                proposed_update=new_memory_value,
            )
            return merged_content

        return new_memory_value

    def _merge_secondary_nodes(
        self,
        secondary_ids: list[str],
        primary_id: str,
        nodes_map: dict,
        user_name: str,
        base_history: list[ArchivedTextualMemory],
    ) -> tuple[list[ArchivedTextualMemory], int]:
        merged_history = list(base_history)

        for memory_id in secondary_ids:
            node_data = nodes_map.get(memory_id)
            if not node_data:
                continue
            metadata = node_data.get("metadata", {})
            evolve_to = list(metadata.get("evolve_to", []) or [])
            if primary_id not in evolve_to:
                evolve_to.append(primary_id)
            # set secondary nodes to archived and record their evolving destinations
            self.graph_db.update_node(
                id=memory_id,
                fields={"status": "archived", "evolve_to": evolve_to},
                user_name=user_name,
            )
            secondary_item = TextualMemoryItem(**node_data)
            if secondary_item.metadata.history:
                merged_history.extend(secondary_item.metadata.history)

        # Currently we just sort the versions according to their creation time
        def _history_sort_key(history_item: ArchivedTextualMemory) -> datetime:
            created_at = history_item.created_at
            if isinstance(created_at, datetime):
                return created_at
            if created_at:
                try:
                    return datetime.fromisoformat(created_at)
                except ValueError:
                    return datetime.min
            return datetime.min

        def _dedupe_history_by_archived_id(
            history: list[ArchivedTextualMemory],
        ) -> list[ArchivedTextualMemory]:
            seen_archived_ids: set[str] = set()
            deduped_history: list[ArchivedTextualMemory] = []
            for history_item in history:
                archived_id = history_item.archived_memory_id
                if archived_id and archived_id in seen_archived_ids:
                    continue
                if archived_id:
                    seen_archived_ids.add(archived_id)
                deduped_history.append(history_item)
            return deduped_history

        merged_history.sort(key=_history_sort_key)
        merged_history = _dedupe_history_by_archived_id(merged_history)
        max_version = 0
        for idx, history_item in enumerate(merged_history, start=1):
            history_item.version = idx
            max_version = idx
        return merged_history, max_version + 1

    def _merge_conflicting_memory(self, latest_memory: str, proposed_update: str) -> str:
        """
        Call LLM to merge proposed update with latest memory content.
        """
        if not self.llm:
            return proposed_update

        lang = _determine_lang(None, f"{latest_memory}\n{proposed_update}")
        prompt_template = MEMORY_MERGE_PROMPT_DICT.get(lang, MEMORY_MERGE_PROMPT_DICT["en"])
        prompt = prompt_template.replace("${latest_memory}", latest_memory).replace(
            "${proposed_update}", proposed_update
        )

        messages = [{"role": "user", "content": prompt}]
        try:
            response = self.llm.generate(messages)
            if not response:
                raise ValueError("LLM response is None.")
            return response.strip()
        except Exception as e:
            logger.error(f"[MemoryHistoryManager] Failed to merge memory via LLM: {e}")
            # Fallback: concatenate as a safe fallback.
            return f"{latest_memory}\n\n[New Info]: {proposed_update}"

    def _create_new_memory(
        self, mem_data: dict[str, Any], fast_item: TextualMemoryItem
    ) -> TextualMemoryItem:
        """Create New Node."""
        new_value = mem_data.get("value", "")
        new_value_item = TextualMemoryItem(
            memory=new_value, metadata=TreeNodeTextualMemoryMetadata()
        )
        new_value = new_value_item.memory
        tags = mem_data.get("tags", [])
        key = mem_data.get("key", "")
        background = mem_data.get("summary", "")
        memory_type = mem_data.get("memory_type", "LongTermMemory")
        metadata_updates = {
            "is_fast": False,
            "version": 1,
            "memory_type": memory_type,
            "status": "activated",
            "background": background,
            "working_binding": None,
            "tags": tags,
            "key": key,
            "created_at": datetime.now().isoformat(),
            "history": [],
            "embedding": self._compute_embedding(new_value),
        }
        metadata = fast_item.metadata.model_copy(deep=True)
        for field_name, field_value in metadata_updates.items():
            setattr(metadata, field_name, field_value)
        metadata = _sanitize_metadata_model(metadata)

        new_item = TextualMemoryItem(
            id=str(uuid.uuid4()),
            memory=new_value,
            metadata=metadata,
        )
        return new_item

    def _handle_restored_memories(
        self, restored_memories: list[dict[str, Any]], fast_item: TextualMemoryItem, user_name: str
    ) -> list[TextualMemoryItem]:
        """Handle Restored Memories (Extract from conflict)."""
        source_ids = [r.get("source_candidate_id") for r in restored_memories]
        source_items = self.graph_db.get_nodes(source_ids, user_name=user_name)
        source_items = [TextualMemoryItem(**i) for i in source_items]

        created_items = []
        for i, data in enumerate(restored_memories):
            source_item = source_items[i]
            # deal with history
            source_history = source_item.metadata.history.copy()
            value = data.get("value", "")
            value_item = TextualMemoryItem(memory=value, metadata=TreeNodeTextualMemoryMetadata())
            value = value_item.memory
            tags = data.get("tags", [])
            key = data.get("key", "")
            memory_type = data.get("memory_type", "LongTermMemory")
            original_sources = source_item.metadata.sources
            version = source_item.metadata.version
            new_history_item = ArchivedTextualMemory(
                version=version,
                is_fast=False,
                memory=source_item.memory,
                update_type="extract",
                archived_memory_id=source_item.id,
                created_at=source_item.metadata.created_at,
            )
            source_history.append(new_history_item)  # Re-use the history of the old node
            # Create new node
            metadata_updates = {
                "memory_type": memory_type,
                "status": "activated",
                "is_fast": False,
                "version": version + 1,
                "sources": original_sources,
                "tags": tags,
                "key": key,
                "created_at": datetime.now().isoformat(),
                "history": source_history,
                "embedding": self._compute_embedding(value),
            }
            metadata = fast_item.metadata.model_copy(deep=True)
            for field_name, field_value in metadata_updates.items():
                setattr(metadata, field_name, field_value)
            metadata = _sanitize_metadata_model(metadata)

            new_item = TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory=value,
                metadata=metadata,
            )

            created_items.append(new_item)

        return created_items
