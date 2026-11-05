"""Real MemoryManager/Reorganizer calls, with only model services replaced."""

import os
import uuid

from collections import Counter
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from memos.exceptions import GraphDBError
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from tests.graph_dbs import test_opengauss_capacity_integration as support


database, stores = support.database, support.stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)
M1, M2, M3 = [f"00000000-0000-4000-8000-{i:012}" for i in range(1, 4)]


def item(node_id=M3, memory="新增工作记忆"):
    return TextualMemoryItem(
        id=node_id,
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="WorkingMemory", status="activated", embedding=[1, 0, 0]
        ),
    )


def seed_old(db, count=2):
    for i, node_id in enumerate([M1, M2, M3][:count], 1):
        db.add_node(
            node_id,
            ["旧工作一", "旧工作二", "旧工作三"][i - 1],
            {
                "memory_type": "WorkingMemory",
                "status": "activated",
                "embedding": [1, 0, 0],
                "updated_at": f"2000-01-0{i}T00:00:00Z",
            },
        )


@pytest.fixture
def manager(stores):
    db = stores()
    instance = MemoryManager(
        db, MagicMock(), MagicMock(), memory_size={"WorkingMemory": 2}, is_reorganize=False
    )
    instance.current_memory_size = {"WorkingMemory": 2}
    try:
        yield instance, db
    finally:
        instance.close()


def stored(db):
    return db.get_nodes(support.ids(db), include_embedding=True)


def assert_generated(rows, texts, start, end):
    assert end >= start > datetime(2000, 1, 3)
    assert Counter(row["memory"] for row in rows) == Counter(texts)
    assert len({row["id"] for row in rows}) == len(rows)
    for row in rows:
        assert str(uuid.UUID(row["id"])) == row["id"]
        metadata = row["metadata"]
        assert metadata["embedding"] == [1, 0, 0]
        assert metadata["memory_type"] == "WorkingMemory"
        assert metadata["status"] == "activated"
        assert start <= datetime.fromisoformat(metadata["updated_at"]) <= end


def test_nonbatch_add_really_trims_new_working_memory(manager):
    instance, db = manager
    seed_old(db)
    old = db.get_node(M2, include_embedding=True)
    start = datetime.now()
    assert instance.add([item()], user_name="A", mode="sync", use_batch=False) == []
    end = datetime.now()
    assert support.ids(db) == [M2, M3]
    assert db.get_node(M2, include_embedding=True) == old
    assert_generated([db.get_node(M3, include_embedding=True)], ["新增工作记忆"], start, end)
    assert instance.get_current_memory_size(user_name="A") == {"WorkingMemory": 2}


def test_default_batch_does_not_write_working_nodes(manager):
    instance, db = manager
    assert instance.add([item(key) for key in [M1, M2, M3]], user_name="A", use_batch=True) == []
    assert stored(db) == []
    assert instance.get_current_memory_size(user_name="A") == {}


def test_replace_preslices_two_inputs_then_trims_old_nodes(manager):
    instance, db = manager
    seed_old(db)
    start = datetime.now()
    assert (
        instance.replace_working_memory(
            [item(memory=text) for text in ["替换一", "替换二", "替换三"]], user_name="A"
        )
        is None
    )
    end = datetime.now()
    rows = stored(db)
    assert not {M1, M2} & {row["id"] for row in rows}
    assert_generated(rows, ["替换一", "替换二"], start, end)
    assert instance.current_memory_size == {"WorkingMemory": 2}


@pytest.mark.parametrize(
    "limit,cached,called",
    [
        (2, 0, False),
        (2, 1, True),
        (2, 2, True),
        (2, 3, True),
        (3, 1, False),
        (3, 2, True),
        (20, 15, False),
        (20, 16, True),
    ],
)
def test_cleanup_uses_cached_threshold_and_forwards_limit(
    manager, monkeypatch, limit, cached, called
):
    instance, db = manager
    instance.memory_size = {"WorkingMemory": limit}
    instance.current_memory_size = {"WorkingMemory": cached}
    spy = MagicMock(wraps=db.remove_oldest_memory)
    monkeypatch.setattr(db, "remove_oldest_memory", spy)
    instance._cleanup_memories_if_needed(user_name="A")
    assert spy.call_count == int(called)
    if called:
        spy.assert_called_once_with(memory_type="WorkingMemory", keep_latest=limit, user_name="A")
    assert stored(db) == []


