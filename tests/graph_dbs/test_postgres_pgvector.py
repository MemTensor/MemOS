import hashlib
import json

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import PostgresGraphDBConfig
from memos.graph_dbs.postgres import PostgresGraphDB


@pytest.fixture
def postgres_db():
    db = PostgresGraphDB.__new__(PostgresGraphDB)
    db.schema = "memos"
    db.db_name = "memos"
    db.user_name = "tenant-a"
    db._pool_closed = False
    db.config = SimpleNamespace(
        embedding_dimension=3,
        fulltext_config="simple",
        vector_index_type="hnsw",
        hnsw_m=16,
        hnsw_ef_construction=64,
        ivfflat_lists=100,
        shard_count=400,
    )
    db._partition_remainders = {
        "tenant-a": 17,
        "tenant-b": 17,
        "kb-1": 17,
    }

    cursor = MagicMock()
    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value = cursor
    db._get_conn = MagicMock(return_value=connection)
    db._put_conn = MagicMock()
    return db, cursor


def _executed_sql(cursor: MagicMock) -> str:
    return "\n".join(str(call.args[0]) for call in cursor.execute.call_args_list)


def test_postgres_pool_keeps_eight_warm_connections():
    config = PostgresGraphDBConfig(
        host="postgres",
        user="postgres",
        password="secret",
        db_name="memos",
        user_name="tenant-a",
    )
    assert config.minconn == 8
    assert config.maxconn == 20


def test_get_conn_does_not_ping_before_the_query():
    db = PostgresGraphDB.__new__(PostgresGraphDB)
    db._pool_closed = False
    cursor = MagicMock()
    connection = MagicMock()
    connection.closed = 0
    connection.cursor.return_value.__enter__.return_value = cursor
    db.pool = MagicMock()
    db.pool.getconn.return_value = connection

    assert db._get_conn() is connection
    cursor.execute.assert_not_called()


def test_postgres_config_defaults_to_current_embedding_dimension():
    config = PostgresGraphDBConfig(
        host="postgres",
        user="memos",
        password="secret",
        db_name="memos",
        user_name="tenant-a",
    )

    assert config.embedding_dimension == 1024
    assert config.shard_count == 400


def test_init_schema_creates_tenant_edges_fulltext_and_hnsw(postgres_db):
    db, cursor = postgres_db

    db._init_schema()

    sql = _executed_sql(cursor)
    assert "user_name TEXT NOT NULL" in sql
    assert "UNIQUE(user_name, source_id, target_id, edge_type)" in sql
    assert "search_vector tsvector" in sql
    assert "properties::text" in sql
    assert "USING GIN(search_vector)" in sql
    assert "halfvec_cosine_ops" in sql
    assert "idx_memory_embedding_halfvec" in sql
    assert "embedding halfvec(" in sql
    assert '"Memory"' in sql
    assert "USING ivfflat" not in sql


def test_edge_operations_are_tenant_scoped_and_support_any_direction(postgres_db):
    db, cursor = postgres_db
    cursor.fetchone.return_value = (1,)
    cursor.fetchall.return_value = [("source", "target", "RELATE_TO")]

    db.add_edge("source", "target", "RELATE_TO", user_name="tenant-a")
    assert db.edge_exists(
        "source",
        "target",
        "RELATE_TO",
        direction="ANY",
        user_name="tenant-a",
    )
    edges = db.get_edges("source", type="ANY", direction="ANY", user_name="tenant-a")

    sql = _executed_sql(cursor)
    assert "user_name" in sql
    assert edges == [{"from": "source", "to": "target", "type": "RELATE_TO"}]
    assert any(
        "tenant-a" in call.args[1] for call in cursor.execute.call_args_list if len(call.args) > 1
    )

    db.edge_exists("source", "target", type="ANY", user_name="tenant-a")
    query, params = cursor.execute.call_args.args
    assert "edge_type = %s" not in query
    assert params == ["tenant-a", "source", "target"]


def test_vector_search_applies_filters_kb_ids_and_return_fields(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "node-1",
            0.95,
            "remember this",
            {"status": "activated", "source": "conversation"},
            now,
            now,
            "tenant-a",
        )
    ]

    results = db.search_by_embedding(
        vector=[0.1, 0.2, 0.3],
        top_k=5,
        scope="LongTermMemory",
        status="activated",
        user_name="tenant-a",
        knowledgebase_ids=["kb-1"],
        filter={"and": [{"info.agent_id": "agent-1"}, {"tags": {"contains": "blue"}}]},
        return_fields=["memory", "source", "created_at"],
    )

    query, params = cursor.execute.call_args.args
    assert "user_name = ANY(%s)" in query
    assert "COALESCE(properties->>'id', id)" in query
    assert "properties->'info'->>'agent_id'" in query
    assert "properties->'tags' @> %s::jsonb" in query
    assert ["tenant-a", "kb-1"] in params
    assert results[0]["memory"] == "remember this"
    assert results[0]["source"] == "conversation"
    assert results[0]["created_at"] == now.isoformat()


