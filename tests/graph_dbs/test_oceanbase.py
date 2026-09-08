from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.factory import GraphStoreFactory


@pytest.fixture
def cursor():
    return MagicMock(name="cursor")


@pytest.fixture
def graph_db(cursor):
    conn = MagicMock(name="conn")
    conn.cursor.return_value = cursor
    config = GraphDBConfigFactory.model_validate(
        {
            "backend": "oceanbase",
            "config": {
                "host": "127.0.0.1",
                "port": 2881,
                "user": "root",
                "password": "",
                "db_name": "memos",
                "user_name": "alice",
                "embedding_dimension": 3,
            },
        }
    )
    with patch("pymysql.connect", return_value=conn):
        db = GraphStoreFactory.from_config(config)
    return db


def _executed_sql(cursor):
    return [str(call.args[0]) for call in cursor.execute.call_args_list]


def _last_select(cursor):
    """Return the (sql, params) of the last executed SELECT statement."""
    calls = [
        (str(call.args[0]), call.args[1] if len(call.args) > 1 else ())
        for call in cursor.execute.call_args_list
        if "SELECT" in str(call.args[0]).upper()
    ]
    assert calls, "no SELECT statement was executed"
    return calls[-1]


def test_backend_registered():
    for backend in ("oceanbase", "seekdb"):
        assert backend in GraphStoreFactory.backend_to_class


def test_schema_initialized(graph_db, cursor):
    ddl = " ".join(_executed_sql(cursor))
    assert "memos_graph_nodes" in ddl
    assert "memos_graph_edges" in ddl


def test_add_node(graph_db, cursor):
    graph_db.add_node("n1", "hello", {"status": "activated"})
    sqls = _executed_sql(cursor)
    assert any("INSERT INTO memos_graph_nodes" in s for s in sqls)


def test_add_node_with_embedding(graph_db, cursor):
    graph_db.add_node("n1", "hello", {"status": "activated", "embedding": [0.1, 0.2, 0.3]})
    insert_sql = next(s for s in _executed_sql(cursor) if "INSERT INTO memos_graph_nodes" in s)
    assert "embedding" in insert_sql


def test_get_node(graph_db, cursor):
    cursor.fetchone.return_value = (
        "n1",
        "hello",
        '{"status": "activated"}',
        "2024-01-01 00:00:00",
        "2024-01-02 00:00:00",
    )
    node = graph_db.get_node("n1")
    assert node["id"] == "n1"
    assert node["memory"] == "hello"
    assert node["metadata"]["status"] == "activated"
    assert node["metadata"]["created_at"] == "2024-01-01 00:00:00"


def test_get_node_missing(graph_db, cursor):
    cursor.fetchone.return_value = None
    assert graph_db.get_node("nope") is None


def test_edge_exists_true(graph_db, cursor):
    cursor.fetchone.return_value = (1,)
    assert graph_db.edge_exists("a", "b", "FOLLOWS") is True


def test_edge_exists_false(graph_db, cursor):
    cursor.fetchone.return_value = None
    assert graph_db.edge_exists("a", "b", "FOLLOWS") is False


def test_get_neighbors(graph_db, cursor):
    cursor.fetchall.return_value = [("b",), ("c",)]
    assert graph_db.get_neighbors("a", "FOLLOWS", "out") == ["b", "c"]


def test_search_by_embedding_threshold(graph_db, cursor):
    # score == threshold (0.5) must be included (implementation uses score >= threshold).
    cursor.fetchall.return_value = [("n1", 0.9), ("n3", 0.5), ("n2", 0.4)]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], top_k=5, threshold=0.5)
    assert results == [{"id": "n1", "score": 0.9}, {"id": "n3", "score": 0.5}]


def test_search_by_embedding_returns_requested_fields(graph_db, cursor):
    # Columns after (id, score) are memory, properties, created_at, updated_at, user_name.
    cursor.fetchall.return_value = [
        (
            "n1",
            0.9,
            "hello",
            '{"key": "k1", "status": "activated"}',
            "2024-01-01 00:00:00",
            "2024-01-02 00:00:00",
            "alice",
        )
    ]
    results = graph_db.search_by_embedding(
        [0.1, 0.2, 0.3], top_k=5, return_fields=["memory", "key", "user_name", "updated_at"]
    )
    assert results == [
        {
            "id": "n1",
            "score": 0.9,
            "memory": "hello",
            "key": "k1",
            "user_name": "alice",
            "updated_at": "2024-01-02 00:00:00",
        }
    ]


def test_search_by_embedding_return_fields_include_embedding(graph_db, cursor):
    cursor.fetchall.return_value = [
        ("n1", 0.9, "hello", "{}", None, None, "alice", "[0.1,0.2,0.3]")
    ]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], return_fields=["memory", "embedding"])
    assert results == [{"id": "n1", "score": 0.9, "memory": "hello", "embedding": [0.1, 0.2, 0.3]}]


def test_search_by_embedding_return_fields_cannot_shadow_id_or_score(graph_db, cursor):
    """`id`/`score` come from the query; a same-named property must not win."""
    cursor.fetchall.return_value = [
        (
            "n1",
            0.9,
            "hello",
            '{"id": "forged", "score": 0.1}',
            None,
            None,
            "alice",
        )
    ]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], return_fields=["id", "score", "memory"])
    assert results == [{"id": "n1", "score": 0.9, "memory": "hello"}]


def test_search_by_embedding_user_name_comes_from_column(graph_db, cursor):
    """The tenant column is authoritative; a stale JSON copy must not win."""
    cursor.fetchall.return_value = [
        ("n1", 0.9, "hello", '{"user_name": "stale"}', None, None, "alice")
    ]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], return_fields=["user_name"])
    assert results == [{"id": "n1", "score": 0.9, "user_name": "alice"}]


