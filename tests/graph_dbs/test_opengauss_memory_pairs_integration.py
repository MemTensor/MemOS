"""Working and graph memory creation uses one real openGauss transaction."""

import os
import uuid

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("kind", ["LongTermMemory", "UserMemory"])
def test_real_pairs_retry_scope_and_indexes(stores, batch, kind):
    db = stores()
    manager = MemoryManager(db, Mock(), Mock())
    item = TextualMemoryItem(
        memory="pairmarker", metadata={"memory_type": kind, "embedding": [1, 0, 0]}
    )
    working = str(uuid.uuid5(uuid.NAMESPACE_URL, "memos:working:" + item.id))
    db.add_node(item.id, "other cube", {"memory_type": kind}, user_name="B")
    for _ in range(2):
        assert manager.add([item], "A", mode="async", use_batch=batch) == [item.id]
        nodes = db.export_graph(user_name="A", status=[], include_embedding=True)["nodes"]
        assert {n["id"] for n in nodes} == {item.id, working}
        final = db.get_node(item.id, user_name="A", include_embedding=True)
        temporary = db.get_node(working, user_name="A", include_embedding=True)
        assert final["metadata"]["memory_type"] == kind
        assert final["metadata"]["working_binding"] == working
        assert temporary["metadata"]["memory_type"] == "WorkingMemory"
        assert not temporary["metadata"].get("working_binding")
        for node in [final, temporary]:
            assert node["memory"] == "pairmarker" and node["metadata"]["embedding"] == [1, 0, 0]
        assert {n["id"] for n in db.search_by_embedding([1, 0, 0], scope=None)} == {
            item.id,
            working,
        }
        assert {n["id"] for n in db.search_by_fulltext(["pairmarker"], scope=None)} == {
            item.id,
            working,
        }
    assert db.get_node(item.id, user_name="B")["memory"] == "other cube"


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("existing", [False, True])
def test_second_node_failure_rolls_back_pair_and_indexes(stores, database, batch, existing):
    db = stores()
    manager = MemoryManager(db, Mock(), Mock())
    manager.is_reorganize = True
    manager.reorganizer = Mock()
    item = TextualMemoryItem(
        memory="beforemarker", metadata={"memory_type": "LongTermMemory", "embedding": [1, 0, 0]}
    )
    if existing:
        manager.add([item], "A", mode="async", use_batch=batch)
    before = db.export_graph(status=[], include_embedding=True)
    manager.reorganizer.reset_mock()
    item.memory = "rejectpairmarker"
    item.metadata.embedding = [0, 1, 0]
    admin, _ = database
    _query(
        admin,
        """ALTER TABLE memos_graph."Memory" ADD CONSTRAINT reject_pair
        CHECK (memory <> 'rejectpairmarker' OR business_id <> %s)""",
        (item.id,),
    )
    try:
        with pytest.raises(GraphDBError):
            manager.add([item], "A", mode="async", use_batch=batch)
    finally:
        _query(admin, 'ALTER TABLE memos_graph."Memory" DROP CONSTRAINT reject_pair')
    assert db.export_graph(status=[], include_embedding=True) == before
    assert db.search_by_fulltext(["rejectpairmarker"], scope=None) == []
    manager.reorganizer.add_message.assert_not_called()
    assert manager.add([item], "A", mode="async", use_batch=batch) == [item.id]
    nodes = db.export_graph(status=[], include_embedding=True)["nodes"]
    assert len(nodes) == 2 and all(n["memory"] == "rejectpairmarker" for n in nodes)


@pytest.mark.parametrize("batch", [False, True])
def test_concurrent_rewrite_keeps_pair_consistent(stores, batch):
    db = stores()
    manager = MemoryManager(db, Mock(), Mock())
    primary = str(uuid.uuid4())
    barrier = Barrier(2)

    def write(text):
        item = TextualMemoryItem(
            id=primary, memory=text, metadata={"memory_type": "LongTermMemory"}
        )
        barrier.wait(timeout=5)
        assert manager.add([item], "A", mode="async", use_batch=batch) == [primary]

    with ThreadPoolExecutor(2) as pool:
        list(pool.map(write, ["first", "second"]))
    nodes = db.export_graph(status=[])["nodes"]
    assert len(nodes) == 2
    assert nodes[0]["memory"] == nodes[1]["memory"] in {"first", "second"}
    primary_node = next(node for node in nodes if node["id"] == primary)
    assert primary_node["metadata"]["working_binding"] == next(
        node["id"] for node in nodes if node["id"] != primary
    )