def test_lightweight_vector_search_returns_memory_without_extra_lookup(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "node-1",
            0.95,
            "remember this",
            now,
            now,
            "tenant-a",
            '"LongTermMemory"',
            '"activated"',
            None,
            None,
            None,
            None,
        )
    ]

    results = db.search_by_embedding(
        vector=[0.1, 0.2, 0.3],
        top_k=5,
        scope="LongTermMemory",
        user_name="tenant-a",
        light_weight_mode=True,
    )

    assert results[0]["memory"] == "remember this"
    assert results[0]["memory_type"] == "LongTermMemory"
    assert PostgresGraphDB.supports_lightweight_vector_search is True
    assert PostgresGraphDB.prefer_lightweight_vector_search is True


def test_search_result_does_not_add_postgres_only_property_aliases(postgres_db):
    db, _ = postgres_db
    now = datetime.now(timezone.utc)
    row = (
        "node-1",
        0.95,
        "remember this",
        {"status": "activated"},
        now,
        now,
        "tenant-a",
    )

    result = db._build_search_result(row, ["metadata", "properties"])

    assert result == {"id": "node-1", "score": 0.95}


def test_search_result_keeps_polardb_serialized_source_shape(postgres_db):
    db, _ = postgres_db
    now = datetime.now(timezone.utc)
    source = json.dumps({"type": "chat", "role": "user", "content": "hello"})
    row = (
        "node-1",
        0.95,
        "remember this",
        {"sources": [source]},
        now,
        now,
        "tenant-a",
    )

    result = db._build_search_result(row, ["sources"])

    assert result["sources"] == [source]


def test_fulltext_search_uses_polardb_and_tsquery(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "node-1",
            0.8,
            "中文记忆内容",
            {"status": "activated"},
            now,
            now,
            "tenant-a",
        )
    ]

    results = db.search_by_fulltext(
        query_words=["中文", "记忆"],
        top_k=10,
        scope="LongTermMemory",
        user_name="tenant-a",
        filter={"info.agent_id": "agent-1"},
        return_fields=["memory"],
    )

    query, params = cursor.execute.call_args.args
    assert "to_tsquery('jiebacfg'" in query
    assert "search_vector @@" in query
    assert "ILIKE" not in query
    assert "properties->'info'->>'agent_id'" in query
    assert params[0] == "'中文' & '记忆'"
    assert results == [{"id": "node-1", "score": 0.8, "memory": "中文记忆内容"}]