def test_cleanup_then_refresh_requires_second_call_with_stale_cache(manager):
    instance, db = manager
    support.seed(db, only_working=True)
    instance.current_memory_size = {"WorkingMemory": 0}
    instance.remove_and_refresh_memory(user_name="A")
    assert support.ids(db) == support.WORKING
    assert instance.current_memory_size == {"WorkingMemory": 5}
    instance.remove_and_refresh_memory(user_name="A")
    assert support.ids(db) == ["w3", "w5"]
    assert instance.current_memory_size == {"WorkingMemory": 2}


def test_string_capacity_still_fails_in_consumers_list_slice(manager):
    instance, db = manager
    seed_old(db)
    before = stored(db)
    instance.memory_size = {"WorkingMemory": "2"}
    with pytest.raises(TypeError):
        instance.replace_working_memory([item()], user_name="A")
    assert stored(db) == before


@pytest.mark.parametrize("has_node", [False, True])
def test_reorganizer_skips_missing_or_archived_only_candidates(manager, monkeypatch, has_node):
    instance, db = manager
    if has_node:
        db.add_node(M1, "archived node", {"memory_type": "LongTermMemory", "status": "archived"})
    reorganizer = instance.reorganizer
    reorganizer._is_optimizing = {"LongTermMemory": False, "UserMemory": False}
    missing = MagicMock(wraps=db.node_not_exist)
    count = MagicMock(wraps=db.get_memory_count)
    candidates = MagicMock(wraps=db.get_structure_optimization_candidates)
    monkeypatch.setattr(db, "node_not_exist", missing)
    monkeypatch.setattr(db, "get_memory_count", count)
    monkeypatch.setattr(db, "get_structure_optimization_candidates", candidates)
    if has_node:
        assert reorganizer.optimize_structure(scope="LongTermMemory", user_name="A") is None
        candidates.assert_called_once_with("LongTermMemory", include_embedding=True, user_name="A")
        # node_not_exist also delegates to the real count method.
        assert count.call_count == 2
    else:
        assert reorganizer.optimize_structure(scope="LongTermMemory", user_name="A") is None
        candidates.assert_not_called()
        assert count.call_count == 1
    missing.assert_called_once_with("LongTermMemory", user_name="A")
    assert reorganizer._is_optimizing == {"LongTermMemory": False, "UserMemory": False}


@pytest.mark.parametrize("operation", ["add", "replace", "refresh"])
def test_consumer_cleanup_failure_preserves_separately_committed_writes(
    manager, database, operation, caplog
):
    instance, db = manager
    admin, _ = database
    seed_old(db, count=3 if operation == "refresh" else 2)
    old = stored(db)
    start = datetime.now()
    with support.failing_delete(admin, node_id=M1):
        if operation == "replace":
            with pytest.raises(GraphDBError) as caught:
                instance.replace_working_memory(
                    [item(memory=text) for text in ["替换一", "替换二", "替换三"]], user_name="A"
                )
            assert caught.value.__cause__.pgcode == "P0001"
        elif operation == "add":
            assert instance.add([item()], user_name="A", mode="sync", use_batch=False) == []
        else:
            assert instance.remove_and_refresh_memory(user_name="A") is None
    end = datetime.now()
    after = stored(db)
    assert [row for row in after if row["id"] in {row["id"] for row in old}] == old
    generated = [row for row in after if row["id"] not in {row["id"] for row in old}]
    assert_generated(
        generated,
        {"add": ["新增工作记忆"], "replace": ["替换一", "替换二"], "refresh": []}[operation],
        start,
        end,
    )
    assert len(after) == (4 if operation == "replace" else 3)
    assert instance.current_memory_size == {"WorkingMemory": 3 if operation == "refresh" else 2}
    if operation != "replace":
        assert "Remove WorkingMemory error" in caplog.text


def test_failed_count_refresh_preserves_cache_and_rows(manager, database):
    from psycopg2 import sql

    instance, db = manager
    admin, config = database
    seed_old(db, count=3)
    before = stored(db)
    support._query(
        admin,
        sql.SQL("REVOKE SELECT ON {} FROM {}").format(
            sql.SQL(support.TABLE), sql.Identifier(config.user)
        ),
    )
    try:
        with pytest.raises(GraphDBError) as caught:
            instance.get_current_memory_size(user_name="A")
        assert caught.value.__cause__.pgcode == "42501"
        assert instance.current_memory_size == {"WorkingMemory": 2}
    finally:
        support._query(
            admin,
            sql.SQL("GRANT SELECT ON {} TO {}").format(
                sql.SQL(support.TABLE), sql.Identifier(config.user)
            ),
        )
    assert stored(db) == before
