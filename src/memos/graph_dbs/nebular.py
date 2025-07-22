import json

from datetime import datetime
from typing import Any, Literal

from memos.configs.graph_db import NebulaGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


def _escape_str(value: str) -> str:
    return value.replace('"', '\\"')


def _format_value(val: Any) -> str:
    if isinstance(val, str):
        return f'"{_escape_str(val)}"'
    elif isinstance(val, int | float):
        return str(val)
    elif isinstance(val, datetime):
        return f'datetime("{val.isoformat()}")'
    elif isinstance(val, list):
        return json.dumps(val)
    elif val is None:
        return "NULL"
    else:
        return f'"{_escape_str(str(val))}"'


def _format_datetime(value: str | datetime) -> str:
    """Ensure datetime is in ISO 8601 format string."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class NebulaGraphDB(BaseGraphDB):
    """
    NebulaGraph-based implementation of a graph memory store.
    """

    @require_python_package(
        import_name="nebulagraph_python",
        install_command="pip install ... @Tianxing",
        install_link=".....",
    )
    def __init__(self, config: NebulaGraphDBConfig):
        """
        NebulaGraph DB client initialization.

        Required config attributes:
        - hosts: list[str] like ["host1:port", "host2:port"]
        - user: str
        - password: str
        - space: str (optional for basic commands)

        Example config:
            {
                "hosts": ["xxx.xx.xx.xxx:xxxx"],
                "user": "root",
                "password": "nebula",
                "space": "test"
            }
        """
        from nebulagraph_python.client import NebulaClient

        self.config = config
        self.client = NebulaClient(
            hosts=config.get("hosts"),
            username=config.get("user_name"),
            password=config.get("password"),
        )
        self.space = config.get("space")
        self.user_name = config.user_name
        self.system_db_name = "system" if config.use_multi_db else config.db_name
        if config.auto_create:
            self._ensure_database_exists()

        # Create only if not exists
        self.create_index(dimensions=config.embedding_dimension)

        logger.info("Connected to NebulaGraph successfully.")

    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 1536,
        index_name: str = "memory_vector_index",
    ) -> None:
        """raise NotImplementedError"""

    def get_memory_count(self, memory_type: str) -> int:
        raise NotImplementedError

    def count_nodes(self, scope: str) -> int:
        raise NotImplementedError

    def remove_oldest_memory(self, memory_type: str, keep_latest: int) -> None:
        raise NotImplementedError

    def add_node(self, id: str, memory: str, metadata: dict[str, Any]) -> None:
        """
        Insert or update a Memory node in NebulaGraph.
        """
        now = datetime.utcnow()
        metadata = metadata.copy()
        metadata.setdefault("created_at", now)
        metadata.setdefault("updated_at", now)
        metadata.pop("embedding")
        metadata["node_type"] = metadata.pop("type")
        metadata["id"] = id
        metadata["memory"] = memory

        print("metadata: ", metadata)
        properties = ", ".join(f"{k}: {_format_value(v)}" for k, v in metadata.items())
        gql = f"INSERT OR IGNORE (n@Memory {{{properties}}})"

        try:
            self.client.execute(gql)
        except Exception as e:
            logger.error(f"Failed to insert vertex {id}: {e}")

    def update_node(self, id: str, fields: dict[str, Any]) -> None:
        raise NotImplementedError

    def delete_node(self, id: str) -> None:
        raise NotImplementedError

    # Edge (Relationship) Management
    def add_edge(self, source_id: str, target_id: str, type: str) -> None:
        raise NotImplementedError

    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        raise NotImplementedError

    def edge_exists(
        self, source_id: str, target_id: str, type: str = "ANY", direction: str = "OUTGOING"
    ) -> bool:
        raise NotImplementedError

    # Graph Query & Reasoning
    def get_node(self, id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def get_nodes(self, ids: list[str]) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_edges(self, id: str, type: str = "ANY", direction: str = "ANY") -> list[dict[str, str]]:
        raise NotImplementedError

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        raise NotImplementedError

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
    ) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_children_with_embeddings(self, id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        raise NotImplementedError

    def get_subgraph(
        self, center_id: str, depth: int = 2, center_status: str = "activated"
    ) -> dict[str, Any]:
        raise NotImplementedError

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        raise NotImplementedError

    # Search / recall operations
    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
    ) -> list[dict]:
        raise NotImplementedError

    def get_by_metadata(self, filters: list[dict[str, Any]]) -> list[str]:
        raise NotImplementedError

    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        raise NotImplementedError

    # Structure Maintenance
    def deduplicate_nodes(self) -> None:
        raise NotImplementedError

    def detect_conflicts(self) -> list[tuple[str, str]]:
        raise NotImplementedError

    def merge_nodes(self, id1: str, id2: str) -> str:
        raise NotImplementedError

    # Utilities
    def clear(self) -> None:
        """
        raise NotImplementedError
        """

    def export_graph(self) -> dict[str, Any]:
        raise NotImplementedError

    def import_graph(self, data: dict[str, Any]) -> None:
        raise NotImplementedError

    def get_all_memory_items(self, scope: str) -> list[dict]:
        raise NotImplementedError

    def get_structure_optimization_candidates(self, scope: str) -> list[dict]:
        raise NotImplementedError

    def drop_database(self) -> None:
        raise NotImplementedError

    def _ensure_database_exists(self):
        create_tag = """
            CREATE GRAPH TYPE IF NOT EXISTS MemoryGraphType AS {
            NODE Memory (:MemoryTag {
                id STRING,
                memory STRING,
                created_at STRING,
                updated_at STRING,
                status STRING,
                node_type STRING,
                memory_time STRING,
                source STRING,
                confidence FLOAT,
                entities LIST<STRING>,
                tags LIST<STRING>,
                visibility STRING,
                memory_type STRING,
                key STRING,
                sources LIST<STRING>,
                usage LIST<STRING>,
                background STRING,
                hierarchy_level STRING,
                PRIMARY KEY(id)
            })
        }
        """
        create_graph = "CREATE GRAPH IF NOT EXISTS memory_graph TYPED MemoryGraphType"
        set_graph_working = "SESSION SET GRAPH memory_graph"

        drop_graph = "DROP GRAPH memory_graph"
        drop_type = "DROP GRAPH TYPE MemoryGraphType"
        try:
            self.client.execute(drop_graph)
            self.client.execute(drop_type)
            self.client.execute(create_tag)
            self.client.execute(create_graph)
            self.client.execute(set_graph_working)
            logger.info("✅ Graph `memory_graph` is now the working graph.")
        except Exception as e:
            logger.error(f"❌ Failed to create tag: {e}")

    def _vector_index_exists(self, index_name: str = "memory_vector_index") -> bool:
        """raise NotImplementedError"""

    def _create_vector_index(
        self, label: str, vector_property: str, dimensions: int, index_name: str
    ) -> None:
        """raise NotImplementedError"""

    def _create_basic_property_indexes(self) -> None:
        """raise NotImplementedError"""

    def _index_exists(self, index_name: str) -> bool:
        """raise NotImplementedError"""

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """ """
        raise NotImplementedError