def test_search_by_embedding_null_user_name_does_not_fall_back_to_json(graph_db, cursor):
    """A NULL tenant column stays NULL; use_multi_db makes this reachable."""
    cursor.fetchall.return_value = [
        ("n1", 0.9, "hello", '{"user_name": "stale"}', None, None, None)
    ]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], return_fields=["user_name"])
    assert results == [{"id": "n1", "score": 0.9, "user_name": None}]


def test_search_by_embedding_ignores_unsafe_return_fields(graph_db, cursor):
    cursor.fetchall.return_value = [("n1", 0.9)]
    results = graph_db.search_by_embedding([0.1, 0.2, 0.3], return_fields=["memory; DROP TABLE"])
    assert results == [{"id": "n1", "score": 0.9}]
    sql, _ = _last_select(cursor)
    assert "DROP TABLE" not in sql.upper()


def test_search_by_embedding_applies_structured_filter(graph_db, cursor):
    cursor.fetchall.return_value = []
    graph_db.search_by_embedding(
        [0.1, 0.2, 0.3], filter={"and": [{"session_id": "s1"}, {"tags": ["urgent"]}]}
    )
    sql, params = _last_select(cursor)
    assert "$.session_id" in sql
    assert "JSON_CONTAINS" in sql
    assert "s1" in params


def test_search_by_embedding_scopes_to_knowledgebase_ids(graph_db, cursor):
    cursor.fetchall.return_value = []
    graph_db.search_by_embedding([0.1, 0.2, 0.3], knowledgebase_ids=["bob", "carol"])
    sql, params = _last_select(cursor)
    assert "user_name IN (%s, %s, %s)" in sql
    assert {"alice", "bob", "carol"}.issubset(set(params))


def test_search_by_embedding_placeholders_match_params(graph_db, cursor):
    """Every %s must have exactly one bound value, whatever mix of clauses is used."""
    cursor.fetchall.return_value = []
    graph_db.search_by_embedding(
        [0.1, 0.2, 0.3],
        top_k=3,
        scope="LongTermMemory",
        status="activated",
        search_filter={"source": "chat"},
        filter={"or": [{"session_id": "s1"}, {"tags": ["urgent"]}]},
        knowledgebase_ids=["bob", "carol"],
    )
    sql, params = _last_select(cursor)
    assert sql.count("%s") == len(params)


def test_get_by_metadata_applies_filter_and_knowledgebase_ids(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",)]
    graph_db.get_by_metadata([], filter={"session_id": "s1"}, knowledgebase_ids=["bob"])
    sql, params = _last_select(cursor)
    assert "user_name IN (%s, %s)" in sql
    assert "$.session_id" in sql
    assert "s1" in params


def test_get_all_memory_items_applies_filter(graph_db, cursor):
    # recall.py passes `filter` unconditionally when loading WorkingMemory.
    cursor.fetchall.return_value = []
    graph_db.get_all_memory_items(
        scope="WorkingMemory", status="activated", filter={"session_id": "s1"}
    )
    sql, params = _last_select(cursor)
    assert "$.session_id" in sql
    assert "s1" in params


def test_delete_by_file_ids_requires_writable_cube_ids(graph_db):
    with pytest.raises(ValueError, match="writable_cube_ids"):
        graph_db.delete_node_by_prams(file_ids=["f1"])


def test_delete_by_filter_falls_back_to_configured_user(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",)]
    graph_db.delete_node_by_prams(filter={"session_id": "s1"})
    sql, params = _last_select(cursor)
    assert "user_name = %s" in sql
    assert "alice" in params


def test_delete_is_scoped_to_writable_cube_ids(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",)]
    graph_db.delete_node_by_prams(writable_cube_ids=["bob", "carol"], memory_ids=["n1"])
    sql, params = _last_select(cursor)
    assert "user_name IN (%s, %s)" in sql
    assert "alice" not in params


def test_get_path_cte(graph_db, cursor):
    # Recursive CTE returns a single row whose JSON array holds the full path.
    cursor.fetchone.return_value = ('["a", "b", "c"]',)
    assert graph_db.get_path("a", "c", max_depth=3) == ["a", "b", "c"]


def test_get_path_not_found(graph_db, cursor):
    cursor.fetchone.return_value = None
    assert graph_db.get_path("a", "z", max_depth=3) == []


def test_get_path_same_node(graph_db):
    assert graph_db.get_path("a", "a") == ["a"]


def test_get_subgraph_cte(graph_db, cursor):
    # Recursive CTE returns one node id per row.
    cursor.fetchall.return_value = [("a",), ("b",), ("c",)]
    result = set(graph_db.get_subgraph("a", depth=1))
    assert result == {"a", "b", "c"}


def test_get_by_metadata(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",), ("n2",)]
    ids = graph_db.get_by_metadata([{"field": "topic", "value": "psychology"}])
    assert ids == ["n1", "n2"]


def test_clear_is_tenant_scoped(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",)]
    graph_db.clear()
    sqls = _executed_sql(cursor)
    delete_nodes = [s for s in sqls if "DELETE FROM memos_graph_nodes" in s]
    assert delete_nodes
    assert all("user_name = %s" in s for s in delete_nodes)


def test_drop_database_never_drops_physical_db(graph_db, cursor):
    cursor.fetchall.return_value = [("n1",)]
    graph_db.drop_database()
    all_sql = " ".join(_executed_sql(cursor)).upper()
    assert "DROP DATABASE" not in all_sql
