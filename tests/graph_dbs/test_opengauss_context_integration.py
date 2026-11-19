"""Production one-hop context over real AGE relations."""

import os

import pytest

from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def test_context_is_one_hop_including_branch_self_loop_and_cycle(stores, database):
    db = stores()
    for key in ["a", "b", "c", "d", "isolated"]:
        db.add_node(key, key, {"status": "deleted"})
    db.add_node("b", "B", {}, user_name="B")
    for source, target in [("a", "b"), ("b", "c"), ("a", "d"), ("d", "a"), ("a", "a")]:
        db.add_edge(source, target, "FOLLOWS")
    db.add_edge("a", "c", "PARENT")
    admin, _ = database
    _query(
        admin,
        """SELECT * FROM ag_catalog.cypher('memos_graph', $$MATCH (a:Memory {id:'a',user_name:'A'}),(b:Memory {id:'b',user_name:'B'}) CREATE (a)-[:FOLLOWS]->(b)$$) AS (r agtype)""",
    )
    assert db.get_context_chain("absent") == []
    assert db.get_context_chain("isolated") == []
    assert db.get_context_chain("a") == ["a", "b", "d"]
    assert db.get_context_chain("b") == ["c"]
    assert db.get_context_chain("a", "PARENT") == ["c"]
    assert db.get_context_chain("a", "ANY") == ["a", "b", "c", "d"]
    assert db.get_context_chain("b", user_name="B") == []
    assert db.export_graph(status=[])["total_edges"] == 6
