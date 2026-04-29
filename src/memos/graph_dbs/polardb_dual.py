import os

from typing import Any, Literal

from memos.configs.graph_db import PolarDBGraphDBConfig
from memos.graph_dbs.base import BaseGraphDB
from memos.graph_dbs.polardb import PolarDBGraphDB
from memos.graph_dbs.polardb_legacy import PolarDBGraphDBLegacy
from memos.log import get_logger


logger = get_logger(__name__)


ReadTarget = Literal["shard", "legacy"]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "y", "on")


def _env_str(name: str, default: str, allowed: tuple[str, ...]) -> str:
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip().lower()
    if raw not in allowed:
        logger.warning(
            "env %s=%r not in %s, falling back to default %r", name, raw, allowed, default
        )
        return default
    return raw


class PolarDBGraphDBDualMode(BaseGraphDB):
    def __init__(self, config: PolarDBGraphDBConfig):
        self.config = config

        self._read_target: ReadTarget = _env_str(  # type: ignore[assignment]
            "MEMOS_POLARDB_READ_TARGET", "shard", ("shard", "legacy")
        )
        self._dual_write_enabled: bool = _env_bool(
            "MEMOS_POLARDB_DUAL_WRITE_ENABLED", True
        )

        logger.info(
            "PolarDBGraphDBDualMode init: read_target=%s, dual_write_enabled=%s",
            self._read_target,
            self._dual_write_enabled,
        )

        self.shard = PolarDBGraphDB(config)
        self.legacy = PolarDBGraphDBLegacy(config)

    def set_read_target(self, target: ReadTarget) -> None:
        if target not in ("shard", "legacy"):
            raise ValueError(f"Invalid read_target: {target!r}")
        old = self._read_target
        self._read_target = target
        logger.warning("read_target switched: %s -> %s", old, target)

    def set_dual_write_enabled(self, enabled: bool) -> None:
        old = self._dual_write_enabled
        self._dual_write_enabled = bool(enabled)
        logger.warning(
            "dual_write_enabled switched: %s -> %s", old, self._dual_write_enabled
        )

    def get_runtime_config(self) -> dict[str, Any]:
        return {
            "read_target": self._read_target,
            "dual_write_enabled": self._dual_write_enabled,
        }

    def _read_backend(self) -> BaseGraphDB:
        return self.legacy if self._read_target == "legacy" else self.shard

    def _dual_write(self, method_name: str, *args, **kwargs) -> Any:
        result = getattr(self.shard, method_name)(*args, **kwargs)

        if not self._dual_write_enabled:
            return result

        legacy_method = getattr(self.legacy, method_name, None)
        if legacy_method is None:
            logger.warning("legacy has no method %s, skip", method_name)
            return result

        try:
            legacy_method(*args, **kwargs)
        except Exception as e:
            logger.warning("legacy.%s failed (best-effort, ignored): %s", method_name, e)
        return result

    def add_node(
        self,
        id: str,
        memory: str,
        metadata: dict[str, Any],
        user_name: str | None = None,
    ) -> None:
        return self._dual_write("add_node", id, memory, metadata, user_name)

    def add_nodes_batch(
        self, nodes: list[dict[str, Any]], user_name: str | None = None
    ) -> None:
        return self._dual_write("add_nodes_batch", nodes, user_name)

    def update_node(
        self, id: str, fields: dict[str, Any], user_name: str | None = None
    ) -> None:
        return self._dual_write("update_node", id, fields, user_name)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        return self._dual_write("delete_node", id, user_name)

    def remove_oldest_memory(self, *args, **kwargs):
        return self._dual_write("remove_oldest_memory", *args, **kwargs)

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        print("111111")
        return self._dual_write(
            "delete_node_by_prams",
            writable_cube_ids=writable_cube_ids,
            memory_ids=memory_ids,
            file_ids=file_ids,
            filter=filter,
        )

    def delete_node_by_mem_cube_id(self, *args, **kwargs):
        return self._dual_write("delete_node_by_mem_cube_id", *args, **kwargs)

    def recover_memory_by_mem_cube_id(self, *args, **kwargs):
        return self._dual_write("recover_memory_by_mem_cube_id", *args, **kwargs)

    def add_edge(self, *args, **kwargs):
        return self._dual_write("add_edge", *args, **kwargs)

    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        return self._dual_write("delete_edge", source_id, target_id, type)

    def merge_nodes(self, id1: str, id2: str) -> str:
        return self._dual_write("merge_nodes", id1, id2)

    def deduplicate_nodes(self) -> None:
        return self._dual_write("deduplicate_nodes")

    def clear(self, user_name: str | None = None) -> None:
        return self._dual_write("clear", user_name)

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        return self._dual_write("import_graph", data, user_name)

    def get_node(self, id: str, include_embedding: bool = False, **kwargs):
        return self._read_backend().get_node(id, include_embedding=include_embedding, **kwargs)

    def get_nodes(self, ids: list, include_embedding: bool = False, **kwargs):
        return self._read_backend().get_nodes(ids, include_embedding=include_embedding, **kwargs)

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        return self._read_backend().get_neighbors(id, type, direction=direction)

    def get_children_with_embeddings(self, *args, **kwargs):
        return self._read_backend().get_children_with_embeddings(*args, **kwargs)

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        return self._read_backend().get_path(source_id, target_id, max_depth=max_depth)

    def get_subgraph(self, *args, **kwargs):
        return self._read_backend().get_subgraph(*args, **kwargs)

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        return self._read_backend().get_context_chain(id, type=type)

    def search_by_keywords_like(self, *args, **kwargs):
        return self._read_backend().search_by_keywords_like(*args, **kwargs)

    def search_by_keywords_tfidf(self, *args, **kwargs):
        return self._read_backend().search_by_keywords_tfidf(*args, **kwargs)

    def search_by_fulltext(self, *args, **kwargs):
        return self._read_backend().search_by_fulltext(*args, **kwargs)

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        return_fields: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        return self._read_backend().search_by_embedding(
            vector, top_k=top_k, return_fields=return_fields, **kwargs
        )

    def get_by_metadata(
        self, filters: list[dict[str, Any]], status: str | None = None
    ) -> list[str]:
        return self._read_backend().get_by_metadata(filters, status=status)

    def get_grouped_counts(self, *args, **kwargs):
        return self._read_backend().get_grouped_counts(*args, **kwargs)

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        return self._read_backend().get_memory_count(memory_type, user_name=user_name)

    def count_nodes(self, scope: str, user_name: str | None = None) -> int:
        return self._read_backend().count_nodes(scope, user_name=user_name)

    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        return self._read_backend().node_not_exist(scope, user_name=user_name)

    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        status: str | None = None,
        **kwargs,
    ) -> list[dict]:
        return self._read_backend().get_all_memory_items(
            scope, include_embedding=include_embedding, status=status, **kwargs
        )

    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False
    ) -> list[dict]:
        return self._read_backend().get_structure_optimization_candidates(
            scope, include_embedding=include_embedding
        )

    def detect_conflicts(self) -> list[tuple[str, str]]:
        return self._read_backend().detect_conflicts()

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        return self._read_backend().export_graph(include_embedding=include_embedding, **kwargs)

    def get_neighbors_by_tag(self, *args, **kwargs):
        return self._read_backend().get_neighbors_by_tag(*args, **kwargs)

    def get_edges(self, *args, **kwargs):
        return self._read_backend().get_edges(*args, **kwargs)

    def edge_exists(self, *args, **kwargs):
        return self._read_backend().edge_exists(*args, **kwargs)

    def get_user_names_by_memory_ids(
        self, memory_ids: list[str]
    ) -> dict[str, str | None]:
        return self._read_backend().get_user_names_by_memory_ids(memory_ids)

    def exist_user_name(self, user_name: str) -> dict[str, bool]:
        return self._read_backend().exist_user_name(user_name)

    def create_extension(self):
        self.shard.create_extension()
        try:
            self.legacy.create_extension()
        except Exception as e:
            logger.warning("legacy.create_extension failed (ignored): %s", e)

    def create_graph(self):
        self.shard.create_graph()
        try:
            self.legacy.create_graph()
        except Exception as e:
            logger.warning("legacy.create_graph failed (ignored): %s", e)

    def create_edge(self):
        self.shard.create_edge()
        try:
            self.legacy.create_edge()
        except Exception as e:
            logger.warning("legacy.create_edge failed (ignored): %s", e)

    def create_index(self, *args, **kwargs):
        self.shard.create_index(*args, **kwargs)
        try:
            self.legacy.create_index(*args, **kwargs)
        except Exception as e:
            logger.warning("legacy.create_index failed (ignored): %s", e)

    def warm_up_search_connections_by_full(self, user_name: str | None = None) -> None:
        try:
            self.shard.warm_up_search_connections_by_full(user_name)
        except Exception as e:
            logger.warning("shard warm_up failed (ignored): %s", e)
        try:
            self.legacy.warm_up_search_connections_by_full(user_name)
        except Exception as e:
            logger.warning("legacy warm_up failed (ignored): %s", e)

    def drop_database(self) -> None:
        self.shard.drop_database()
        try:
            self.legacy.drop_database()
        except Exception as e:
            logger.warning("legacy.drop_database failed (ignored): %s", e)

    def format_param_value(self, value: str | None) -> str:
        return self.shard.format_param_value(value)
