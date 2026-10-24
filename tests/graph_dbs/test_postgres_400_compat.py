import json

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

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

    cursor = MagicMock()
    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value = cursor
    db._get_conn = MagicMock(return_value=connection)
    db._put_conn = MagicMock()
    db._partition_remainders = {
        "tenant-a": 17,
        "tenant-b": 17,
        "kb-1": 17,
    }
    return db, cursor


def _executed_sql(cursor: MagicMock) -> str:
    return "\n".join(str(call.args[0]) for call in cursor.execute.call_args_list)


def test_schema_does_not_create_profile_storage(postgres_db):
    db, cursor = postgres_db

    db._init_schema()

    sql = _executed_sql(cursor)
    assert "profile_templates" not in sql
    assert "profile_instances" not in sql


def test_schema_creates_400_md5_memory_shards(postgres_db):
    db, cursor = postgres_db

    db._init_schema()

    sql = _executed_sql(cursor)
    assert "PARTITION BY HASH" not in sql
    assert '"Memory"' in sql
    assert "embedding halfvec(" in sql
    assert "memos_graph_0" in sql
    assert "memos_graph_399" in sql
    assert "MODULUS" not in sql
    assert sql.count("CREATE SCHEMA IF NOT EXISTS") == 401
    assert "PRIMARY KEY (user_name, id)" in sql


