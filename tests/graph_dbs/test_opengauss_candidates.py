"""Structure candidates: strict state, one snapshot and explicit projection."""

import inspect
import json

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case


@pytest.mark.parametrize("kind", [None, "", " ", 1, False, "LongTermMemory\0"])
def test_invalid_type_before_borrow(capacity, kind):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.get_structure_optimization_candidates(kind)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("cube", ["", " ", 1, False, "A\0"])
def test_invalid_cube_before_borrow(capacity, cube):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.get_structure_optimization_candidates("LongTermMemory", user_name=cube)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("embedding", [None, 0, 1, "true", []])
def test_invalid_projection_before_borrow(capacity, embedding):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError, match="include_embedding"):
        db.get_structure_optimization_candidates("LongTermMemory", embedding)
    pool.getconn.assert_not_called()


def test_closed_precedes_invalid_input(capacity):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        db.get_structure_optimization_candidates(None, None, "\0")
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("embedding", [False, True])
def test_single_bound_query_projection_and_decode_before_commit(capacity, embedding):
    db, pool, connection, cursor = capacity
    cube, kind = " 中文 Cube ' ", " DreamDiary ' "
    metadata = {"status": "activated", "memory_type": kind, "info": {"x": [True, None]}}
    cursor.fetchall.return_value = [
        (key, "text", json.dumps({**metadata, "id": key, "memory": "text", "user_name": cube}), vec)
        for key, vec in [("a", "[1,0,0]"), ("b", None)]
    ]
    assert db.get_structure_optimization_candidates(kind, embedding, cube) == [
        {"id": key, "memory": "text", "metadata": {**metadata, **extra}}
        for key, extra in [
            ("a", {"embedding": [1, 0, 0]} if embedding else {}),
            ("b", {"embedding": None} if embedding else {}),
        ]
    ]
    reads = [c.args for c in cursor.execute.call_args_list if "FROM ONLY" in c.args[0]]
    assert len(reads) == 1
    query, params = reads[0]
    assert cube not in query and kind not in query
    assert cube in params.values() and json.dumps(kind) in params.values()
    assert ("m.embedding::text" in query) == embedding
    assert "COALESCE" not in query and "LIMIT" not in query
    pool.getconn.assert_called_once()
    connection.commit.assert_called_once()


def test_empty_physical_scope_and_public_signature(capacity):
    db, _, _, cursor = capacity
    db.config.user_name = None
    db.config.use_multi_db = True
    assert db.get_structure_optimization_candidates("InsightMemory") == []
    assert "" in cursor.execute.call_args.args[1].values()
    assert list(inspect.signature(db.get_structure_optimization_candidates).parameters) == [
        "scope",
        "include_embedding",
        "user_name",
    ]


@pytest.mark.parametrize("payload,vector", [("{", None), ("[]", None), (None, "[NaN]")])
def test_bad_row_fails_whole_call_and_rolls_back(capacity, payload, vector):
    db, pool, connection, cursor = capacity
    valid = json.dumps({"id": "a", "memory": "text", "user_name": "A"})
    cursor.fetchall.return_value = [
        ("a", "text", valid, None),
        ("a", "text", payload or valid, vector),
    ]
    with pytest.raises(GraphDBError):
        db.get_structure_optimization_candidates("LongTermMemory", True)
    connection.commit.assert_not_called()
    assert connection.rollback.call_count == 2
    pool.putconn.assert_called_once_with(connection, close=False)


@pytest.mark.parametrize("stage", ["cursor", "execute", "fetch", "commit", "putconn"])
def test_driver_failure_preserves_cause_and_releases_slot(capacity, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.ProgrammingError("synthetic candidate failure")
    if stage == "cursor":
        connection.cursor.side_effect = error
    elif stage == "execute":
        cursor.execute.side_effect = error
    elif stage == "fetch":
        cursor.fetchall.side_effect = error
    elif stage == "commit":
        connection.commit.side_effect = error
    else:
        pool.putconn.side_effect = error
    with pytest.raises(GraphDBError) as caught:
        db.get_structure_optimization_candidates("LongTermMemory")
    assert caught.value.__cause__ is error
    assert pool.getconn.call_count == 1 and connection.commit.call_count <= 1
    assert db._active == 0 and db._closed == (stage == "putconn")
