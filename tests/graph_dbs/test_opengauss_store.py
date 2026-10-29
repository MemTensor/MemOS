"""AGE node storage contract; database tests live beside these unit tests."""

import importlib
import json

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig


@pytest.fixture
def config():
    return OpenGaussGraphDBConfig(
        host="localhost",
        user="memos",
        password="synthetic-password",
        db_name="test",
        user_name="A",
        embedding_dimension=3,
        maxconn=2,
    )


@pytest.fixture
def store(config, monkeypatch):
    module = importlib.import_module("memos.graph_dbs._opengauss_store")
    pool = MagicMock()
    connection = pool.transaction.return_value.__enter__.return_value
    cursor = connection.cursor.return_value.__enter__.return_value
    monkeypatch.setattr(module, "OpenGaussConnectionPool", MagicMock(return_value=pool))
    monkeypatch.setattr(module.OpenGaussNodeStore, "_initialize", lambda self: None)
    return module.OpenGaussNodeStore(config), pool, cursor


def test_upsert_preserves_input_and_binds_scope_and_payload(store):
    db, pool, cursor = store
    metadata = {
        "memory_type": "LongTermMemory",
        "embedding": [1, 0, 0],
        "sources": [{"type": "chat", "content": "中文 ' ; DROP TABLE Memory; --\n"}],
        "info": {"nested": [True, None, 3]},
        "created_at": "2026-01-01T00:00:00Z",
    }
    original = deepcopy(metadata)
    db.add_node("same", "fixture memory", metadata)
    assert metadata == original
    query, params = cursor.execute.call_args.args
    assert "ON CONFLICT (scope, business_id)" in query
    assert "id =" not in query.split("DO UPDATE", 1)[1]
    assert params[:3] == ("A", "same", "fixture memory")
    assert json.loads(params[3]) == [1, 0, 0]
    properties = json.loads(params[4])
    assert properties == {
        **{k: v for k, v in metadata.items() if k != "embedding"},
        "id": "same",
        "memory": "fixture memory",
        "user_name": "A",
    }
    pool.transaction.assert_called_once()


def test_reads_reorder_and_deduplicate_without_leaking_scope(store):
    db, _, cursor = store
    cursor.fetchall.return_value = [
        (
            "two",
            "second",
            json.dumps({"id": "two", "memory": "second", "user_name": "A", "status": "archived"}),
            None,
        ),
        (
            "one",
            "first",
            json.dumps({"id": "one", "memory": "first", "user_name": "A", "tags": ["x"]}),
            "[1,0,0]",
        ),
    ]
    assert db.get_nodes(["one", "missing", "two", "one"], include_embedding=True) == [
        {"id": "one", "memory": "first", "metadata": {"tags": ["x"], "embedding": [1, 0, 0]}},
        {"id": "two", "memory": "second", "metadata": {"status": "archived", "embedding": None}},
    ]
    assert cursor.execute.call_args.args[1] == ("A", ["one", "missing", "two"])


@pytest.mark.parametrize("position", [0, 1, 2])
def test_bad_batch_is_rejected_before_acquiring_a_connection(store, position):
    db, pool, _ = store
    nodes = [{"id": str(i), "memory": "ok"} for i in range(3)]
    nodes[position]["metadata"] = {"embedding": [1, 2]}
    with pytest.raises(ValueError, match="embedding"):
        db.add_nodes_batch(nodes)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("scope", ["B", " 中文 Cube ' ; -- "])
def test_explicit_scope_is_preserved_and_overrides_config(store, scope):
    db, _, cursor = store
    db.add_node("id", "", {"user_name": scope}, user_name=scope)
    assert cursor.execute.call_args.args[1][0] == scope


@pytest.mark.parametrize("scope", ["", " \t", False, 12, [], {}])
def test_bad_scope_never_borrows(store, scope):
    db, pool, _ = store
    with pytest.raises(ValueError, match="user_name"):
        db.get_nodes(["one"], user_name=scope)
    pool.transaction.assert_not_called()


def test_physical_database_scope_is_explicitly_bounded(store):
    db, _, cursor = store
    db.config.use_multi_db = True
    db.config.user_name = None
    db.add_node("id", "physical", {})
    assert cursor.execute.call_args.args[1][0] == ""
    db.config.use_multi_db = False
    with pytest.raises(ValueError, match="user_name"):
        db.get_node("id")


