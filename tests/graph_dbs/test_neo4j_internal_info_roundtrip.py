"""Legacy info decoding shares the existing strict metadata validation boundary."""

import json

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from pydantic import ValidationError

from memos.graph_dbs.neo4j import (
    Neo4jGraphDB,
    _flatten_info_fields,
    _sanitize_neo4j_metadata,
)
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from memos.memories.textual.item import TextualMemoryItem


@pytest.fixture(params=["neo4j", "community", "community_batch"])
def parse_nodes(request):
    cls = Neo4jGraphDB if request.param == "neo4j" else Neo4jCommunityGraphDB
    db = cls.__new__(cls)
    if isinstance(db, Neo4jCommunityGraphDB):
        db.vec_db = MagicMock()
        db.vec_db.get_by_id.return_value = None
        db.vec_db.get_by_ids.return_value = []
    if request.param == "community_batch":
        return db._parse_nodes

    def parse(nodes):
        return [db._parse_node(node) for node in nodes]

    return parse


def make_node():
    return {
        "id": str(uuid4()),
        "memory": "Synthetic legacy memory",
        "memory_type": "LongTermMemory",
        "internal_info": json.dumps({"chunk_index": 0}),
        "legacy_flat_key": "preserved",
    }


@pytest.mark.parametrize(
    ("stored_info", "expected"),
    [
        (None, None),
        ({}, {}),
        ({"nested": {"values": [True, None]}}, {"nested": {"values": [True, None]}}),
        ("{}", {}),
        (
            '  {"nested": {"text": "历史数据", "values": [true, null]}}\n',
            {"nested": {"text": "历史数据", "values": [True, None]}},
        ),
    ],
)
def test_legacy_info_validates_on_all_graph_read_paths(parse_nodes, stored_info, expected):
    node = make_node()
    node["info"] = stored_info
    parsed = parse_nodes([node])[0]

    item = TextualMemoryItem.from_dict(parsed)

    assert item.id == node["id"]
    assert item.memory == node["memory"]
    assert item.metadata.info == expected
    assert item.metadata.internal_info == {"chunk_index": 0}
    assert item.metadata.legacy_flat_key == "preserved"
    assert node["info"] == stored_info


@pytest.mark.parametrize("field", ["internal_info", "info"])
@pytest.mark.parametrize("value", ["{not json}", "plain text", "[]", "null", "1", '""'])
def test_corrupt_dict_metadata_is_rejected_without_dropping_it(parse_nodes, field, value):
    node = make_node()
    node[field] = value
    parsed = parse_nodes([node])[0]

    assert parsed["metadata"][field] == value
    with pytest.raises(ValidationError):
        TextualMemoryItem.from_dict(parsed)


def test_missing_info_and_modern_flattened_data_remain_readable(parse_nodes):
    node = make_node()
    node.update(_sanitize_neo4j_metadata(_flatten_info_fields({"info": {"client_key": "value"}})))

    parsed = parse_nodes([node])[0]
    item = TextualMemoryItem.from_dict(parsed)

    assert "info" not in parsed["metadata"]
    assert item.metadata.info is None
    assert item.metadata.client_key == "value"


def test_community_batch_preserves_embedding_and_info_alignment():
    db = Neo4jCommunityGraphDB.__new__(Neo4jCommunityGraphDB)
    db.vec_db = MagicMock()
    nodes = [make_node(), make_node()]
    for index, node in enumerate(nodes):
        node["info"] = json.dumps({"index": index})
    db.vec_db.get_by_ids.return_value = [
        SimpleNamespace(id=nodes[1]["id"], vector=[0.2]),
        SimpleNamespace(id=nodes[0]["id"], vector=[0.1]),
    ]

    items = [TextualMemoryItem.from_dict(node) for node in db._parse_nodes(nodes)]

    assert [item.metadata.info for item in items] == [{"index": 0}, {"index": 1}]
    assert [item.metadata.embedding for item in items] == [[0.1], [0.2]]
