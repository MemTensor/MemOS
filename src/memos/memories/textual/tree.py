import concurrent.futures
import json
import os
import shutil
import tempfile
import time

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from memos.configs.memory import TreeTextMemoryConfig
from memos.configs.reranker import RerankerConfigFactory
from memos.context.context import ContextThreadPoolExecutor
from memos.dependency import require_python_package
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.graph_dbs.factory import GraphStoreFactory, Neo4jGraphDB
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.mem_reader.read_multi_modal.utils import detect_lang
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.advanced_searcher import (
    AdvancedSearcher as Searcher,
)
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import StopwordManager
from memos.reranker.factory import RerankerFactory
from memos.types import MessageList


logger = get_logger(__name__)


class TreeTextMemory(BaseTextMemory):
    """General textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: TreeTextMemoryConfig):
        """Initialize memory with the given configuration."""
        # Set mode from class default or override if needed
        self.mode = config.mode
        logger.info(f"Tree mode is {self.mode}")

        self.config: TreeTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.dispatcher_llm
        )
        self.embedder: OllamaEmbedder = EmbedderFactory.from_config(config.embedder)
        self.graph_store: Neo4jGraphDB = GraphStoreFactory.from_config(config.graph_db)

        self.search_strategy = config.search_strategy
        self.bm25_retriever = (
            EnhancedBM25() if self.search_strategy and self.search_strategy["bm25"] else None
        )

        if config.reranker is None:
            default_cfg = RerankerConfigFactory.model_validate(
                {
                    "backend": "cosine_local",
                    "config": {
                        "level_weights": {"topic": 1.0, "concept": 1.0, "fact": 1.0},
                        "level_field": "background",
                    },
                }
            )
            self.reranker = RerankerFactory.from_config(default_cfg)
        else:
            self.reranker = RerankerFactory.from_config(config.reranker)
        self.is_reorganize = config.reorganize
        self.memory_manager: MemoryManager = MemoryManager(
            self.graph_store,
            self.embedder,
            self.extractor_llm,
            memory_size=config.memory_size
            or {
                "WorkingMemory": 20,
                "LongTermMemory": 1500,
                "UserMemory": 480,
            },
            is_reorganize=self.is_reorganize,
        )
        # Create internet retriever if configured
        self.internet_retriever = None
        if config.internet_retriever is not None:
            self.internet_retriever = InternetRetrieverFactory.from_config(
                config.internet_retriever, self.embedder
            )
            logger.info(
                f"Internet retriever initialized with backend: {config.internet_retriever.backend}"
            )
        else:
            logger.info("No internet retriever configured")
        self.tokenizer = None
        self.include_embedding = config.include_embedding or False

    def add(
        self,
        memories: list[TextualMemoryItem | dict[str, Any]],
        user_name: str | None = None,
        **kwargs,
    ) -> list[str]:
        """Add memories.
        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
            user_name: optional user_name
        """
        return self.memory_manager.add(memories, user_name=user_name, mode=self.mode)

    def replace_working_memory(
        self, memories: list[TextualMemoryItem], user_name: str | None = None
    ) -> None:
        self.memory_manager.replace_working_memory(memories, user_name=user_name)

    def get_working_memory(self, user_name: str | None = None) -> list[TextualMemoryItem]:
        working_memories = self.graph_store.get_all_memory_items(
            scope="WorkingMemory", user_name=user_name
        )
        items = [TextualMemoryItem.from_dict(record) for record in (working_memories)]
        # Sort by updated_at in descending order
        sorted_items = sorted(
            items, key=lambda x: x.metadata.updated_at or datetime.min, reverse=True
        )
        return sorted_items

    def get_current_memory_size(self, user_name: str | None = None) -> dict[str, int]:
        """
        Get the current size of each memory type.
        This delegates to the MemoryManager.
        """
        return self.memory_manager.get_current_memory_size(user_name=user_name)

    def get_searcher(
        self, manual_close_internet: bool = False, moscube: bool = False, process_llm=None
    ):
        searcher = Searcher(
            self.dispatcher_llm,
            self.graph_store,
            self.embedder,
            self.reranker,
            bm25_retriever=self.bm25_retriever,
            internet_retriever=None,
            search_strategy=self.search_strategy,
            manual_close_internet=manual_close_internet,
            process_llm=process_llm,
            tokenizer=self.tokenizer,
            include_embedding=self.include_embedding,
        )
        return searcher

    def search(
        self,
        query: str,
        top_k: int,
        info=None,
        mode: str = "fast",
        memory_type: str = "All",
        manual_close_internet: bool = True,
        search_priority: dict | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        include_skill_memory: bool = False,
        skill_mem_top_k: int = 3,
        include_preference_memory: bool = False,
        pref_mem_top_k: int = 6,
        dedup: str | None = None,
        include_embedding: bool | None = None,
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        User query -> TaskGoalParser -> MemoryPathResolver ->
        GraphMemoryRetriever -> MemoryReranker -> MemoryReasoner -> Final output
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
            mode (str, optional): The mode of the search.
            - 'fast': Uses a faster search process, sacrificing some precision for speed.
            - 'fine': Uses a more detailed search process, invoking large models for higher precision, but slower performance.
            memory_type (str): Type restriction for search.
            ['All', 'WorkingMemory', 'LongTermMemory', 'UserMemory']
            manual_close_internet (bool): If True, the internet retriever will be closed by this search, it high priority than config.
            search_filter (dict, optional): Optional metadata filters for search results.
                - Keys correspond to memory metadata fields (e.g., "user_id", "session_id").
                - Values are exact-match conditions.
                Example: {"user_id": "123", "session_id": "abc"}
                If None, no additional filtering is applied.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        # Use parameter if provided, otherwise fall back to instance attribute
        include_emb = include_embedding if include_embedding is not None else self.include_embedding

        searcher = Searcher(
            self.dispatcher_llm,
            self.graph_store,
            self.embedder,
            self.reranker,
            bm25_retriever=self.bm25_retriever,
            internet_retriever=self.internet_retriever,
            search_strategy=self.search_strategy,
            manual_close_internet=manual_close_internet,
            tokenizer=self.tokenizer,
            include_embedding=include_emb,
        )
        return searcher.search(
            query,
            top_k,
            info,
            mode,
            memory_type,
            search_filter,
            search_priority,
            user_name=user_name,
            search_tool_memory=search_tool_memory,
            tool_mem_top_k=tool_mem_top_k,
            include_skill_memory=include_skill_memory,
            skill_mem_top_k=skill_mem_top_k,
            include_preference_memory=include_preference_memory,
            pref_mem_top_k=pref_mem_top_k,
            dedup=dedup,
            **kwargs,
        )

    def get_relevant_subgraph(
        self,
        query: str,
        top_k: int = 20,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
        search_type: Literal["embedding", "fulltext"] = "fulltext",
    ) -> dict[str, Any]:
        """
        Find and merge the local neighborhood sub-graphs of the top-k
        nodes most relevant to the query.
         Process:
             1. Embed the user query into a vector representation.
             2. Use vector similarity search to find the top-k similar nodes.
             3. For each similar node:
                 - Ensure its status matches `center_status` (e.g., 'active').
                 - Retrieve its local subgraph up to `depth` hops.
                 - Collect the center node, its neighbors, and connecting edges.
             4. Merge all retrieved subgraphs into a single unified subgraph.
             5. Return the merged subgraph structure.

         Args:
             query (str): The user input or concept to find relevant memories for.
             top_k (int, optional): How many top similar nodes to retrieve. Default is 5.
             depth (int, optional): The neighborhood depth (number of hops). Default is 2.
             center_status (str, optional): Status condition the center node must satisfy (e.g., 'active').

         Returns:
             dict[str, Any]: A subgraph dict with:
                 - 'core_id': ID of the top matching core node, or None if none found.
                 - 'nodes': List of unique nodes (core + neighbors) in the merged subgraph.
                 - 'edges': List of unique edges (as dicts with 'from', 'to', 'type') in the merged subgraph.
        """
        if search_type == "embedding":
            # Step 1: Embed query
            query_embedding = self.embedder.embed([query])[0]

            # Step 2: Get top-1 similar node
            similar_nodes = self.graph_store.search_by_embedding(
                query_embedding, top_k=top_k, user_name=user_name
            )

        elif search_type == "fulltext":

            @require_python_package(
                import_name="jieba",
                install_command="pip install jieba",
                install_link="https://github.com/fxsjy/jieba",
            )
            def _tokenize_chinese(text):
                """split zh jieba"""
                import jieba

                stopword_manager = StopwordManager()
                tokens = jieba.lcut(text)
                tokens = [token.strip() for token in tokens if token.strip()]
                return stopword_manager.filter_words(tokens)

            lang = detect_lang(query)
            queries = _tokenize_chinese(query) if lang == "zh" else query.split()

            similar_nodes = self.graph_store.search_by_fulltext(
                query_words=queries,
                top_k=top_k,
                user_name=user_name,
            )

        if not similar_nodes:
            logger.info("No similar nodes found for query embedding.")
            return {"core_id": None, "nodes": [], "edges": []}

        # Step 3: Fetch neighborhood
        all_nodes = {}
        all_edges = set()
        cores = []

        for node in similar_nodes:
            core_id = node["id"]
            score = node["score"]

            subgraph = self.graph_store.get_subgraph(
                center_id=core_id, depth=depth, center_status=center_status, user_name=user_name
            )

            if subgraph is None or not subgraph["core_node"]:
                node = self.graph_store.get_node(core_id, user_name=user_name)
                subgraph["neighbors"] = [node]

            core_node = subgraph["core_node"]
            neighbors = subgraph["neighbors"]
            edges = subgraph["edges"]

            # Collect nodes
            if core_node:
                all_nodes[core_node["id"]] = core_node
            for n in neighbors:
                all_nodes[n["id"]] = n

            # Collect edges
            for e in edges:
                all_edges.add((e["source"], e["target"], e["type"]))

            cores.append(
                {"id": core_id, "score": score, "core_node": core_node, "neighbors": neighbors}
            )

        top_core = cores[0] if cores else None
        return {
            "core_id": top_core["id"] if top_core else None,
            "nodes": list(all_nodes.values()),
            "edges": [{"source": f, "target": t, "type": ty} for (f, t, ty) in all_edges],
        }

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        raise NotImplementedError

    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        raise NotImplementedError

    def get(self, memory_id: str, user_name: str | None = None) -> TextualMemoryItem:
        """Get a memory by its ID."""
        result = self.graph_store.get_node(memory_id, user_name=user_name)
        if result is None:
            logger.warning(
                "[TreeTextMemory.get] Memory not found. memory_id=%s, lookup_user_name=%s, graph_store=%s, db_name=%s, config_user_name=%s",
                memory_id,
                user_name,
                type(self.graph_store).__name__,
                getattr(self.graph_store, "db_name", None),
                getattr(getattr(self.graph_store, "config", None), "user_name", None),
            )
            raise ValueError(f"Memory with ID {memory_id} not found")
        metadata_dict = result.get("metadata", {})
        return TextualMemoryItem(
            id=result["id"],
            memory=result["memory"],
            metadata=TreeNodeTextualMemoryMetadata(**metadata_dict),
        )

    def get_by_ids(
        self, memory_ids: list[str], user_name: str | None = None
    ) -> list[TextualMemoryItem]:
        graph_output = self.graph_store.get_nodes(ids=memory_ids, user_name=user_name)
        return graph_output

    def get_all(
        self,
        user_name: str | None = None,
        user_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        filter: dict | None = None,
        memory_type: list[str] | None = None,
    ) -> dict:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """
        graph_output = self.graph_store.export_graph(
            user_name=user_name,
            user_id=user_id,
            page=page,
            page_size=page_size,
            filter=filter,
            memory_type=memory_type,
        )
        return graph_output

    def delete(self, memory_ids: str | list[str], user_name: str | None = None) -> None:
        """Hard delete: permanently remove nodes and their edges from the graph."""
        if not memory_ids:
            return
        if isinstance(memory_ids, str):
            memory_ids = [memory_ids]
        self._unlink_knowledge_relations(memory_ids, user_name=user_name)
        for mid in memory_ids:
            try:
                self.graph_store.delete_node(mid, user_name=user_name)
            except Exception as e:
                logger.warning(f"TreeTextMemory.delete_hard: failed to delete {mid}: {e}")

    def delete_by_memory_ids(self, memory_ids: list[str]) -> None:
        """Delete memories by memory_ids."""
        try:
            self._unlink_knowledge_relations(memory_ids)
            self.graph_store.delete_node_by_prams(memory_ids=memory_ids)
        except Exception as e:
            logger.error(f"An error occurred while deleting memories by memory_ids: {e}")

    def delete_all(self, user_name: str | None = None) -> None:
        """Delete all memories and their relationships from the graph store."""
        try:
            self.graph_store.clear(user_name=user_name)
            logger.info("All memories and edges have been deleted from the graph.")
        except Exception as e:
            logger.error(f"An error occurred while deleting all memories: {e}")
            raise

    def delete_by_filter(
        self,
        writable_cube_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> None:
        """Delete memories by filter."""
        if file_ids:
            user_names = writable_cube_ids or [None]
            for user_name in user_names:
                memory_ids: set[str] = set()
                for file_id in file_ids:
                    memory_ids.update(
                        self.graph_store.get_by_metadata(
                            [{"field": "file_ids", "op": "contains", "value": file_id}],
                            user_name=user_name,
                        )
                    )
                self._unlink_knowledge_relations(list(memory_ids), user_name=user_name)
        self.graph_store.delete_node_by_prams(
            writable_cube_ids=writable_cube_ids, file_ids=file_ids, filter=filter
        )

    @staticmethod
    def _node_metadata(node: dict[str, Any] | TextualMemoryItem) -> dict[str, Any]:
        if isinstance(node, TextualMemoryItem):
            return node.metadata.model_dump()
        return node.get("metadata") or {}

    def _get_node_map(
        self, memory_ids: list[str] | set[str], user_name: str | None = None
    ) -> dict[str, dict[str, Any] | TextualMemoryItem]:
        if not memory_ids:
            return {}
        nodes = self.graph_store.get_nodes(ids=list(memory_ids), user_name=user_name) or []
        return {
            node.id if isinstance(node, TextualMemoryItem) else node["id"]: node for node in nodes
        }

    def _unlink_knowledge_relations(
        self, memory_ids: list[str], user_name: str | None = None
    ) -> None:
        """Remove reverse knowledge ids before deleting or deactivating nodes."""
        deleting_ids = set(memory_ids)
        deleting_nodes = self._get_node_map(deleting_ids, user_name=user_name)
        removals: dict[str, dict[str, set[str]]] = {}

        for memory_id, node in deleting_nodes.items():
            metadata = self._node_metadata(node)
            for material_id in metadata.get("knowledge_material_ids") or []:
                if material_id not in deleting_ids:
                    removals.setdefault(material_id, {}).setdefault(
                        "knowledge_summary_ids", set()
                    ).add(memory_id)
            for summary_id in metadata.get("knowledge_summary_ids") or []:
                if summary_id not in deleting_ids:
                    removals.setdefault(summary_id, {}).setdefault(
                        "knowledge_material_ids", set()
                    ).add(memory_id)

        related_nodes = self._get_node_map(set(removals), user_name=user_name)
        for related_id, fields in removals.items():
            node = related_nodes.get(related_id)
            if node is None:
                continue
            metadata = self._node_metadata(node)
            updates = {
                field: [value for value in metadata.get(field) or [] if value not in removed_ids]
                for field, removed_ids in fields.items()
            }
            self.graph_store.update_node(related_id, updates, user_name=user_name)

    def load(self, dir: str, user_name: str | None = None) -> None:
        try:
            memory_file = os.path.join(dir, self.config.memory_filename)

            if not os.path.exists(memory_file):
                logger.warning(f"Memory file not found: {memory_file}")
                return

            with open(memory_file, encoding="utf-8") as f:
                memories = json.load(f)

            self.graph_store.import_graph(memories, user_name=user_name)
            logger.info(f"Loaded {len(memories)} memories from {memory_file}")

        except FileNotFoundError:
            logger.error(f"Memory file not found in directory: {dir}")
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding JSON from memory file: {e}")
        except Exception as e:
            logger.error(f"An error occurred while loading memories: {e}")

    def dump(self, dir: str, include_embedding: bool = False, user_name: str | None = None) -> None:
        """Dump memories to os.path.join(dir, self.config.memory_filename)"""
        try:
            json_memories = self.graph_store.export_graph(
                include_embedding=include_embedding, user_name=user_name
            )

            os.makedirs(dir, exist_ok=True)
            memory_file = os.path.join(dir, self.config.memory_filename)
            with open(memory_file, "w", encoding="utf-8") as f:
                json.dump(json_memories, f, indent=4, ensure_ascii=False)

            logger.info(f"Dumped {len(json_memories.get('nodes'))} memories to {memory_file}")

        except Exception as e:
            logger.error(f"An error occurred while dumping memories: {e}")
            raise

    def drop(self, keep_last_n: int = 30) -> None:
        """
        Export all memory data to a versioned backup dir and drop the Neo4j database.
        Only the latest `keep_last_n` backups will be retained.
        """
        try:
            backup_root = Path(tempfile.gettempdir()) / "memos_backups"
            backup_root.mkdir(parents=True, exist_ok=True)

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_dir = backup_root / f"memos_backup_{timestamp}"
            backup_dir.mkdir()

            logger.info(f"Exporting memory to backup dir: {backup_dir}")
            self.dump(str(backup_dir))

            # Clean up old backups
            self._cleanup_old_backups(backup_root, keep_last_n)

            self.graph_store.drop_database()
            logger.info(f"Database '{self.graph_store.db_name}' dropped after backup.")

        except Exception as e:
            logger.error(f"Error in drop(): {e}")
            raise

    @staticmethod
    def _cleanup_old_backups(root_dir: Path, keep_last_n: int) -> None:
        """
        Keep only the latest `keep_last_n` backup directories under `root_dir`.
        Older ones will be deleted.
        """
        backups = sorted(
            [d for d in root_dir.iterdir() if d.is_dir() and d.name.startswith("memos_backup_")],
            key=lambda p: p.name,  # name includes timestamp
            reverse=True,
        )

        to_delete = backups[keep_last_n:]
        for old_dir in to_delete:
            try:
                shutil.rmtree(old_dir)
                logger.info(f"Deleted old backup directory: {old_dir}")
            except Exception as e:
                logger.warning(f"Failed to delete backup {old_dir}: {e}")

    def add_rawfile_nodes_n_edges(
        self,
        raw_file_mem_group: list[TextualMemoryItem],
        mem_ids: list[str],
        user_id: str | None = None,
        user_name: str | None = None,
    ) -> None:
        """
        Add raw file nodes and edges to the graph. Edges are between raw file ids and mem_ids.
        Args:
            raw_file_mem_group: List of raw file memory items.
            mem_ids: List of memory IDs.
            user_name: cube id.
        """
        rawfile_ids_local: list[str] = self.add(
            raw_file_mem_group,
            user_name=user_name,
        )

        from_ids = []
        to_ids = []
        types = []

        for raw_file_mem in raw_file_mem_group:
            # Add SUMMARY edge: memory -> raw file; raw file -> memory
            if hasattr(raw_file_mem.metadata, "summary_ids") and raw_file_mem.metadata.summary_ids:
                summary_ids = raw_file_mem.metadata.summary_ids
                for summary_id in summary_ids:
                    if summary_id in mem_ids:
                        from_ids.append(summary_id)
                        to_ids.append(raw_file_mem.id)
                        types.append("MATERIAL")

                        from_ids.append(raw_file_mem.id)
                        to_ids.append(summary_id)
                        types.append("SUMMARY")

            # Add FOLLOWING edge: current chunk -> next chunk
            if (
                hasattr(raw_file_mem.metadata, "following_id")
                and raw_file_mem.metadata.following_id
            ):
                following_id = raw_file_mem.metadata.following_id
                if following_id in rawfile_ids_local:
                    from_ids.append(raw_file_mem.id)
                    to_ids.append(following_id)
                    types.append("FOLLOWING")

            # Add PRECEDING edge: previous chunk -> current chunk
            if (
                hasattr(raw_file_mem.metadata, "preceding_id")
                and raw_file_mem.metadata.preceding_id
            ):
                preceding_id = raw_file_mem.metadata.preceding_id
                if preceding_id in rawfile_ids_local:
                    from_ids.append(raw_file_mem.id)
                    to_ids.append(preceding_id)
                    types.append("PRECEDING")

        start_time = time.time()
        self.add_graph_edges(
            from_ids,
            to_ids,
            types,
            user_name=user_name,
        )
        end_time = time.time()
        logger.info(f"[RawFile] Added {len(rawfile_ids_local)} chunks for user {user_id}")
        logger.info(
            f"[RawFile] Time taken to add edges: {end_time - start_time} seconds for {len(from_ids)} edges"
        )

    def add_rawfile_nodes(
        self,
        raw_file_mem_group: list[TextualMemoryItem],
        mem_ids: list[str],
        user_id: str | None = None,
        user_name: str | None = None,
    ) -> None:
        """Persist raw-file nodes and their knowledge relationships without graph edges."""
        valid_summary_ids = set(mem_ids)
        summary_to_material_ids: dict[str, list[str]] = {}

        for raw_file_mem in raw_file_mem_group:
            summary_ids = list(
                dict.fromkeys(
                    summary_id
                    for summary_id in getattr(raw_file_mem.metadata, "summary_ids", []) or []
                    if summary_id in valid_summary_ids
                )
            )
            raw_file_mem.metadata.knowledge_summary_ids = summary_ids
            for summary_id in summary_ids:
                summary_to_material_ids.setdefault(summary_id, []).append(raw_file_mem.id)

        self.add(raw_file_mem_group, user_name=user_name)
        summary_nodes = self._get_node_map(set(summary_to_material_ids), user_name=user_name)

        merged_from_by_summary: dict[str, list[str]] = {}
        old_summary_ids: set[str] = set()
        for summary_id, node in summary_nodes.items():
            info = self._node_metadata(node).get("info") or {}
            merged_from = info.get("merged_from") or []
            if isinstance(merged_from, str):
                merged_from = [merged_from]
            merged_from_by_summary[summary_id] = list(dict.fromkeys(merged_from))
            old_summary_ids.update(merged_from)

        old_summary_nodes = self._get_node_map(old_summary_ids, user_name=user_name)
        material_relinks: dict[str, dict[str, Any]] = {}

        for summary_id, direct_material_ids in summary_to_material_ids.items():
            summary_node = summary_nodes.get(summary_id)
            if summary_node is None:
                logger.warning(
                    "Knowledge summary %s was not found after raw-file write", summary_id
                )
                continue

            metadata = self._node_metadata(summary_node)
            merged_from = merged_from_by_summary.get(summary_id, [])
            inherited_material_ids: list[str] = []
            for old_summary_id in merged_from:
                old_summary = old_summary_nodes.get(old_summary_id)
                if old_summary is not None:
                    inherited_material_ids.extend(
                        self._node_metadata(old_summary).get("knowledge_material_ids") or []
                    )

            material_ids = list(
                dict.fromkeys(
                    [
                        *(metadata.get("knowledge_material_ids") or []),
                        *direct_material_ids,
                        *inherited_material_ids,
                    ]
                )
            )
            self.graph_store.update_node(
                summary_id,
                {"knowledge_material_ids": material_ids},
                user_name=user_name,
            )

            for material_id in inherited_material_ids:
                relink = material_relinks.setdefault(material_id, {"remove": set(), "add": []})
                relink["remove"].update(merged_from)
                relink["add"].append(summary_id)

        material_nodes = self._get_node_map(set(material_relinks), user_name=user_name)
        for material_id, relink in material_relinks.items():
            material_node = material_nodes.get(material_id)
            if material_node is None:
                continue
            current_summary_ids = (
                self._node_metadata(material_node).get("knowledge_summary_ids") or []
            )
            updated_summary_ids = [
                summary_id
                for summary_id in current_summary_ids
                if summary_id not in relink["remove"]
            ]
            updated_summary_ids.extend(relink["add"])
            self.graph_store.update_node(
                material_id,
                {"knowledge_summary_ids": list(dict.fromkeys(updated_summary_ids))},
                user_name=user_name,
            )

        logger.info(
            "[RawFile] Added %s chunks with ID mappings for user %s",
            len(raw_file_mem_group),
            user_id,
        )

    def add_graph_edges(
        self, from_ids: list[str], to_ids: list[str], types: list[str], user_name: str | None = None
    ) -> None:
        """
        Add edges to the graph.
        Args:
            from_ids: List of source node IDs.
            to_ids: List of target node IDs.
            types: List of edge types.
            user_name: Optional user name.
        """
        with ContextThreadPoolExecutor(max_workers=20) as executor:
            futures = {
                executor.submit(
                    self.graph_store.add_edge, from_id, to_id, edge_type, user_name=user_name
                )
                for from_id, to_id, edge_type in zip(from_ids, to_ids, types, strict=False)
            }

            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.exception("Add edge error: ", exc_info=e)

    def soft_delete(
        self,
        memory_ids: list[str],
        user_name: str,
        evolve_to_ids: list[str] | None = None,
    ) -> None:
        self._unlink_knowledge_relations(memory_ids, user_name=user_name)
        # for ruff check...
        if not evolve_to_ids:
            update_fields = {"status": "deleted"}
        else:
            update_fields = {"status": "deleted", "evolve_to": evolve_to_ids}

        # Execute the actual marking operation - in db.
        with ContextThreadPoolExecutor() as executor:
            futures = []
            for mid in memory_ids:
                futures.append(
                    executor.submit(
                        self.graph_store.update_node,
                        id=mid,
                        fields=update_fields,
                        user_name=user_name,
                    )
                )

            # Wait for all tasks to complete and raise any exceptions
            for future in futures:
                future.result()
        return
