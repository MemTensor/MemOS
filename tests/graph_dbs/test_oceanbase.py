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
