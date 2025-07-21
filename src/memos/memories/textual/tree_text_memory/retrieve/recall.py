import concurrent.futures

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


class GraphMemoryRetriever:
    """
    Unified memory retriever that combines both graph-based and vector-based retrieval logic.
    """

    def __init__(self, graph_store: Neo4jGraphDB, embedder: OllamaEmbedder):
        self.graph_store = graph_store
        self.embedder = embedder

    def retrieve(
        self,
        query: str,
        parsed_goal: ParsedTaskGoal,
        top_k: int,
        memory_scope: str,
        query_embedding: list[list[float]] | None = None,
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

        Returns:
            list: Combined memory items.
        """
        if memory_scope not in ["WorkingMemory", "LongTermMemory", "UserMemory"]:
            raise ValueError(f"Unsupported memory scope: {memory_scope}")

        if memory_scope == "WorkingMemory":
            # For working memory, retrieve all entries (no filtering)
            working_memories = self.graph_store.get_all_memory_items(scope="WorkingMemory")
            return [TextualMemoryItem.from_dict(record) for record in working_memories]

        # Step 1: Structured graph-based retrieval
        graph_results = self._graph_recall(parsed_goal, memory_scope)

        # Step 2: Vector similarity search
        vector_results = self._vector_recall(query_embedding, memory_scope, top_k)

        # Step 3: Merge and deduplicate results
        combined = {item.id: item for item in graph_results + vector_results}

        graph_ids = {item.id for item in graph_results}
        combined_ids = set(combined.keys())
        lost_ids = graph_ids - combined_ids

        if lost_ids:
            print(
                f"[DEBUG] The following nodes were in graph_results but missing in combined: {lost_ids}"
            )

        return list(combined.values())

    def _graph_recall(
        self, parsed_goal: ParsedTaskGoal, memory_scope: str
    ) -> list[TextualMemoryItem]:
        """
        Perform structured node-based retrieval from Neo4j.
        - keys must match exactly (n.key IN keys)
        - tags must overlap with at least 2 input tags
        - scope filters by memory_type if provided
        """
        candidate_ids = set()

        # 1) key-based OR branch
        if parsed_goal.keys:
            key_filters = [
                {"field": "key", "op": "in", "value": parsed_goal.keys},
                {"field": "memory_type", "op": "=", "value": memory_scope},
            ]
            key_ids = self.graph_store.get_by_metadata(key_filters)
            candidate_ids.update(key_ids)

        # 2) tag-based OR branch
        if parsed_goal.tags:
            tag_filters = [
                {"field": "tags", "op": "contains", "value": parsed_goal.tags},
                {"field": "memory_type", "op": "=", "value": memory_scope},
            ]
            tag_ids = self.graph_store.get_by_metadata(tag_filters)
            candidate_ids.update(tag_ids)

        # No matches → return empty
        if not candidate_ids:
            return []

        # Load nodes and post-filter
        node_dicts = self.graph_store.get_nodes(list(candidate_ids))

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

    def _vector_recall(
        self,
        query_embedding: list[list[float]],
        memory_scope: str,
        top_k: int = 20,
        max_num: int = 5,
    ) -> list[TextualMemoryItem]:
        """
        # TODO: tackle with post-filter and pre-filter(5.18+) better.
        Perform vector-based similarity retrieval using query embedding.
        """
        all_matches = []

        def search_single(vec):
            return (
                self.graph_store.search_by_embedding(vector=vec, top_k=top_k, scope=memory_scope)
                or []
            )

        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = [executor.submit(search_single, vec) for vec in query_embedding[:max_num]]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                all_matches.extend(result)

        if not all_matches:
            return []

        # Step 3: Extract matched IDs and retrieve full nodes
        unique_ids = set({r["id"] for r in all_matches})
        node_dicts = self.graph_store.get_nodes(list(unique_ids))

        return [TextualMemoryItem.from_dict(record) for record in node_dicts]