def test_get_node_without_tenant_searches_all_partitions(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchone.return_value = (
        "node-1",
        "remember this",
        {"status": "activated", "user_name": "tenant-b"},
        now,
        now,
    )

    result = db.get_node("node-1")

    query, params = cursor.execute.call_args.args
    assert "WHERE id = %s" in query
    assert "user_name = %s" not in query
    assert '"memos_graph_0"."Memory"' in query
    assert '"memos_graph_399"."Memory"' in query
    assert "FROM memos.memories" not in query
    assert params == ("node-1",)
    assert result["id"] == "node-1"


def test_get_node_with_tenant_remains_tenant_scoped(postgres_db):
    db, cursor = postgres_db
    cursor.fetchone.return_value = None

    assert db.get_node("node-1", user_name="tenant-b") is None

    query, params = cursor.execute.call_args.args
    assert "WHERE id = %s AND user_name = %s" in query
    assert params == ("node-1", "tenant-b")


def test_get_nodes_without_tenant_searches_all_partitions(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = []

    assert db.get_nodes(["node-1", "node-2"]) == []

    query, params = cursor.execute.call_args.args
    assert "WHERE id = ANY(%s)" in query
    assert "user_name = %s" not in query
    assert '"memos_graph_0"."Memory"' in query
    assert '"memos_graph_399"."Memory"' in query
    assert "FROM memos.memories" not in query
    assert params == (["node-1", "node-2"],)


def test_cube_soft_delete_recover_and_counts_are_available(postgres_db):
    db, cursor = postgres_db
    cursor.rowcount = 3
    cursor.fetchone.side_effect = [(3,), (0,)]

    assert db.delete_node_by_mem_cube_id("tenant-a", "delete-1") == 3
    assert db.recover_memory_by_mem_cube_id("tenant-a", "delete-1") == 3
    assert db.get_memory_count("LongTermMemory", user_name="tenant-a") == 3
    assert db.node_not_exist("UserMemory", user_name="tenant-a") == 1

    sql = _executed_sql(cursor)
    assert "delete_record_id" in sql
    assert "status" in sql
    assert "user_name = %s" in sql


def test_drop_database_is_scoped_to_current_tenant(postgres_db):
    db, _cursor = postgres_db
    db.clear = MagicMock()

    db.drop_database()

    db.clear.assert_called_once_with(user_name="tenant-a")


def test_structure_candidates_accept_tenant_and_optional_embedding(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "node-1",
            "remember this",
            {"status": "activated", "memory_type": "LongTermMemory"},
            now,
            now,
            [0.1, 0.2, 0.3],
        )
    ]

    results = db.get_structure_optimization_candidates(
        "LongTermMemory",
        include_embedding=True,
        user_name="tenant-b",
    )

    query, params = cursor.execute.call_args.args
    assert "m.embedding" in query
    assert params == ("LongTermMemory", "tenant-b")
    assert results[0]["metadata"]["embedding"] == [0.1, 0.2, 0.3]


def test_structure_candidates_only_exclude_parent_edges(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = []

    db.get_structure_optimization_candidates(
        "LongTermMemory",
        user_name="tenant-a",
    )

    query, _ = cursor.execute.call_args.args
    assert "e1.edge_type = 'PARENT'" in query
    assert "e2.edge_type = 'PARENT'" in query


def test_time_filter_uses_timestamp_comparison(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = []

    db.search_by_embedding(
        [0.1, 0.2, 0.3],
        user_name="tenant-a",
        top_k=5,
        filter={"created_at": {"gt": "2026-01-01T00:00:00"}},
    )

    query, _params = cursor.execute.call_args.args
    assert "::timestamp >" in query
    assert "timestamptz" not in query


def test_single_tenant_vector_search_reads_one_hash_partition(postgres_db):
    db, cursor = postgres_db
    db._partition_remainders = {"tenant-a": 17}
    cursor.fetchall.return_value = []

    db.search_by_embedding([0.1, 0.2, 0.3], user_name="tenant-a", top_k=5)

    query, params = cursor.execute.call_args.args
    assert 'FROM "memos_graph_17"."Memory"' in query
    assert "FROM memos.memories" not in query
    assert query.count("%s::halfvec(3)") == 1
    assert "AS MATERIALIZED" in query
    assert "ORDER BY embedding <=> (SELECT query_vector FROM q)" in query
    materialized_and_score, outer_filter = query.split("FROM t", 1)
    materialized_body = materialized_and_score.split("AS MATERIALIZED", 1)[1]
    assert "< 0.9" not in materialized_body
    assert "scope_distance < 0.9" in outer_filter
    assert "((1 - scope_distance) + 1) / 2.0" in materialized_and_score
    assert "embedding::halfvec" not in query
    assert "user_name = %s" in query
    assert "user_name = ANY(%s)" not in query
    assert params[0] == [0.1, 0.2, 0.3]
    assert params[1] == "tenant-a"
    assert params[-1] == 5
    assert any(
        "hnsw.iterative_scan" in str(call.args[0]) for call in cursor.execute.call_args_list
    )


def test_cross_shard_vector_search_reads_only_those_partitions(postgres_db):
    db, cursor = postgres_db
    db._partition_remainders = {"tenant-a": 17, "kb-1": 19}
    cursor.fetchall.return_value = []

    db.search_by_embedding(
        [0.1, 0.2, 0.3],
        user_name="tenant-a",
        knowledgebase_ids=["kb-1"],
        top_k=5,
    )

    query, _params = cursor.execute.call_args.args
    assert '"memos_graph_17"."Memory"' in query
    assert '"memos_graph_19"."Memory"' in query
    assert "UNION ALL" in query
    assert "FROM memos.memories" not in query


def test_partition_remainder_uses_polardb_md5(postgres_db):
    db, cursor = postgres_db
    db._partition_remainders = {}
    cursor.fetchall.return_value = []
    shard = int(hashlib.md5(b"tenant-a").hexdigest(), 16) % 400

    db.search_by_embedding([0.1, 0.2, 0.3], user_name="tenant-a", top_k=5)

    query = cursor.execute.call_args.args[0]
    assert f'"memos_graph_{shard}"."Memory"' in query
    assert "satisfies_hash_partition" not in _executed_sql(cursor)
    assert db._partition_remainder("tenant-a") == shard