@pytest.mark.parametrize(
    "node",
    [
        {},
        {"id": "x"},
        {"memory": "ok"},
        None,
        [],
        {"id": None, "memory": "ok"},
        {"id": " ", "memory": "ok"},
        {"id": False, "memory": "ok"},
        {"id": "x", "memory": None},
        {"id": "x", "memory": False},
        {"id": "x", "metadata": [], "memory": "ok"},
        {"id": "x", "metadata": None, "memory": "ok"},
    ],
)
def test_invalid_node_has_no_database_side_effect(store, node):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.add_nodes_batch([node])
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("nodes", [None, {}, "wrong", ("one",)])
def test_batches_require_a_list(store, nodes):
    db, pool, _ = store
    with pytest.raises(ValueError, match="nodes"):
        db.add_nodes_batch(nodes)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("embedding", [None, []])
def test_vectorless_nodes_are_allowed_without_random_embeddings(store, embedding):
    db, _, cursor = store
    db.add_node(
        "dream", "", {"embedding": embedding, "memory_type": "CustomMemory", "status": "pending"}
    )
    assert cursor.execute.call_args.args[1][3] is None


@pytest.mark.parametrize(
    "metadata",
    [
        {"id": "overridden"},
        {"memory": "overridden"},
        {"user_name": "B"},
        {"embedding": [1, 2]},
        {"embedding": [1, 2, 3, 4]},
        {"embedding": [True, 0, 0]},
        {"embedding": [1, "0", 0]},
        {"embedding": [1, float("nan"), 0]},
        {"embedding": [1, float("inf"), 0]},
        {"embedding": False},
        {"embedding": "[1,0,0]"},
        {"embedding": (1, 0, 0)},
        {"info": {1: "integer key"}},
        {"info": ("tuple",)},
        {"embedding": [10**400, 0, 0]},
        {"info": {1, 2}},
        {"info": float("nan")},
    ],
)
def test_invalid_metadata_and_vectors_do_not_borrow(store, metadata):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.add_node("x", "ok", metadata)
    pool.transaction.assert_not_called()


def test_empty_batches_and_reads_do_not_borrow_but_check_lifecycle(store):
    db, pool, _ = store
    db.add_nodes_batch([])
    assert db.get_nodes([]) == []
    pool.transaction.assert_not_called()
    assert pool.ensure_open.call_count == 2


@pytest.mark.parametrize("ids", [None, "one", {}, [None], [False], [""]])
def test_invalid_read_ids_do_not_borrow(store, ids):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.get_nodes(ids)
    pool.transaction.assert_not_called()


def test_single_read_missing_and_vector_projection(store):
    db, _, cursor = store
    cursor.fetchall.return_value = []
    assert db.get_node("missing") is None
    cursor.fetchall.return_value = [
        (
            "one",
            "first",
            json.dumps(
                {
                    "id": "one",
                    "memory": "first",
                    "user_name": "A",
                    "sources": "raw string",
                    "info": None,
                }
            ),
            None,
        )
    ]
    assert db.get_node("one") == {
        "id": "one",
        "memory": "first",
        "metadata": {"sources": "raw string", "info": None},
    }
    assert "embedding::text" not in cursor.execute.call_args.args[0]
    with pytest.raises(ValueError, match="include_embedding"):
        db.get_node("one", include_embedding="false")


@pytest.mark.parametrize(
    "properties", ["broken", "null", "[]", "{}", '{"id":"other","memory":"first","user_name":"A"}']
)
def test_damaged_or_inconsistent_properties_are_errors(store, properties):
    from memos.exceptions import GraphDBError

    db, _, cursor = store
    cursor.fetchall.return_value = [("one", "first", properties, None)]
    with pytest.raises(GraphDBError):
        db.get_node("one")


def test_partial_update_keeps_fields_and_does_not_mutate_input(store):
    db, _, cursor = store
    cursor.fetchone.return_value = (
        "one",
        "before",
        json.dumps(
            {
                "id": "one",
                "memory": "before",
                "user_name": "A",
                "tags": ["keep"],
                "info": {"old": 1},
            }
        ),
        "[1,0,0]",
    )
    fields = {"info": {"new": 2}, "memory": "after"}
    original = deepcopy(fields)
    db.update_node("one", fields)
    query, params = cursor.execute.call_args.args
    assert query.startswith("UPDATE")
    assert params[:2] == ("after", "[1, 0, 0]")
    assert json.loads(params[2]) == {
        "id": "one",
        "memory": "after",
        "user_name": "A",
        "tags": ["keep"],
        "info": {"new": 2},
    }
    assert params[3:] == ("A", "one")
    assert fields == original
    assert any("FOR UPDATE" in call.args[0] for call in cursor.execute.call_args_list)


