import json
import os
import shutil
import tempfile
import time

from datetime import datetime
from pathlib import Path
from typing import Any

from memos.configs.memory import TreeTextMemoryConfig
from memos.configs.reranker import RerankerConfigFactory
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.graph_dbs.factory import GraphStoreFactory, Neo4jGraphDB
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.factory import RerankerFactory
from memos.types import MessageList


logger = get_logger(__name__)


class TreeTextMemory(BaseTextMemory):
    """General textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: TreeTextMemoryConfig):
        """Initialize memory with the given configuration."""
        time_start = time.time()
        self.config: TreeTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        logger.info(f"time init: extractor_llm time is: {time.time() - time_start}")

        time_start_ex = time.time()
        self.dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.dispatcher_llm
        )
        logger.info(f"time init: dispatcher_llm time is: {time.time() - time_start_ex}")

        time_start_em = time.time()
        self.embedder: OllamaEmbedder = EmbedderFactory.from_config(config.embedder)
        logger.info(f"time init: embedder time is: {time.time() - time_start_em}")

        time_start_gs = time.time()
        self.graph_store: Neo4jGraphDB = GraphStoreFactory.from_config(config.graph_db)
        logger.info(f"time init: graph_store time is: {time.time() - time_start_gs}")

        time_start_rr = time.time()
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
        logger.info(f"time init: reranker time is: {time.time() - time_start_rr}")
        self.is_reorganize = config.reorganize

        time_start_mm = time.time()
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
        logger.info(f"time init: memory_manager time is: {time.time() - time_start_mm}")
        time_start_ir = time.time()
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
        logger.info(f"time init: internet_retriever time is: {time.time() - time_start_ir}")

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> list[str]:
        """Add memories.
        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        Later:
            memory_items = [TextualMemoryItem(**m) if isinstance(m, dict) else m for m in memories]
            metadata = extract_metadata(memory_items, self.extractor_llm)
            plan = plan_memory_operations(memory_items, metadata, self.graph_store)
            execute_plan(memory_items, metadata, plan, self.graph_store)
        """
        return self.memory_manager.add(memories)

    def replace_working_memory(self, memories: list[TextualMemoryItem]) -> None:
        self.memory_manager.replace_working_memory(memories)

    def get_working_memory(self) -> list[TextualMemoryItem]:
        working_memories = self.graph_store.get_all_memory_items(scope="WorkingMemory")
        items = [TextualMemoryItem.from_dict(record) for record in (working_memories)]
        # Sort by updated_at in descending order
        sorted_items = sorted(
            items, key=lambda x: x.metadata.updated_at or datetime.min, reverse=True
        )
        return sorted_items

    def get_current_memory_size(self) -> dict[str, int]:
        """
        Get the current size of each memory type.
        This delegates to the MemoryManager.
        """
        return self.memory_manager.get_current_memory_size()

    def search(
        self,
        query: str,
        top_k: int,
        info=None,
        mode: str = "fast",
        memory_type: str = "All",
        manual_close_internet: bool = False,
        moscube: bool = False,
        search_filter: dict | None = None,
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
            moscube (bool): whether you use moscube to answer questions
            search_filter (dict, optional): Optional metadata filters for search results.
                - Keys correspond to memory metadata fields (e.g., "user_id", "session_id").
                - Values are exact-match conditions.
                Example: {"user_id": "123", "session_id": "abc"}
                If None, no additional filtering is applied.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        if (self.internet_retriever is not None) and manual_close_internet:
            logger.warning(
                "Internet retriever is init by config , but  this search set manual_close_internet is True  and will close it"
            )
            searcher = Searcher(
                self.dispatcher_llm,
                self.graph_store,
                self.embedder,
                self.reranker,
                internet_retriever=None,
                moscube=moscube,
            )
        else:
            searcher = Searcher(
                self.dispatcher_llm,
                self.graph_store,
                self.embedder,
                self.reranker,
                internet_retriever=self.internet_retriever,
                moscube=moscube,
            )
        return searcher.search(query, top_k, info, mode, memory_type, search_filter)

    def get_relevant_subgraph(
        self, query: str, top_k: int = 5, depth: int = 2, center_status: str = "activated"
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
        # Step 1: Embed query
        query_embedding = self.embedder.embed([query])[0]

        # Step 2: Get top-1 similar node
        similar_nodes = self.graph_store.search_by_embedding(query_embedding, top_k=top_k)
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
                center_id=core_id, depth=depth, center_status=center_status
            )

            if not subgraph["core_node"]:
                logger.info(f"Skipping node {core_id} (inactive or not found).")
                continue

            core_node = subgraph["core_node"]
            neighbors = subgraph["neighbors"]
            edges = subgraph["edges"]

            # Collect nodes
            all_nodes[core_node["id"]] = core_node
            for n in neighbors:
                all_nodes[n["id"]] = n

            # Collect edges
            for e in edges:
                all_edges.add((e["source"], e["target"], e["type"]))

            cores.append(
                {"id": core_id, "score": score, "core_node": core_node, "neighbors": neighbors}
            )

        top_core = cores[0]
        return {
            "core_id": top_core["id"],
            "nodes": list(all_nodes.values()),
            "edges": [{"source": f, "target": t, "type": ty} for (f, t, ty) in all_edges],
        }

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        raise NotImplementedError

    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        raise NotImplementedError

    def get(self, memory_id: str) -> TextualMemoryItem:
        """Get a memory by its ID."""
        result = self.graph_store.get_node(memory_id)
        if result is None:
            raise ValueError(f"Memory with ID {memory_id} not found")
        metadata_dict = result.get("metadata", {})
        return TextualMemoryItem(
            id=result["id"],
            memory=result["memory"],
            metadata=TreeNodeTextualMemoryMetadata(**metadata_dict),
        )

    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        raise NotImplementedError

    def get_all(self) -> dict:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """
        all_items = self.graph_store.export_graph()
        return all_items

    def delete(self, memory_ids: list[str]) -> None:
        raise NotImplementedError

    def delete_all(self) -> None:
        """Delete all memories and their relationships from the graph store."""
        try:
            self.graph_store.clear()
            logger.info("All memories and edges have been deleted from the graph.")
        except Exception as e:
            logger.error(f"An error occurred while deleting all memories: {e}")
            raise

    def load(self, dir: str) -> None:
        try:
            memory_file = os.path.join(dir, self.config.memory_filename)

            if not os.path.exists(memory_file):
                logger.warning(f"Memory file not found: {memory_file}")
                return

            with open(memory_file, encoding="utf-8") as f:
                memories = json.load(f)

            self.graph_store.import_graph(memories)
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
            json_memories = self.graph_store.export_graph()

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
