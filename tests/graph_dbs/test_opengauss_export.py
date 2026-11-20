"""Export validation, projections, snapshot selection and failure handling."""

import json

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case


@pytest.mark.parametrize(
    "kwargs",
    [
        {"include_embedding": 1},
        {"all_cubes": None},
        {"all_cubes": True, "user_name": "A"},
        {"user_name": ""},
        {"user_name": "A\0"},
        {"user_id": ""},
        {"user_id": 1},
        {"user_id": "u\0"},
        {"unknown": True},
        {"page": 1},
        {"page_size": 2},
        {"page": 0, "page_size": 2},
        {"page": True, "page_size": 2},
        {"page": 1, "page_size": 0},
        {"page": 1, "page_size": True},
        {"memory_type": "LongTermMemory"},
        {"memory_type": [1]},
        {"memory_type": ["x\0"]},
        {"status": [""]},
        {"status": ["x\0"]},
        {"status": 1},
        {"exclude_user_name": "P"},
        {"all_cubes": True, "exclude_user_name": ""},
        {"all_cubes": True, "exclude_user_name": " "},
        {"all_cubes": True, "exclude_user_name": 1},
        {"all_cubes": True, "exclude_user_name": "P\0"},
    ],
)
def test_invalid_export_never_borrows(capacity, kwargs):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.export_graph(**kwargs)
    pool.getconn.assert_not_called()


def test_closed_export_precedes_validation(capacity):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        db.export_graph(page=-1)
    pool.getconn.assert_not_called()


def test_excluded_cube_is_bound_in_count_and_page_predicates(capacity):
    db, _, _, cursor = capacity
    cursor.fetchone.return_value = (0,)
    cursor.fetchall.return_value = []
    excluded = "P' OR true --"
    assert db.export_graph(all_cubes=True, exclude_user_name=excluded)["nodes"] == []
    queries = [
        call
        for call in cursor.execute.call_args_list
        if call.args[0].startswith(("SELECT COUNT(*)", "SELECT business_id,"))
    ]
    assert len(queries) == 2
    for query in queries:
        assert excluded not in query.args[0]
        assert "scope <> %(memos_excluded_owner)s" in query.args[0]
        assert query.args[1]["memos_excluded_owner"] == excluded


@pytest.mark.parametrize("embedding,all_cubes", [(False, False), (True, True)])
def test_snapshot_projection_and_bound_input(capacity, embedding, all_cubes):
    db, pool, connection, cursor = capacity
    cursor.fetchone.return_value = (1,)
    cursor.fetchall.side_effect = [
        [
            (
                "same",
                "text",
                json.dumps({"id": "same", "memory": "text", "user_name": "A"}),
                "[1,0,0]",
                "A",
                "123",
            )
        ],
        [("same", "same", "PARENT", "A")],
    ]
    result = db.export_graph(
        include_embedding=embedding,
        all_cubes=all_cubes,
        user_id=" u' ",
        status=[],
        memory_type=["DreamDiary"],
        page=1,
        page_size=2,
    )
    assert result == {
        "nodes": [
            {
                "id": "same",
                "memory": "text",
                "metadata": {"user_name": "A", **({"embedding": [1, 0, 0]} if embedding else {})},
            }
        ],
        "edges": [
            {
                "source": "same",
                "target": "same",
                "type": "PARENT",
                **({"user_name": "A"} if all_cubes else {}),
            }
        ],
        "total_nodes": 1,
        "total_edges": 1,
    }
    connection.set_session.assert_called_once_with(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )
    assert all(" u' " not in call.args[0] for call in cursor.execute.call_args_list)
    pool.getconn.assert_called_once()
    connection.commit.assert_called_once()


@pytest.mark.parametrize("stage", ["execute", "fetch", "decode", "edge", "commit", "putconn"])
def test_export_errors_preserve_transaction_semantics(capacity, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    cursor.fetchone.return_value = (1,)
    row = ("a", "text", '{"id":"a","memory":"text","user_name":"A"}', None, "A", "123")
    cursor.fetchall.side_effect = [[row], [("a", "a", "PARENT", "A")]]
    error = psycopg2.ProgrammingError("export injected failure")
    if stage == "execute":
        cursor.execute.side_effect = error
    elif stage == "fetch":
        cursor.fetchall.side_effect = error
    elif stage == "decode":
        cursor.fetchall.side_effect = [[(*row[:2], "{", *row[3:])]]
    elif stage == "edge":
        cursor.fetchall.side_effect = [[row], [("a", "a", None, "A")]]
    elif stage == "commit":
        connection.commit.side_effect = error
    else:
        pool.putconn.side_effect = error
    with pytest.raises(GraphDBError) as caught:
        db.export_graph()
    if stage not in {"decode", "edge"}:
        assert caught.value.__cause__ is error
    assert db._active == 0 and pool.getconn.call_count == 1
    if stage not in {"commit", "putconn"}:
        connection.commit.assert_not_called()


def test_snapshot_cursor_returns_to_default_session(capacity):
    db, _, connection, cursor = capacity
    with db._cursor(snapshot=True):
        pass
    with db._cursor():
        pass
    assert [c.kwargs for c in connection.set_session.call_args_list] == [
        {"isolation_level": "REPEATABLE READ", "readonly": True, "autocommit": False},
        {"isolation_level": "READ COMMITTED", "readonly": False, "autocommit": False},
    ]