@pytest.mark.parametrize(
    "fields", [{"tags": ["new"]}, {"embedding": None}, {"embedding": []}, {"embedding": [0, 1, 0]}]
)
def test_partial_update_embedding_presence_controls_preservation(store, fields):
    db, _, cursor = store
    cursor.fetchone.return_value = (
        "one",
        "before",
        json.dumps({"id": "one", "memory": "before", "user_name": "A"}),
        "[1,0,0]",
    )
    db.update_node("one", fields)
    params = cursor.execute.call_args.args[1]
    assert params[0] == "before"
    expected = fields.get("embedding", [1, 0, 0])
    assert (None if params[1] is None else json.loads(params[1])) == (expected or None)


def test_missing_update_is_noop_and_empty_update_does_not_borrow(store):
    db, pool, cursor = store
    db.update_node("missing", {})
    pool.transaction.assert_not_called()
    cursor.fetchone.return_value = None
    db.update_node("missing", {"tags": []})
    assert "FOR UPDATE" in cursor.execute.call_args.args[0]
    db.close()
    pool.close.assert_called_once()


@pytest.mark.parametrize(
    "fields",
    [None, [], {"id": "other"}, {"user_name": "B"}, {"memory": None}, {"embedding": [False, 0, 0]}],
)
def test_invalid_updates_do_not_borrow(store, fields):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.update_node("one", fields)
    pool.transaction.assert_not_called()


def _columns():
    return [
        ("id", "graphid", True, True, 1),
        ("properties", "agtype", True, True, 2),
        ("scope", "text", True, False, 3),
        ("business_id", "text", True, False, 4),
        ("memory", "text", True, False, 5),
        ("embedding", "vector(3)", False, False, 6),
    ]


@pytest.fixture
def schema_case(config, monkeypatch):
    module = importlib.import_module("memos.graph_dbs._opengauss_store")
    pool = MagicMock()
    cursor = pool.transaction.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [(1,), ("v", "memos_graph", "Memory"), (1,)]
    cursor.fetchall.return_value = _columns()
    monkeypatch.setattr(module, "OpenGaussConnectionPool", MagicMock(return_value=pool))
    return module, config, pool, cursor


@pytest.mark.parametrize("graph", [None, (1,)])
def test_initialization_creates_missing_graph_or_label_without_private_id_helpers(
    schema_case, graph
):
    module, config, pool, cursor = schema_case
    cursor.fetchone.side_effect = [graph, None, (1,)]
    db = module.OpenGaussNodeStore(config)
    assert db.config is not config
    queries = [call.args[0] for call in cursor.execute.call_args_list]
    assert any("pg_advisory_xact_lock" in query for query in queries)
    assert sum("create_graph" in query for query in queries) == (1 if graph is None else 0)
    assert any("create_vlabel" in query for query in queries)
    assert not any("_make_graph_id" in query for query in queries)
    pool.close.assert_not_called()


def test_compatible_initialization_does_not_run_destructive_ddl(schema_case):
    module, config, _, cursor = schema_case
    module.OpenGaussNodeStore(config)
    assert not any(
        "CREATE " in call.args[0] or "ALTER " in call.args[0] or "DROP " in call.args[0]
        for call in cursor.execute.call_args_list
    )


@pytest.mark.parametrize("failure", ["label", "columns", "unique"])
def test_incompatible_schema_is_rejected_and_pool_closed(schema_case, failure):
    from memos.exceptions import GraphDBError

    module, config, pool, cursor = schema_case
    if failure == "label":
        cursor.fetchone.side_effect = [(1,), ("e", "memos_graph", "Memory")]
    elif failure == "columns":
        cursor.fetchall.return_value = _columns()[:-1] + [
            ("embedding", "vector(4)", False, False, 6)
        ]
    else:
        cursor.fetchone.side_effect = [(1,), ("v", "memos_graph", "Memory"), None]
    with pytest.raises(GraphDBError, match="incompatible"):
        module.OpenGaussNodeStore(config)
    pool.close.assert_called_once()


def test_initialization_failure_preserves_original_even_if_close_fails(schema_case, monkeypatch):
    from memos.exceptions import GraphDBError

    module, config, pool, _ = schema_case
    error = ValueError("original")

    def fail(self):
        raise error

    monkeypatch.setattr(module.OpenGaussNodeStore, "_initialize", fail)
    pool.close.side_effect = GraphDBError("cleanup")
    with pytest.raises(ValueError) as caught:
        module.OpenGaussNodeStore(config)
    assert caught.value is error