def test_schema_rejects_legacy_nonpartitioned_parent(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = [("memories", "r")]

    with pytest.raises(RuntimeError, match="configure a new MEMOS_SCHEMA"):
        db._init_schema()


def test_schema_skips_partition_ddl_when_layout_is_complete(postgres_db):
    db, cursor = postgres_db
    cursor.fetchone.return_value = (400,)

    db._init_schema()

    sql = _executed_sql(cursor)
    assert sql.count("CREATE SCHEMA IF NOT EXISTS") == 1
    assert "memos_graph_0" not in sql


def test_node_upsert_targets_composite_partition_key(postgres_db):
    db, cursor = postgres_db

    db.add_node(
        "memory-1",
        "memory",
        {"embedding": [1.0, 0.0, 0.0]},
        user_name="tenant-a",
    )

    assert "ON CONFLICT (user_name, id)" in _executed_sql(cursor)


def test_batch_insert_uses_one_statement_and_polardb_properties(postgres_db):
    db, cursor = postgres_db

    db.add_nodes_batch(
        [
            {"id": "m1", "memory": "one", "metadata": {"embedding": [1.0, 0.0, 0.0]}},
            {"id": "m2", "memory": "two", "metadata": {"embedding": [0.0, 1.0, 0.0]}},
        ],
        user_name="tenant-a",
    )

    assert cursor.execute.call_count == 1
    query, params = cursor.execute.call_args.args
    assert query.count("::halfvec(") == 2
    assert "ON CONFLICT (user_name, id)" in query
    first_properties = json.loads(params[2])
    second_properties = json.loads(params[9])
    assert first_properties["id"] == "m1"
    assert first_properties["memory"] == "one"
    assert second_properties["id"] == "m2"
    assert second_properties["memory"] == "two"
    assert "embedding" not in first_properties


def test_node_upsert_persists_tenant_in_metadata(postgres_db):
    db, cursor = postgres_db

    db.add_node(
        "memory-1",
        "memory",
        {"embedding": [1.0, 0.0, 0.0]},
        user_name="tenant-a",
    )

    _, params = cursor.execute.call_args.args
    properties = json.loads(params[2])
    assert properties["user_name"] == "tenant-a"
    assert properties["delete_time"] == ""
    assert properties["delete_record_id"] == ""


def test_batch_node_metadata_matches_polardb_shape(postgres_db):
    db, _ = postgres_db
    now = datetime.now(timezone.utc)

    node = db._parse_row(
        (
            "memory-1",
            "service HTTP comparison memory",
            {"status": "activated"},
            now,
            now,
        )
    )

    assert node["metadata"]["id"] == "memory-1"
    assert node["metadata"]["memory"] == "service HTTP comparison memory"


def test_parse_row_restores_tenant_and_deserializes_sources(postgres_db):
    db, _ = postgres_db
    now = datetime.now(timezone.utc)
    source = {"type": "chat", "role": "user", "content": "hello"}

    node = db._parse_row(
        (
            "memory-1",
            "memory",
            {"sources": [json.dumps(source)]},
            now,
            now,
            "tenant-a",
        )
    )

    assert node["metadata"]["user_name"] == "tenant-a"
    assert node["metadata"]["sources"] == [source]


def test_new_polardb_business_methods_are_available():
    required_methods = {
        "delete_node_by_cube_memory_groups",
        "get_user_names_by_cube_memory_groups",
        "get_children_with_embeddings",
        "get_neighbors_by_tag",
    }

    missing = sorted(name for name in required_methods if not hasattr(PostgresGraphDB, name))
    assert missing == []


def test_get_subgraph_matches_polardb_return_shape(postgres_db):
    db, cursor = postgres_db
    core = {
        "id": "core",
        "memory": "core memory",
        "metadata": {"status": "activated"},
    }
    neighbor = {
        "id": "neighbor",
        "memory": "neighbor memory",
        "metadata": {"status": "activated"},
    }
    db.get_node = MagicMock(return_value=core)
    db.get_nodes = MagicMock(return_value=[neighbor])
    cursor.fetchall.side_effect = [
        [("core",), ("neighbor",)],
        [("core", "neighbor", "RELATE_TO")],
    ]

    result = db.get_subgraph(
        "core",
        depth=2,
        center_status="activated",
        user_name="tenant-a",
    )

    assert result == {
        "core_node": core,
        "neighbors": [neighbor],
        "edges": [{"source": "core", "target": "neighbor", "type": "RELATE_TO"}],
    }
    assert "user_name = %s" in _executed_sql(cursor)
    db.get_node.assert_called_once_with("core", user_name="tenant-a")
    db.get_nodes.assert_called_once_with(["neighbor"], user_name="tenant-a")


def test_cube_group_delete_pairs_ids_with_tenants(postgres_db):
    db, cursor = postgres_db
    cursor.fetchone.return_value = (2,)

    deleted = db.delete_node_by_cube_memory_groups(
        [
            {"cube_id": "tenant-a", "memory_ids": ["m1"]},
            {"cube_id": "tenant-b", "memory_ids": ["m2"]},
        ]
    )

    query, params = cursor.execute.call_args.args
    assert deleted == 2
    assert "unnest" in query.lower()
    assert "requested.user_name" in query
    assert params == (["tenant-a", "tenant-b"], ["m1", "m2"])


def test_memory_owner_lookup_preserves_missing_ids(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = [("m1", "tenant-a")]

    owners = db.get_user_names_by_memory_ids(["m1", "missing"])

    assert owners == {"m1": "tenant-a", "missing": None}


def test_export_graph_supports_latest_filters_and_pagination(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchone.return_value = (3,)
    cursor.fetchall.side_effect = [
        [
            (
                "m1",
                "memory",
                {"memory_type": "LongTermMemory", "status": "activated"},
                now,
                now,
            )
        ],
        [("m1", "m2", "RELATE_TO")],
    ]

    result = db.export_graph(
        user_name="tenant-a",
        page=2,
        page_size=1,
        filter={"agent_id": "agent-1"},
        memory_type=["LongTermMemory"],
        status=["activated"],
    )

    sql = _executed_sql(cursor)
    assert result["total_nodes"] == 3
    assert result["nodes"][0]["id"] == "m1"
    assert "properties->'info'->>'agent_id'" in sql
    assert "LIMIT %s OFFSET %s" in sql
    assert "properties->>'memory_type' = ANY(%s)" in sql
    assert "JOIN selected_nodes AS source_node" in sql
    assert "source_node.user_name = e.user_name" in sql


def test_keyword_like_matches_polardb_filters_and_parameter_name(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "memory-1",
            "needle memory",
            {"source": "conversation"},
            now,
            now,
            "tenant-a",
        )
    ]

    result = db.search_by_keywords_like(
        query_word="needle",
        scope="LongTermMemory",
        status="activated",
        search_filter={"source": "conversation"},
        user_name="tenant-a",
        knowledgebase_ids=["kb-1"],
        return_fields=["memory", "source"],
    )

    query, params = cursor.execute.call_args.args
    assert result == [{"id": "memory-1", "memory": "needle memory", "source": "conversation"}]
    assert "user_name = ANY(%s)" in query
    assert ["tenant-a", "kb-1"] in params
    assert "properties->>'source'" in query
    assert "properties->>'memory', '') LIKE %s" in query


def test_keyword_tfidf_matches_polardb_result_shape(postgres_db):
    db, cursor = postgres_db
    now = datetime.now(timezone.utc)
    cursor.fetchall.return_value = [
        (
            "memory-1",
            "needle memory",
            {"source": "conversation"},
            now,
            now,
            "tenant-a",
        )
    ]

    result = db.search_by_keywords_tfidf(
        ["needle", "memory"],
        scope="LongTermMemory",
        user_name="tenant-a",
        return_fields=["memory", "source"],
    )

    assert result == [{"id": "memory-1", "memory": "needle memory", "source": "conversation"}]
    query, params = cursor.execute.call_args.args
    assert params[0] == "'needle' | 'memory'"
    assert "to_tsquery('jiebaqry'" in query
    assert "ILIKE" not in query


def test_keyword_searches_require_explicit_user_name(postgres_db):
    db, cursor = postgres_db

    assert db.search_by_keywords_like("needle") == []
    assert db.search_by_keywords_tfidf(["needle"]) == []
    cursor.execute.assert_not_called()


def test_get_all_memory_items_matches_polardb_defaults(postgres_db):
    db, cursor = postgres_db

    assert db.get_all_memory_items("LongTermMemory") == []
    cursor.execute.assert_not_called()

    with pytest.raises(ValueError, match="Unsupported memory type scope"):
        db.get_all_memory_items("Context", user_name="tenant-a")

    cursor.fetchall.return_value = []
    db.get_all_memory_items("LongTermMemory", user_name="tenant-a")
    query, _ = cursor.execute.call_args.args
    assert "properties->>'status'" not in query


def test_metadata_contains_list_uses_json_array_overlap(postgres_db):
    db, cursor = postgres_db
    cursor.fetchall.return_value = [("m1",)]

    result = db.get_by_metadata(
        [{"field": "tags", "op": "contains", "value": ["blue", "green"]}],
        user_name="tenant-a",
    )

    query, params = cursor.execute.call_args.args
    assert result == ["m1"]
    assert "properties->'tags' @> %s::jsonb" in query
    assert " OR " in query
    assert json.dumps(["blue"], ensure_ascii=False) in params
    assert json.dumps(["green"], ensure_ascii=False) in params
