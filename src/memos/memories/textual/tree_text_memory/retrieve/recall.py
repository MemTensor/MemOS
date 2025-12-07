import concurrent.futures

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


logger = get_logger(__name__)


class GraphMemoryRetriever:
    """
    Unified memory retriever that combines both graph-based and vector-based retrieval logic.
    """

    def __init__(
        self,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        bm25_retriever: EnhancedBM25 | None = None,
    ):
        self.graph_store = graph_store
        self.embedder = embedder
        self.bm25_retriever = bm25_retriever
        self.max_workers = 10
        self.filter_weight = 0.6
        self.use_bm25 = bool(self.bm25_retriever)

    def retrieve(
        self,
        query: str,
        parsed_goal: ParsedTaskGoal,
        top_k: int,
        memory_scope: str,
        query_embedding: list[list[float]] | None = None,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        use_fast_graph: bool = False,
    ) -> list[TextualMemoryItem]:
        """
        Perform hybrid memory retrieval:
        - Run graph-based lookup from dispatch plan.
        - Run vector similarity search from embedded query.
        - Merge and return combined result set.

        Args:
            query (str): Original task query.
            parsed_goal (dict): parsed_goal.
            top_k (int): Number of candidates to return.
            memory_scope (str): One of ['working', 'long_term', 'user'].
            query_embedding(list of embedding): list of embedding of query
            search_filter (dict, optional): Optional metadata filters for search results.
        Returns:
            list: Combined memory items.
        """
        if memory_scope not in [
            "WorkingMemory",
            "LongTermMemory",
            "UserMemory",
            "ToolSchemaMemory",
            "ToolTrajectoryMemory",
        ]:
            raise ValueError(f"Unsupported memory scope: {memory_scope}")

        if memory_scope == "WorkingMemory":
            # For working memory, retrieve all entries (no session-oriented filtering)
            working_memories = self.graph_store.get_all_memory_items(
                scope="WorkingMemory",
                include_embedding=False,
                user_name=user_name,
                filter=search_filter,
            )
            return [TextualMemoryItem.from_dict(record) for record in working_memories[:top_k]]

        with ContextThreadPoolExecutor(max_workers=3) as executor:
            # Structured graph-based retrieval
            future_graph = executor.submit(
                self._graph_recall,
                parsed_goal,
                memory_scope,
                user_name,
                use_fast_graph=use_fast_graph,
            )
            # Vector similarity search
            future_vector = executor.submit(
                self._vector_recall,
                query_embedding or [],
                memory_scope,
                top_k,
                search_filter=search_filter,
                search_priority=search_priority,
                user_name=user_name,
            )
            if self.use_bm25:
                future_bm25 = executor.submit(
                    self._bm25_recall,
                    query,
                    parsed_goal,
                    memory_scope,
                    top_k=top_k,
                    user_name=user_name,
                    search_filter=id_filter,
                )
            if use_fast_graph:
                future_fulltext = executor.submit(
                    self._fulltext_recall,
                    query_words=parsed_goal.keys or [],
                    memory_scope=memory_scope,
                    top_k=top_k,
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                )

            graph_results = future_graph.result()
            vector_results = future_vector.result()
            bm25_results = future_bm25.result() if self.use_bm25 else []
            fulltext_results = future_fulltext.result() if use_fast_graph else []

        # Merge and deduplicate by ID
        combined = {
            item.id: item
            for item in graph_results + vector_results + bm25_results + fulltext_results
        }

        return list(combined.values())

    def retrieve_from_cube(
        self,
        top_k: int,
        memory_scope: str,
        query_embedding: list[list[float]] | None = None,
        cube_name: str = "memos_cube01",
        user_name: str | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Perform hybrid memory retrieval:
        - Run graph-based lookup from dispatch plan.
        - Run vector similarity search from embedded query.
        - Merge and return combined result set.

        Args:
            top_k (int): Number of candidates to return.
            memory_scope (str): One of ['working', 'long_term', 'user'].
            query_embedding(list of embedding): list of embedding of query
            cube_name: specify cube_name

        Returns:
            list: Combined memory items.
        """
        if memory_scope not in ["WorkingMemory", "LongTermMemory", "UserMemory"]:
            raise ValueError(f"Unsupported memory scope: {memory_scope}")

        graph_results = self._vector_recall(
            query_embedding, memory_scope, top_k, cube_name=cube_name, user_name=user_name
        )

        for result_i in graph_results:
            result_i.metadata.memory_type = "OuterMemory"
        # Merge and deduplicate by ID
        combined = {item.id: item for item in graph_results}

        return list(combined.values())

    def retrieve_from_mixed(
        self,
        top_k: int,
        memory_scope: str | None = None,
        query_embedding: list[list[float]] | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
    ) -> list[TextualMemoryItem]:
        """Retrieve from mixed and memory"""
        vector_results = self._vector_recall(
            query_embedding or [],
            memory_scope,
            top_k,
            search_filter=search_filter,
            user_name=user_name,
        )  # Merge and deduplicate by ID
        combined = {item.id: item for item in vector_results}
        return list(combined.values())

    def _graph_recall(
        self, parsed_goal: ParsedTaskGoal, memory_scope: str, user_name: str | None = None, **kwargs
    ) -> list[TextualMemoryItem]:
        """
        Perform structured node-based retrieval from Neo4j.
        - keys must match exactly (n.key IN keys)
        - tags must overlap with at least 2 input tags
        - scope filters by memory_type if provided
        """
        use_fast_graph = kwargs.get("use_fast_graph", False)

        def process_node(node):
            meta = node.get("metadata", {})
            node_key = meta.get("key")
            node_tags = meta.get("tags", []) or []

            keep = False
            # key equals to node_key
            if parsed_goal.keys and node_key in parsed_goal.keys:
                keep = True
            # overlap tags more than 2
            elif parsed_goal.tags:
                node_tags_list = [tag.lower() for tag in node_tags]
                overlap = len(set(node_tags_list) & set(parsed_goal.tags))
                if overlap >= 2:
                    keep = True

            if keep:
                return TextualMemoryItem.from_dict(node)
            return None

        if not use_fast_graph:
            candidate_ids = set()

            # 1) key-based OR branch
            if parsed_goal.keys:
                key_filters = [
                    {"field": "key", "op": "in", "value": parsed_goal.keys},
                    {"field": "memory_type", "op": "=", "value": memory_scope},
                ]
                key_ids = self.graph_store.get_by_metadata(key_filters, user_name=user_name)
                candidate_ids.update(key_ids)

            # 2) tag-based OR branch
            if parsed_goal.tags:
                tag_filters = [
                    {"field": "tags", "op": "contains", "value": parsed_goal.tags},
                    {"field": "memory_type", "op": "=", "value": memory_scope},
                ]
                tag_ids = self.graph_store.get_by_metadata(tag_filters, user_name=user_name)
                candidate_ids.update(tag_ids)

            # No matches → return empty
            if not candidate_ids:
                return []

            # Load nodes and post-filter
            node_dicts = self.graph_store.get_nodes(list(candidate_ids), include_embedding=False)

            final_nodes = []
            for node in node_dicts:
                meta = node.get("metadata", {})
                node_key = meta.get("key")
                node_tags = meta.get("tags", []) or []

                keep = False
                # key equals to node_key
                if parsed_goal.keys and node_key in parsed_goal.keys:
                    keep = True
                # overlap tags more than 2
                elif parsed_goal.tags:
                    overlap = len(set(node_tags) & set(parsed_goal.tags))
                    if overlap >= 2:
                        keep = True
                if keep:
                    final_nodes.append(TextualMemoryItem.from_dict(node))
            return final_nodes
        else:
            candidate_ids = set()

            # 1) key-based OR branch
            if parsed_goal.keys:
                key_filters = [
                    {"field": "key", "op": "in", "value": parsed_goal.keys},
                    {"field": "memory_type", "op": "=", "value": memory_scope},
                ]
                key_ids = self.graph_store.get_by_metadata(key_filters, user_name=user_name)
                candidate_ids.update(key_ids)

            # 2) tag-based OR branch
            if parsed_goal.tags:
                tag_filters = [
                    {"field": "tags", "op": "contains", "value": parsed_goal.tags},
                    {"field": "memory_type", "op": "=", "value": memory_scope},
                ]
                tag_ids = self.graph_store.get_by_metadata(tag_filters, user_name=user_name)
                candidate_ids.update(tag_ids)

            # No matches → return empty
            if not candidate_ids:
                return []

            # Load nodes and post-filter
            node_dicts = self.graph_store.get_nodes(
                list(candidate_ids), include_embedding=False, user_name=user_name
            )

            final_nodes = []
            with ContextThreadPoolExecutor(max_workers=3) as executor:
                futures = {
                    executor.submit(process_node, node): i for i, node in enumerate(node_dicts)
                }
                temp_results = [None] * len(node_dicts)

                for future in concurrent.futures.as_completed(futures):
                    original_index = futures[future]
                    result = future.result()
                    temp_results[original_index] = result

                final_nodes = [result for result in temp_results if result is not None]
            return final_nodes

    def _vector_recall(
        self,
        query_embedding: list[list[float]],
        memory_scope: str,
        top_k: int = 20,
        max_num: int = 5,
        status: str = "activated",
        cube_name: str | None = None,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Perform vector-based similarity retrieval using query embedding.
        # TODO: tackle with post-filter and pre-filter(5.18+) better.
        """
        if not query_embedding:
            return []

        def search_single(vec, search_priority=None, search_filter=None):
            return (
                self.graph_store.search_by_embedding(
                    vector=vec,
                    top_k=top_k,
                    status=status,
                    scope=memory_scope,
                    cube_name=cube_name,
                    search_filter=search_priority,
                    filter=search_filter,
                    user_name=user_name,
                )
                or []
            )

        def search_path_a():
            """Path A: search without priority"""
            path_a_hits = []
            with ContextThreadPoolExecutor() as executor:
                futures = [
                    executor.submit(search_single, vec, None, search_filter)
                    for vec in query_embedding[:max_num]
                ]
                for f in concurrent.futures.as_completed(futures):
                    path_a_hits.extend(f.result() or [])
            return path_a_hits

        def search_path_b():
            """Path B: search with priority"""
            if not search_priority:
                return []
            path_b_hits = []
            with ContextThreadPoolExecutor() as executor:
                futures = [
                    executor.submit(search_single, vec, search_priority, search_filter)
                    for vec in query_embedding[:max_num]
                ]
                for f in concurrent.futures.as_completed(futures):
                    path_b_hits.extend(f.result() or [])
            return path_b_hits

        # Execute both paths concurrently
        all_hits = []
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            path_a_future = executor.submit(search_path_a)
            path_b_future = executor.submit(search_path_b)

            all_hits.extend(path_a_future.result())
            all_hits.extend(path_b_future.result())

        if not all_hits:
            return []

        # merge and deduplicate
        unique_ids = {r["id"] for r in all_hits if r.get("id")}
        node_dicts = (
            self.graph_store.get_nodes(
                list(unique_ids), include_embedding=False, cube_name=cube_name, user_name=user_name
            )
            or []
        )
        return [TextualMemoryItem.from_dict(n) for n in node_dicts]

    def _bm25_recall(
        self,
        query: str,
        parsed_goal: ParsedTaskGoal,
        memory_scope: str,
        top_k: int = 20,
        user_name: str | None = None,
        search_filter: dict | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Perform BM25-based retrieval.
        """
        if not self.bm25_retriever:
            return []
        key_filters = [
            {"field": "memory_type", "op": "=", "value": memory_scope},
        ]
        # corpus_name is user_name + user_id
        corpus_name = f"{user_name}" if user_name else ""
        if search_filter is not None:
            for key in search_filter:
                value = search_filter[key]
                key_filters.append({"field": key, "op": "=", "value": value})
            corpus_name += "".join(list(search_filter.values()))
        candidate_ids = self.graph_store.get_by_metadata(key_filters, user_name=user_name)
        node_dicts = self.graph_store.get_nodes(list(candidate_ids), include_embedding=False)

        bm25_query = " ".join(list({query, *parsed_goal.keys}))
        bm25_results = self.bm25_retriever.search(
            bm25_query, node_dicts, top_k=top_k, corpus_name=corpus_name
        )

        return [TextualMemoryItem.from_dict(n) for n in bm25_results]

    def _fulltext_recall(
        self,
        query_words: list[str],
        memory_scope: str,
        top_k: int = 20,
        max_num: int = 5,
        status: str = "activated",
        cube_name: str | None = None,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
    ):
        """Perform fulltext-based retrieval.
        Args:
            query_words: list of query words
            memory_scope: memory scope
            top_k: top k results
            max_num: max number of query words
            status: status
            cube_name: cube name
            search_filter: search filter
            search_priority: search priority
            user_name: user name
        Returns:
            list of TextualMemoryItem
        """
        if not query_words:
            return []
        logger.info(f"[FULLTEXT] query_words: {query_words}")
        all_hits = self.graph_store.search_by_fulltext(
            query_words=query_words,
            top_k=top_k,
            status=status,
            scope=memory_scope,
            cube_name=cube_name,
            search_filter=search_priority,
            filter=search_filter,
            user_name=user_name,
        )
        if not all_hits:
            return []

        # merge and deduplicate
        unique_ids = {r["id"] for r in all_hits if r.get("id")}
        node_dicts = (
            self.graph_store.get_nodes(
                list(unique_ids), include_embedding=False, cube_name=cube_name, user_name=user_name
            )
            or []
        )
        return [TextualMemoryItem.from_dict(n) for n in node_dicts]
