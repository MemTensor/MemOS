from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from memos.memories.textual.item import TextualMemoryItem


@pytest.mark.parametrize("db_cls", [Neo4jGraphDB, Neo4jCommunityGraphDB])
def test_history_update_roundtrips_without_mutating_fields(db_cls):
    db = db_cls.__new__(db_cls)
    db.config = SimpleNamespace(user_name="cube-1", use_multi_db=False)
    db.db_name = "memory"
    db.driver = MagicMock()
    fields = {
        "version": 2,
        "history": [{"version": 1, "memory": "旧记忆", "update_type": "feedback"}],
    }

    db.update_node("memory-1", fields)

    params = db.driver.session.return_value.__enter__.return_value.run.call_args.kwargs
    stored = params["fields"]
    assert isinstance(stored["history"][0], str)
    item = TextualMemoryItem(memory="new", metadata=stored)
    assert item.metadata.history[0].memory == "旧记忆"
    assert item.metadata.history[0].version == 1
    assert item.metadata.version == 2
    assert isinstance(fields["history"][0], dict)
