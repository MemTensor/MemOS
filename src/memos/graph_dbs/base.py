from abc import ABC, abstractmethod
from typing import Any, Literal


class BaseGraphDB(ABC):
    """
    Abstract base class for a graph database interface used in a memory-augmented RAG system.
    """

    # Node (Memory) Management
    @abstractmethod
    def add_node(self, id: str, memory: str, metadata: dict[str, Any]) -> None:
        """
        Add a memory node to the graph.
        Args:
            id: Unique identifier for the memory node.
            memory: Raw memory content (e.g., text).
            metadata: Dictionary of metadata (e.g., timestamp, tags, source).
        """

    @abstractmethod
    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """
        Update attributes of an existing node.
        Args:
            id: Node identifier to be updated.
            fields: Dictionary of fields to update.
            user_name: given user_name
        """

    @abstractmethod
    def delete_node(self, id: str) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
        """

    # Edge (Relationship) Management
    @abstractmethod
    def add_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Create an edge from source node to target node.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type (e.g., 'FOLLOWS', 'CAUSES', 'PARENT').
        """

    @abstractmethod
    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """

    @abstractmethod
    def edge_exists(self, source_id: str, target_id: str, type: str) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type.
        Returns:
            True if the edge exists, otherwise False.
        """

    # Graph Query & Reasoning
    @abstractmethod
    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        """
        Retrieve the metadata and content of a node.
        Args:
            id: Node identifier.
            include_embedding: with/without embedding
        Returns:
            Dictionary of node fields, or None if not found.
        """

    @abstractmethod
    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> dict[str, Any] | None:
        """
        Retrieve the metadata and memory of a list of nodes.
        Args:
            ids: List of Node identifier.
            include_embedding: with/without embedding
        Returns:
        list[dict]: Parsed node records containing 'id', 'memory', and 'metadata'.
        """

    @abstractmethod
    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """
        Get connected node IDs in a specific direction and relationship type.
        Args:
            id: Source node ID.
            type: Relationship type.
            direction: Edge direction to follow ('out', 'in', or 'both').
        Returns:
            List of neighboring node IDs.
        """

    @abstractmethod
    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """
        Get the path of nodes from source to target within a limited depth.
        Args:
            source_id: Starting node ID.
            target_id: Target node ID.
            max_depth: Maximum path length to traverse.
        Returns:
            Ordered list of node IDs along the path.
        """

    @abstractmethod
    def get_subgraph(self, center_id: str, depth: int = 2) -> list[str]:
        """
        Retrieve a local subgraph centered at a given node.
        Args:
            center_id: Center node ID.
            depth: Radius to include neighboring nodes.
        Returns:
            List of node IDs in the subgraph.
        """

    @abstractmethod
    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """
        Get the ordered context chain starting from a node, following a relationship type.
        Args:
            id: Starting node ID.
            type: Relationship type to follow (e.g., 'FOLLOWS').
        Returns:
            List of ordered node IDs in the chain.
        """

    # Search / recall operations
    @abstractmethod
    def search_by_embedding(self, vector: list[float], top_k: int = 5, **kwargs) -> list[dict]:
        """
        Retrieve node IDs based on vector similarity.

        Args:
            vector (list[float]): The embedding vector representing query semantics.
            top_k (int): Number of top similar nodes to retrieve.

        Returns:
            list[dict]: A list of dicts with 'id' and 'score', ordered by similarity.

        Notes:
            - This method may internally call a VecDB (e.g., Qdrant) or store embeddings in the graph DB itself.
            - Commonly used for RAG recall stage to find semantically similar memories.
        """

    @abstractmethod
    def get_by_metadata(
        self, filters: list[dict[str, Any]], status: str | None = None
    ) -> list[str]:
        """
        Retrieve node IDs that match given metadata filters.

        Args:
            filters (dict[str, Any]): A dictionary of attribute-value filters.
                Example: {"topic": "psychology", "importance": 2}
            status (str, optional): Filter by status (e.g., 'activated', 'archived').
                If None, no status filter is applied.

        Returns:
            list[str]: Node IDs whose metadata match the filter conditions.

        Notes:
            - Supports structured querying such as tag/category/importance/time filtering.
            - Can be used for faceted recall or prefiltering before embedding rerank.
        """

    @abstractmethod
    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False
    ) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """

    # Structure Maintenance
    @abstractmethod
    def deduplicate_nodes(self) -> None:
        """
        Deduplicate redundant or semantically similar nodes.
        This typically involves identifying nodes with identical or near-identical content.
        """

    @abstractmethod
    def detect_conflicts(self) -> list[tuple[str, str]]:
        """
        Detect conflicting nodes based on logical or semantic inconsistency.
        Returns:
            A list of (node_id1, node_id2) tuples that conflict.
        """

    @abstractmethod
    def merge_nodes(self, id1: str, id2: str) -> str:
        """
        Merge two similar or duplicate nodes into one.
        Args:
            id1: First node ID.
            id2: Second node ID.
        Returns:
            ID of the resulting merged node.
        """

    # Utilities
    @abstractmethod
    def clear(self) -> None:
        """
        Clear the entire graph.
        """

    @abstractmethod
    def export_graph(self, include_embedding: bool = False) -> dict[str, Any]:
        """
        Export the entire graph as a serializable dictionary.

        Returns:
            A dictionary containing all nodes and edges.
        """

    @abstractmethod
    def import_graph(self, data: dict[str, Any]) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
        """

    @abstractmethod
    def get_all_memory_items(
        self, scope: str, include_embedding: bool = False, status: str | None = None
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            status (str, optional): Filter by status (e.g., 'activated', 'archived').
                If None, no status filter is applied.

        Returns:
            list[dict]: Full list of memory items under this scope.
        """

    @abstractmethod
    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        """
        Batch add multiple memory nodes to the graph.

        Args:
            nodes: List of node dictionaries, each containing:
                - id: str - Node ID
                - memory: str - Memory content
                - metadata: dict[str, Any] - Node metadata
            user_name: Optional user name (will use config default if not provided)
        """

    @abstractmethod
    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY"
    ) -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.
        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.
        Returns:
            List of edge dicts with 'from', 'to', and 'type' keys.
        """

    @abstractmethod
    def search_by_fulltext(
        self, query_words: list[str], top_k: int = 10, **kwargs
    ) -> list[dict]:
        """
        Full-text search for memory nodes.
        Args:
            query_words: List of words to search for.
            top_k: Maximum number of results.
        Returns:
            List of dicts with 'id' and 'score'.
        """

    @abstractmethod
    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        **kwargs,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.
        Args:
            tags: Tags to match.
            exclude_ids: Node IDs to exclude.
            top_k: Max neighbors to return.
            min_overlap: Minimum overlapping tags required.
        Returns:
            List of node dicts.
        """

    @abstractmethod
    def delete_node_by_prams(
        self,
        memory_ids: list[str] | None = None,
        writable_cube_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
        **kwargs,
    ) -> int:
        """
        Delete nodes matching given parameters.
        Returns:
            Number of deleted nodes.
        """

    @abstractmethod
    def get_user_names_by_memory_ids(self, memory_ids: list[str]) -> list[str]:
        """
        Get distinct user names that own the given memory IDs.
        """

    @abstractmethod
    def exist_user_name(self, user_name: str) -> bool:
        """
        Check if a user_name exists in the graph.
        """

    @abstractmethod
    def search_by_keywords_like(
        self, query_word: str, **kwargs
    ) -> list[dict]:
        """
        Search memories using SQL LIKE pattern matching.
        """

    @abstractmethod
    def search_by_keywords_tfidf(
        self, query_words: list[str], **kwargs
    ) -> list[dict]:
        """
        Search memories using TF-IDF fulltext scoring.
        """
