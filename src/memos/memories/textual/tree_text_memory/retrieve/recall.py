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
        include_embedding: bool = False,
    ):
        self.graph_store = graph_store
        self.embedder = embedder
        self.bm25_retriever = bm25_retriever
        self.max_workers = 10
        self.filter_weight = 0.6
        self.use_bm25 = bool(self.bm25_retriever)
        self.include_embedding = include_embedding

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
            "RawFileMemory",
            "SkillMemory",
            "PreferenceMemory",
        ]:
            raise ValueError(f"Unsupported memory scope: {memory_scope}")

        if memory_scope == "WorkingMemory":
            # For working memory, retrieve all entries (no session-oriented filtering)
            working_memories = self.graph_store.get_all_memory_items(
                scope="WorkingMemory",
                include_embedding=self.include_embedding,
                user_name=user_name,
                filter=search_filter,
                status="activated",
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

    # Memory scopes for which the substring fallback path is enabled. Other
    # scopes (PreferenceMemory, SkillMemory, Tool*Memory, RawFileMemory) have
    # their own dedicated retrieval pipelines and should not be backfilled by
    # this generic fast-mode rescue branch.
    _FALLBACK_SCOPES = frozenset({"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"})
    # Cap how many memories the fallback path scans / returns to avoid pulling
    # the entire user namespace when the strict filters legitimately miss.
    _FALLBACK_CAP = 50

    @staticmethod
    def _node_matches_parsed_goal(
        parsed_goal: ParsedTaskGoal, node: dict, min_tag_overlap: int = 1
    ) -> bool:
        """Lenient post-filter for structured graph retrieval.

        A node passes if any of the following holds:
        * its ``metadata.key`` is exactly one of ``parsed_goal.keys``;
        * any parsed key appears as a substring of the node's ``key`` or raw
          ``memory`` text (covers fast-mode memories whose ``key`` is the raw
          chat-formatted message and whose ``tags`` are uninformative);
        * the intersection between parsed tags and node tags is at least
          ``min_tag_overlap`` (case-insensitive).

        The previous behavior required exact key equality OR ``>= 2`` tag
        overlap, which excluded all memories ingested via the fast pipeline.
        """
        meta = node.get("metadata") or {}
        if not isinstance(meta, dict):
            meta = {}
        node_key = meta.get("key") or ""
        node_tags = meta.get("tags") or []
        node_memory = node.get("memory") or ""

        parsed_keys = [k for k in (parsed_goal.keys or []) if isinstance(k, str) and k]
        if parsed_keys:
            if node_key and node_key in parsed_keys:
                return True
            haystack = f"{node_key}\n{node_memory}"
            if any(pk in haystack for pk in parsed_keys):
                return True

        parsed_tags = [t for t in (parsed_goal.tags or []) if isinstance(t, str) and t]
        if parsed_tags and node_tags:
            node_tags_lower = {t.lower() if isinstance(t, str) else t for t in node_tags}
            parsed_tags_lower = {t.lower() for t in parsed_tags}
            if len(node_tags_lower & parsed_tags_lower) >= min_tag_overlap:
                return True

        return False

    def _fallback_candidates_by_substring(
        self,
        parsed_goal: ParsedTaskGoal,
        memory_scope: str,
        user_name: str | None,
        status: str | None = None,
    ) -> list[dict]:
        """Substring-based candidate retrieval used when the strict key/tag
        filters return nothing.

        Fixes issue #1448: memories added via the fast pipeline (e.g.
        ``/product/add`` with ``async_mode=async`` or ``mode=fast``) store the
        raw chat-formatted text as ``key`` and only ``["mode:fast"]`` as
        ``tags``. When the search query is parsed in fine mode the LLM emits
        high-level semantic keys/tags (e.g. ``["喜欢", "偏好", "兴趣"]``) that
        never exactly match those stored values, so the strict ``key IN ...``
        / tag-overlap branches return zero candidates and the graph-recall
        path used to drop the memory entirely.
        """
        parsed_keys = [k for k in (parsed_goal.keys or []) if isinstance(k, str) and k]
        if not parsed_keys:
            return []
        if memory_scope not in self._FALLBACK_SCOPES:
            return []

        kwargs: dict = {"user_name": user_name}
        if status:
            kwargs["status"] = status
        try:
            items = self.graph_store.get_all_memory_items(scope=memory_scope, **kwargs)
        except Exception:
            logger.warning(
                "[_graph_recall] fallback get_all_memory_items failed for scope=%s",
                memory_scope,
                exc_info=True,
            )
            return []

        matched: list[dict] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            meta = item.get("metadata") or {}
            node_key = (meta.get("key") if isinstance(meta, dict) else "") or ""
            node_memory = item.get("memory") or ""
            haystack = f"{node_key}\n{node_memory}"
            if any(pk in haystack for pk in parsed_keys):
                matched.append(item)
                if len(matched) >= self._FALLBACK_CAP:
                    break
        return matched

    def _graph_recall(
        self, parsed_goal: ParsedTaskGoal, memory_scope: str, user_name: str | None = None, **kwargs
    ) -> list[TextualMemoryItem]:
        """
        Perform structured node-based retrieval from Neo4j.
        - keys match exactly (n.key IN keys) or as a substring of the node
          ``key``/``memory`` (handles fast-mode memories where the LLM-parsed
          semantic key is contained in the literal stored text).
        - tags overlap with at least 1 input tag (lowered from 2 to recover
          single-tag matches; embedding/rerank still ranks final order).
        - scope filters by memory_type if provided.
        """
        use_fast_graph = kwargs.get("use_fast_graph", False)

        def process_node(node):
            if self._node_matches_parsed_goal(parsed_goal, node):
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

            # No matches via strict filters → try substring fallback on the
            # raw memory text. Fixes issue #1448 for fast-mode memories.
            if not candidate_ids:
                fallback_items = self._fallback_candidates_by_substring(
                    parsed_goal=parsed_goal,
                    memory_scope=memory_scope,
                    user_name=user_name,
                )
                if not fallback_items:
                    return []
                final_nodes = [
                    TextualMemoryItem.from_dict(node)
                    for node in fallback_items
                    if self._node_matches_parsed_goal(parsed_goal, node)
                ]
                return final_nodes

            # Load nodes and post-filter
            node_dicts = self.graph_store.get_nodes(
                list(candidate_ids), include_embedding=self.include_embedding, user_name=user_name
            )

            final_nodes = []
            for node in node_dicts:
                if self._node_matches_parsed_goal(parsed_goal, node):
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
                key_ids = self.graph_store.get_by_metadata(
                    key_filters, user_name=user_name, status="activated"
                )
                candidate_ids.update(key_ids)

            # 2) tag-based OR branch
            if parsed_goal.tags:
                tag_filters = [
                    {"field": "tags", "op": "contains", "value": parsed_goal.tags},
                    {"field": "memory_type", "op": "=", "value": memory_scope},
                ]
                tag_ids = self.graph_store.get_by_metadata(
                    tag_filters, user_name=user_name, status="activated"
                )
                candidate_ids.update(tag_ids)

            # No matches via strict filters → substring fallback so fast-mode
            # memories remain reachable when the LLM-parsed semantic keys
            # don't exactly equal the stored chat-formatted key. Mirrors the
            # non-fast-graph branch and fixes issue #1448 for fast-graph too.
            if not candidate_ids:
                fallback_items = self._fallback_candidates_by_substring(
                    parsed_goal=parsed_goal,
                    memory_scope=memory_scope,
                    user_name=user_name,
                    status="activated",
                )
                if not fallback_items:
                    return []
                return [
                    TextualMemoryItem.from_dict(node)
                    for node in fallback_items
                    if self._node_matches_parsed_goal(parsed_goal, node)
                ]

            # Load nodes and post-filter
            node_dicts = self.graph_store.get_nodes(
                list(candidate_ids), include_embedding=self.include_embedding, user_name=user_name
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
        max_num: int = 20,
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

        # merge and deduplicate, keeping highest score per ID
        id_to_score = {}
        for r in all_hits:
            rid = r.get("id")
            if rid:
                rid = str(rid).strip("\"'")
                score = r.get("score", 0.0)
                if rid not in id_to_score or score > id_to_score[rid]:
                    id_to_score[rid] = score

        # Sort IDs by score (descending) to preserve ranking
        sorted_ids = sorted(id_to_score.keys(), key=lambda x: id_to_score[x], reverse=True)

        node_dicts = (
            self.graph_store.get_nodes(
                sorted_ids,
                include_embedding=self.include_embedding,
                cube_name=cube_name,
                user_name=user_name,
            )
            or []
        )

        # Restore score-based order and inject scores into metadata
        id_to_node = {}
        for n in node_dicts:
            node_id = n.get("id")
            if node_id:
                # Ensure ID is a string and strip any surrounding quotes
                node_id = str(node_id).strip("\"'")
                id_to_node[node_id] = n

        ordered_nodes = []
        for rid in sorted_ids:
            # Ensure rid is normalized for matching
            rid_normalized = str(rid).strip("\"'")
            if rid_normalized in id_to_node:
                node = id_to_node[rid_normalized]
                # Inject similarity score as relativity
                if "metadata" not in node:
                    node["metadata"] = {}
                node["metadata"]["relativity"] = id_to_score.get(rid, 0.0)
                ordered_nodes.append(node)

        return [TextualMemoryItem.from_dict(n) for n in ordered_nodes]

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
        candidate_ids = self.graph_store.get_by_metadata(
            key_filters, user_name=user_name, status="activated"
        )
        node_dicts = self.graph_store.get_nodes(
            list(candidate_ids), include_embedding=self.include_embedding, user_name=user_name
        )

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

        # merge and deduplicate, keeping highest score per ID
        id_to_score = {}
        for r in all_hits:
            rid = r.get("id")
            if rid:
                # Ensure ID is a string and strip any surrounding quotes
                rid = str(rid).strip("\"'")
                score = r.get("score", 0.0)
                if rid not in id_to_score or score > id_to_score[rid]:
                    id_to_score[rid] = score

        # Sort IDs by score (descending) to preserve ranking
        sorted_ids = sorted(id_to_score.keys(), key=lambda x: id_to_score[x], reverse=True)

        node_dicts = (
            self.graph_store.get_nodes(
                sorted_ids,
                include_embedding=self.include_embedding,
                cube_name=cube_name,
                user_name=user_name,
            )
            or []
        )

        # Restore score-based order and inject scores into metadata
        id_to_node = {}
        for n in node_dicts:
            node_id = n.get("id")
            if node_id:
                # Ensure ID is a string and strip any surrounding quotes
                node_id = str(node_id).strip("\"'")
                id_to_node[node_id] = n

        ordered_nodes = []
        for rid in sorted_ids:
            # Ensure rid is normalized for matching
            rid_normalized = str(rid).strip("\"'")
            if rid_normalized in id_to_node:
                node = id_to_node[rid_normalized]
                # Inject similarity score as relativity
                if "metadata" not in node:
                    node["metadata"] = {}
                node["metadata"]["relativity"] = id_to_score.get(rid, 0.0)
                ordered_nodes.append(node)

        return [TextualMemoryItem.from_dict(n) for n in ordered_nodes]
