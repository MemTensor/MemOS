from __future__ import annotations

import json
import os
import threading
import time
import uuid

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from memos.configs.graph_db import LanceGraphDBConfig

from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


class LanceGraphDB(BaseGraphDB):
    """
    LanceDB implementation for MemOS GraphDB interface.
    Features:
    - Flattened 'memory_type' and 'status' for blazing fast scalar filtering.
    - Native Full-Text Search (FTS) using Tantivy.
    - BFS based multi-hop graph traversal.
    """

    @require_python_package(import_name="lancedb", install_command="pip install lancedb tantivy")
    def __init__(self, config: LanceGraphDBConfig):
        self.config = config
        self.uri = config.uri
        self.user_name = config.user_name or "default"
        self.dim = config.embedding_dimension

        # Compaction settings
        self.compaction_version_threshold = config.compaction_version_threshold
        self.compaction_interval_mins = config.compaction_interval_mins
        self.cleanup_older_than_days = config.cleanup_older_than_days

        self.memories_uri = os.path.join(self.uri, "memories")
        self.edges_uri = os.path.join(self.uri, "edges")

        self._init_schema()

        # Start LanceDB background optimizer thread
        self._last_compact_versions = {
            "memories": self._get_memories_table().version,
            "edges": self._get_edges_table().version,
        }
        self._optimizer_thread = threading.Thread(
            target=self._db_optimizer_loop,
            daemon=True,
            name="lancedb-optimizer",
        )
        self._optimizer_thread.start()

    def _db_optimizer_loop(self):
        """Background loop to periodically trigger table optimization."""
        import schedule

        schedule.every(self.compaction_interval_mins).minutes.do(self._force_optimize)

        logger.info(
            f"Started LanceDB optimizer thread. Compaction interval: {self.compaction_interval_mins}m, "
            f"Version threshold: {self.compaction_version_threshold}"
        )

        while True:
            try:
                # 1. Check version threshold
                self._check_and_trigger_compaction()

                # 2. Run scheduled fallback compaction
                schedule.run_pending()
            except Exception as e:
                logger.error(f"Error in LanceDB optimizer loop: {e}", stack_info=True)

            time.sleep(5)  # Avoid busy waiting

    def _check_and_trigger_compaction(self):
        """Trigger compaction if any table's version diff exceeds the threshold."""
        try:
            memories_ds = self._get_memories_table()
            if (
                memories_ds.version - self._last_compact_versions["memories"]
                > self.compaction_version_threshold
            ):
                self._optimize_table("memories", memories_ds)

            edges_ds = self._get_edges_table()
            if (
                edges_ds.version - self._last_compact_versions["edges"]
                > self.compaction_version_threshold
            ):
                self._optimize_table("edges", edges_ds)
        except Exception as e:
            logger.error(f"Failed to check compaction versions: {e}")

    def _optimize_table(self, table_name: str, ds):
        """Helper method to optimize a specific LanceDB table."""
        try:
            current_version = ds.version
            last_version = self._last_compact_versions[table_name]

            if current_version > last_version:
                logger.info(
                    f"Triggering LanceDB optimization for '{table_name}'. "
                    f"Current version: {current_version}, Last compacted: {last_version}"
                )

                stats = ds.optimize(cleanup_older_than=timedelta(days=self.cleanup_older_than_days))

                stats_msg = ""
                if stats:
                    compaction = getattr(stats, "compaction", None)
                    if compaction:
                        stats_msg += (
                            f" | Compaction: "
                            f"-{getattr(compaction, 'fragments_removed', 0)}/"
                            f"+{getattr(compaction, 'fragments_added', 0)} fragments, "
                            f"-{getattr(compaction, 'files_removed', 0)}/"
                            f"+{getattr(compaction, 'files_added', 0)} files"
                        )

                    prune = getattr(stats, "prune", None)
                    if prune:
                        stats_msg += (
                            f" | Prune: -{getattr(prune, 'bytes_removed', 0)} bytes, "
                            f"-{getattr(prune, 'old_versions_removed', 0)} versions"
                        )

                # Reload the table to get the updated version after optimization
                if table_name == "memories":
                    ds = self._get_memories_table()
                elif table_name == "edges":
                    ds = self._get_edges_table()

                self._last_compact_versions[table_name] = ds.version
                logger.info(
                    f"LanceDB '{table_name}' optimization completed successfully. "
                    f"New version: {self._last_compact_versions[table_name]}{stats_msg}"
                )
        except Exception as e:
            logger.error(f"LanceDB '{table_name}' optimization failed: {e}")

    def _force_optimize(self):
        # Optimize Memories Table
        self._optimize_table("memories", self._get_memories_table())
        # Optimize Edges Table
        self._optimize_table("edges", self._get_edges_table())

    def _init_schema(self):
        import lancedb
        import pyarrow as pa

        os.makedirs(self.uri, exist_ok=True)
        self.db = lancedb.connect(self.uri)

        if hasattr(self.db, "table_names"):
            import warnings

            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                table_names = self.db.table_names()
        else:
            table_names = [tbl.name for tbl in self.db.list_tables()]

        if "memories" not in table_names:
            schema = pa.schema(
                [
                    pa.field("id", pa.string()),
                    pa.field("memory", pa.string()),
                    pa.field("properties", pa.string()),  # Store arbitrary JSON as string
                    pa.field("embedding", pa.list_(pa.float32(), self.dim)),
                    pa.field("user_name", pa.string()),
                    pa.field("memory_type", pa.string()),  # Flattened for performance
                    pa.field("status", pa.string()),  # Flattened for performance
                    pa.field("created_at", pa.string()),
                    pa.field("updated_at", pa.string()),
                ]
            )
            empty_table = pa.Table.from_pylist([], schema=schema)
            self.db.create_table("memories", data=empty_table)
            logger.info("Created LanceDB table for memories.")

            try:
                ds = self.db.open_table("memories")

                # Create vector index (aligned with memory-lancedb TS implementation)
                import math

                row_count = ds.count_rows()
                if row_count > 256:  # LanceDB requires at least 256 rows to train vector index
                    num_partitions = max(1, math.floor(math.sqrt(row_count)))
                    ds.create_index(
                        metric="cosine",
                        vector_column_name="embedding",
                        num_partitions=num_partitions,
                    )
                    logger.info(
                        f"Created IVF_FLAT index for memories.embedding with metric=cosine, partitions={num_partitions}"
                    )
                else:
                    logger.debug(
                        f"Skipping vector index creation, not enough rows ({row_count} <= 256)"
                    )

                # Create full-text search index
                ds.create_fts_index("memory", replace=True)
                logger.info("Created FTS index for memories.memory")
            except Exception as e:
                logger.warning(f"Failed to create LanceDB indices: {e}")

        if "edges" not in table_names:
            edge_schema = pa.schema(
                [
                    pa.field("id", pa.string()),
                    pa.field("source_id", pa.string()),
                    pa.field("target_id", pa.string()),
                    pa.field("edge_type", pa.string()),
                    pa.field("user_name", pa.string()),
                    pa.field("created_at", pa.string()),
                ]
            )
            empty_edge_table = pa.Table.from_pylist([], schema=edge_schema)
            self.db.create_table("edges", data=empty_edge_table)
            logger.info("Created LanceDB table for edges.")

    def _get_memories_table(self):
        import lancedb

        if not hasattr(self, "db"):
            self.db = lancedb.connect(self.uri)
        return self.db.open_table("memories")

    def _get_edges_table(self):
        import lancedb

        if not hasattr(self, "db"):
            self.db = lancedb.connect(self.uri)
        return self.db.open_table("edges")

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        self.add_nodes_batch(
            [{"id": id, "memory": memory, "metadata": metadata}], user_name=user_name
        )

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        target_user = user_name or self.user_name
        data = []
        now = datetime.now().isoformat()

        ids = [n["id"] for n in nodes if "id" in n]
        if ids:
            self.delete_node_by_prams(ids, user_name=target_user)

        for node in nodes:
            node_id = node.get("id", str(uuid.uuid4()))
            mem = node.get("memory", "")
            meta = node.get("metadata", {})
            embedding = node.get("embedding", meta.get("embedding"))

            if embedding is None:
                embedding = [0.0] * self.dim

            mem_type = meta.get("memory_type", "")
            status = meta.get("status", "")

            if "embedding" in meta:
                meta = meta.copy()
                del meta["embedding"]

            data.append(
                {
                    "id": str(node_id),
                    "memory": str(mem),
                    "properties": json.dumps(meta),
                    "embedding": embedding,
                    "user_name": target_user,
                    "memory_type": mem_type,
                    "status": status,
                    "created_at": now,
                    "updated_at": now,
                }
            )

        if data:
            self._get_memories_table().add(data)

            # Rebuild FTS index automatically after batch insert
            try:
                ds = self._get_memories_table()
                ds.create_fts_index("memory", replace=True)
            except Exception as e:
                logger.warning(f"Failed to create LanceDB FTS index (tantivy missing?): {e}")

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        target_user = user_name or self.user_name
        node = self.get_node(id, include_embedding=True, user_name=target_user)
        if not node:
            return

        meta = node.get("metadata", {})

        # In Neo4j, fields are top-level properties. In LanceDB, most properties go into metadata.
        # We should merge the provided fields into metadata, except for memory and embedding.
        for k, v in fields.items():
            if k == "metadata" and isinstance(v, dict):
                meta.update(v)
            elif k not in ("memory", "embedding"):
                meta[k] = v

        new_mem = fields.get("memory", node.get("memory"))
        new_emb = fields.get("embedding", meta.get("embedding"))

        if new_emb is not None and "embedding" in meta:
            del meta["embedding"]

        self.add_node(id, new_mem, meta, user_name=target_user)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        self.delete_node_by_prams([id], user_name=user_name)

    def delete_node_by_prams(self, ids: list[str], user_name: str | None = None) -> None:
        if not ids:
            return
        target_user = user_name or self.user_name
        ds = self._get_memories_table()
        id_list = ", ".join([f"'{i}'" for i in ids])
        try:
            ds.delete(f"id IN ({id_list}) AND user_name = '{target_user}'")
            edges_ds = self._get_edges_table()
            edges_ds.delete(
                f"(source_id IN ({id_list}) OR target_id IN ({id_list})) AND user_name = '{target_user}'"
            )
        except Exception as e:
            logger.error(f"Error deleting nodes in LanceDB: {e}")

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        nodes = self.get_nodes([id], include_embedding=include_embedding, **kwargs)
        return nodes[0] if nodes else None

    def get_nodes(
        self,
        ids: list[str],
        include_embedding: bool = False,
        user_name: str | None = None,
        **kwargs,
    ) -> list[dict[str, Any]]:
        if not ids:
            return []
        target_user = user_name or self.user_name
        ds = self._get_memories_table()
        id_list = ", ".join([f"'{i}'" for i in ids])
        try:
            df = ds.search().where(f"id IN ({id_list}) AND user_name = '{target_user}'").to_pandas()
            return [self._parse_row(row, include_embedding) for _, row in df.iterrows()]
        except Exception as e:
            logger.error(f"Error getting nodes in LanceDB: {e}")
            return []

    def _parse_row(self, row, include_embedding=False) -> dict[str, Any]:
        properties = json.loads(row["properties"]) if row.get("properties") else {}
        # Restore flattened fields into metadata
        if row.get("memory_type"):
            properties["memory_type"] = row["memory_type"]
        if row.get("status"):
            properties["status"] = row["status"]

        if include_embedding and "embedding" in row:
            vec = row["embedding"]
            properties["embedding"] = vec.tolist() if hasattr(vec, "tolist") else vec

        return {"id": row["id"], "memory": row.get("memory", ""), "metadata": properties}

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        target_user = user_name or self.user_name
        if self.edge_exists(source_id, target_id, type, user_name=target_user):
            return

        now = datetime.now().isoformat()
        data = [
            {
                "id": str(uuid.uuid4()),
                "source_id": source_id,
                "target_id": target_id,
                "edge_type": type,
                "user_name": target_user,
                "created_at": now,
            }
        ]
        self._get_edges_table().add(data)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        target_user = user_name or self.user_name
        ds = self._get_edges_table()
        try:
            ds.delete(
                f"source_id = '{source_id}' AND target_id = '{target_id}' AND edge_type = '{type}' AND user_name = '{target_user}'"
            )
        except Exception as e:
            logger.error(f"Error deleting edge in LanceDB: {e}")

    def edge_exists(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> bool:
        target_user = user_name or self.user_name
        ds = self._get_edges_table()
        try:
            return (
                len(
                    ds.search()
                    .where(
                        f"source_id = '{source_id}' AND target_id = '{target_id}' AND edge_type = '{type}' AND user_name = '{target_user}'"
                    )
                    .limit(1)
                    .to_list()
                )
                > 0
            )
        except Exception:
            return False

    def get_neighbors(
        self,
        node_id: str,
        edge_type: str | None = None,
        direction: str = "OUT",
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        target_user = user_name or self.user_name
        ds = self._get_edges_table()

        conditions = [f"user_name = '{target_user}'"]
        if edge_type:
            conditions.append(f"edge_type = '{edge_type}'")

        if direction == "OUT":
            conditions.append(f"source_id = '{node_id}'")
        elif direction == "IN":
            conditions.append(f"target_id = '{node_id}'")
        else:
            conditions.append(f"(source_id = '{node_id}' OR target_id = '{node_id}')")

        filter_str = " AND ".join(conditions)

        try:
            df = ds.search().where(filter_str).to_pandas()

            neighbor_ids = []
            for _, row in df.iterrows():
                if direction == "OUT":
                    neighbor_ids.append(row["target_id"])
                elif direction == "IN":
                    neighbor_ids.append(row["source_id"])
                else:
                    nid = row["target_id"] if row["source_id"] == node_id else row["source_id"]
                    neighbor_ids.append(nid)

            if not neighbor_ids:
                return []

            return self.get_nodes(list(set(neighbor_ids)), user_name=target_user)
        except Exception as e:
            logger.error(f"Error getting neighbors in LanceDB: {e}")
            return []

    def get_path(
        self, source_id: str, target_id: str, max_depth: int = 3, user_name: str | None = None
    ) -> list[str]:
        if source_id == target_id:
            return [source_id]

        target_user = user_name or self.user_name
        ds = self._get_edges_table()

        queue = [[source_id]]
        visited = {source_id}

        while queue:
            path = queue.pop(0)
            current = path[-1]

            if len(path) > max_depth:
                continue

            try:
                df = (
                    ds.search()
                    .where(f"source_id = '{current}' AND user_name = '{target_user}'")
                    .to_pandas()
                )
                for _, row in df.iterrows():
                    neighbor = row["target_id"]
                    if neighbor == target_id:
                        return [*path, neighbor]
                    if neighbor not in visited:
                        visited.add(neighbor)
                        queue.append([*path, neighbor])
            except Exception:
                pass

        return []

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
    ) -> list[str]:
        target_user = user_name or self.user_name

        center_node = self.get_node(center_id, user_name=target_user)
        if not center_node or center_node.get("metadata", {}).get("status") != center_status:
            return []

        visited = {center_id}
        current_layer = {center_id}
        ds = self._get_edges_table()

        for _ in range(depth):
            next_layer = set()
            for node in current_layer:
                try:
                    df = (
                        ds.search()
                        .where(
                            f"(source_id = '{node}' OR target_id = '{node}') AND user_name = '{target_user}'"
                        )
                        .to_pandas()
                    )
                    for _, row in df.iterrows():
                        n1, n2 = row["source_id"], row["target_id"]
                        if n1 not in visited:
                            next_layer.add(n1)
                            visited.add(n1)
                        if n2 not in visited:
                            next_layer.add(n2)
                            visited.add(n2)
                except Exception:
                    pass
            current_layer = next_layer

        return list(visited)

    def get_context_chain(
        self, id: str, type: str = "FOLLOWS", user_name: str | None = None
    ) -> list[str]:
        target_user = user_name or self.user_name
        chain = []
        current = id
        ds = self._get_edges_table()

        while current:
            try:
                df = (
                    ds.search()
                    .where(
                        f"source_id = '{current}' AND edge_type = '{type}' AND user_name = '{target_user}'"
                    )
                    .to_pandas()
                )
                if df.empty:
                    break
                current = df.iloc[0]["target_id"]
                chain.append(current)
            except Exception:
                break
        return chain

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        return_fields: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        target_user = user_name or self.user_name
        ds = self._get_memories_table()

        conditions = []
        if getattr(self.config, "use_multi_db", False) is False and target_user:
            conditions.append(f"user_name = '{target_user}'")

        # Fast scalar filtering using flattened columns
        if scope and scope != "All":
            conditions.append(f"memory_type = '{scope}'")
        if status:
            conditions.append(f"status = '{status}'")

        # Fallback to string matching for dynamic JSON properties
        if search_filter:
            for k, v in search_filter.items():
                if isinstance(v, str):
                    conditions.append(f'properties LIKE \'%"{k}": "{v}"%\'')
                else:
                    conditions.append(f"properties LIKE '%\"{k}\": {json.dumps(v)}%'")

        where_clause = " AND ".join(conditions) if conditions else None

        try:
            query = ds.search(vector, vector_column_name="embedding")
            if where_clause:
                query = query.where(where_clause)

            df = query.limit(top_k).to_pandas()
            results = []

            for _, row in df.iterrows():
                score = 1.0 - row.get("_distance", 0.0)
                if threshold is not None and score < threshold:
                    continue

                item = {"id": row["id"], "score": score}

                if return_fields:
                    props = json.loads(row["properties"]) if row.get("properties") else {}
                    for field in return_fields:
                        if field == "memory":
                            item["memory"] = row.get("memory", "")
                        elif field == "memory_type" or field == "status":
                            item[field] = row.get(field, "")
                        elif field in props:
                            item[field] = props[field]

                results.append(item)

            return results
        except Exception as e:
            logger.error(f"Error in LanceDB search_by_embedding: {e}")
            return []

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
        status: str | None = None,
    ) -> list[str]:
        target_user = user_name or self.user_name
        ds = self._get_memories_table()

        conditions = []
        if user_name_flag:
            conditions.append(f"user_name = '{target_user}'")

        if status:
            conditions.append(f"status = '{status}'")

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            # Use flattened fast columns if possible
            if field in ["memory_type", "status"]:
                if op == "=":
                    conditions.append(f"{field} = '{value}'")
                elif op == "in":
                    in_conds = [f"{field} = '{v}'" for v in value]
                    if in_conds:
                        conditions.append(f"({' OR '.join(in_conds)})")
                continue

            # Use LIKE for JSON properties
            if op == "=":
                conditions.append(f'properties LIKE \'%"{field}": "{value}"%\'')
            elif op == "in":
                in_conds = [f'properties LIKE \'%"{field}": "{v}"%\'' for v in value]
                if in_conds:
                    conditions.append(f"({' OR '.join(in_conds)})")
            elif op == "contains":
                conditions.append(f"properties LIKE '%\"{value}\"%'")

        where_clause = " AND ".join(conditions) if conditions else None

        try:
            if where_clause:
                df = ds.search().where(where_clause).select(["id"]).to_pandas()
            else:
                df = ds.search().select(["id"]).to_pandas()
            return df["id"].tolist()
        except Exception as e:
            logger.error(f"Error in LanceDB get_by_metadata: {e}")
            return []

    def search_by_fulltext(
        self,
        query_words: list[str],
        top_k: int = 10,
        **kwargs,
    ) -> list[dict]:
        """
        Implements Native Full-Text Search (FTS) using LanceDB's Tantivy integration.
        This enables MemOS to perform Multi-way Recall (Vector + BM25/FTS) seamlessly.
        """
        target_user = kwargs.get("user_name") or self.user_name
        ds = self._get_memories_table()
        query_str = " ".join(query_words)

        try:
            # Execute native FTS query
            query = ds.search(query_str)
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                query = query.where(f"user_name = '{target_user}'")

            res = query.limit(top_k).to_list()
            results = []
            for row in res:
                results.append(
                    {
                        "id": row["id"],
                        "memory": row.get("memory", ""),
                        "score": row.get("_score", 1.0),  # Tantivy relevance score
                    }
                )
            return results
        except Exception as e:
            logger.error(
                f"LanceDB FTS search failed (ensure tantivy is installed and index exists): {e}"
            )
            return []

    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        status: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        target_user = kwargs.get("user_name") or self.user_name
        ds = self._get_memories_table()

        conditions = [f"user_name = '{target_user}'"]
        if scope:
            conditions.append(f"memory_type = '{scope}'")
        if status:
            conditions.append(f"status = '{status}'")

        if filter:
            for k, v in filter.items():
                if isinstance(v, str):
                    conditions.append(f'properties LIKE \'%"{k}": "{v}"%\'')
                else:
                    import json

                    conditions.append(f"properties LIKE '%\"{k}\": {json.dumps(v)}%'")

        where_clause = " AND ".join(conditions)

        try:
            df = ds.search().where(where_clause).to_pandas()
            results = []
            for _, row in df.iterrows():
                results.append(self._parse_row(row, include_embedding))
            return results
        except Exception as e:
            logger.error(f"Error getting all memory items in LanceDB: {e}")
            return []

    def get_structure_optimization_candidates(
        self, scope: str, user_name: str | None = None, **kwargs
    ):
        target_user = user_name or (
            self.user_name if getattr(self, "user_name", "default") != "default" else None
        )
        ds = self._get_memories_table()
        edges_ds = self._get_edges_table()

        try:
            # get all memories
            query = ds.search().where(f"memory_type = '{scope}' AND status = 'activated'")
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                query = ds.search().where(
                    f"memory_type = '{scope}' AND status = 'activated' AND user_name = '{target_user}'"
                )
            df_memories = query.to_pandas()
            if df_memories.empty:
                return []

            # get all edges to find isolated nodes
            edge_query = edges_ds.search()
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                edge_query = edge_query.where(f"user_name = '{target_user}'")
            df_edges = edge_query.to_pandas()
            connected_nodes = set()
            if not df_edges.empty:
                connected_nodes.update(df_edges["source_id"].tolist())
                connected_nodes.update(df_edges["target_id"].tolist())

            results = []
            for _, row in df_memories.iterrows():
                if row["id"] not in connected_nodes:
                    results.append(self._parse_row(row, include_embedding=False))

            return results
        except Exception as e:
            logger.error(f"Error getting structure optimization candidates in LanceDB: {e}")
            return []

    def deduplicate_nodes(self) -> None:
        pass

    def detect_conflicts(self) -> list[tuple[str, str]]:
        return []

    def merge_nodes(self, id1: str, id2: str) -> str:
        raise NotImplementedError

    def get_grouped_counts(
        self, group_fields: list[str], user_name: str | None = None
    ) -> list[dict]:
        return []

    def search_by_hybrid(
        self,
        query_text: str,
        vector: list[float],
        top_k: int = 10,
        user_name: str | None = None,
        reranker: Any | None = None,
        **kwargs,
    ) -> list[dict]:
        target_user = user_name or self.user_name
        ds = self._get_memories_table()

        try:
            query = ds.search(query_type="hybrid").vector(vector).text(query_text)
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                query = query.where(f"user_name = '{target_user}'")

            query = query.limit(top_k)

            if reranker:
                query = query.rerank(reranker=reranker)

            res = query.to_pandas()

            results = []
            for _, row in res.iterrows():
                results.append(
                    {
                        "id": row["id"],
                        "memory": row.get("memory", ""),
                        "score": row.get("_score", 1.0),
                    }
                )
            return results
        except Exception as e:
            logger.error(f"LanceDB Hybrid search failed: {e}")
            return []

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Keep the latest `keep_latest` memories of a specific `memory_type`, and remove the older ones.
        """
        target_user = user_name or self.user_name
        ds = self._get_memories_table()
        try:
            # Query all matching memories sorted by created_at descending
            df = (
                ds.search()
                .where(f"memory_type = '{memory_type}' AND user_name = '{target_user}'")
                .to_pandas()
            )
            if len(df) <= keep_latest:
                return

            df = df.sort_values(by="created_at", ascending=False)
            old_ids = df.iloc[keep_latest:]["id"].tolist()
            if old_ids:
                self.delete_node_by_prams(old_ids, user_name=target_user)
        except Exception as e:
            logger.error(f"Error removing oldest memory in LanceDB: {e}")

    def clear(self, user_name: str | None = None) -> None:
        target_user = user_name or self.user_name
        try:
            ds1 = self._get_memories_table()
            ds1.delete(f"user_name = '{target_user}'")
            ds2 = self._get_edges_table()
            ds2.delete(f"user_name = '{target_user}'")
        except Exception:
            pass

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        return {"nodes": [], "edges": []}

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        pass

    def get_memory_count(self, scope: str | None = None, user_name: str | None = None) -> int:
        target_user = user_name or (
            self.user_name if getattr(self, "user_name", "default") != "default" else None
        )
        try:
            ds = self._get_memories_table()
            where_clauses = []
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                where_clauses.append(f"user_name = '{target_user}'")
            if scope:
                where_clauses.append(f"memory_type = '{scope}'")

            if where_clauses:
                query_str = " AND ".join(where_clauses)
                return len(ds.search().where(query_str).to_list())
            return ds.count_rows()
        except Exception:
            return 0

    def node_not_exist(self, scope: str, user_name: str | None = None) -> bool:
        """Check if there is NO node with the given memory_type (scope) for the user."""
        target_user = user_name or (
            self.user_name if getattr(self, "user_name", "default") != "default" else None
        )
        try:
            ds = self._get_memories_table()
            where_clauses = []
            if getattr(self.config, "use_multi_db", False) is False and target_user:
                where_clauses.append(f"user_name = '{target_user}'")
            if scope:
                where_clauses.append(f"memory_type = '{scope}'")

            query_str = " AND ".join(where_clauses)
            if query_str:
                return len(ds.search().where(query_str).to_list()) == 0
            return ds.count_rows() == 0
        except Exception:
            return True

    def close(self) -> None:
        pass
