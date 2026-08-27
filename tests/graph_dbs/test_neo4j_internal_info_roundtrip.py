"""
Regression tests for issue #2288.

`Neo4jCommunityGraphDB` and `Neo4jGraphDB` sanitize every dict-typed
metadata value to a JSON string on write. Historically the read path
only reversed the ``sources`` transform, so ``internal_info`` / ``info``
came back as ``str`` and broke ``TextualMemoryItem`` validation during
recall on any deployment that populates them (document chunking / Dream
enrichment).

These tests pin the symmetric read-path behaviour:

  * ``_deserialize_dict_field`` unit tests (helper contract).
  * ``_parse_node`` regression tests for both ``Neo4jGraphDB`` and
    ``Neo4jCommunityGraphDB``.
  * ``_parse_nodes`` regression test for ``Neo4jCommunityGraphDB``.
  * End-to-end guard: the parsed metadata must pass
    ``TreeNodeTextualMemoryMetadata`` validation.
"""

from __future__ import annotations

import json

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


# ──────────────────────────────────────────────────────────────────────
# Helper unit tests
# ──────────────────────────────────────────────────────────────────────


class TestDeserializeDictField:
    """Contract for ``_deserialize_dict_field`` — see design.md § Helper."""

    def _helper(self):
        from memos.graph_dbs.neo4j import _deserialize_dict_field

        return _deserialize_dict_field

    def test_none_passthrough(self):
        assert self._helper()(None) is None

    def test_dict_passthrough(self):
        payload = {"a": 1, "nested": {"b": 2}}
        assert self._helper()(payload) is payload

    def test_json_object_string_deserialized(self):
        payload = {"a": 1, "nested": {"b": 2}}
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        assert self._helper()(serialized) == payload

    def test_json_array_string_passthrough(self):
        # Not object-shaped; do not touch legacy list-shaped strings.
        assert self._helper()("[1, 2, 3]") == "[1, 2, 3]"

    def test_plain_string_passthrough(self):
        assert self._helper()("plain text") == "plain text"

    def test_malformed_object_string_returns_none(self):
        # Shape looks like an object but is not valid JSON — fall back to
        # None so pydantic ``dict | None`` fields still validate.
        assert self._helper()("{not json}") is None

    def test_number_passthrough(self):
        assert self._helper()(42) == 42


# ──────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def shared_neo4j_db():
    from memos.configs.graph_db import Neo4jGraphDBConfig

    config = Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=False,
        user_name="default_user",
        embedding_dimension=3,
    )
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(config)
        db.driver = mock_driver
        yield db


@pytest.fixture
def community_neo4j_db():
    """Minimal ``Neo4jCommunityGraphDB`` instance — bypass __init__ so we
    do not need to bring up a real neo4j driver or vec_db."""
    with patch("memos.graph_dbs.neo4j_community.Neo4jCommunityGraphDB.__init__", return_value=None):
        from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

        db = Neo4jCommunityGraphDB.__new__(Neo4jCommunityGraphDB)
        db.driver = MagicMock()
        db.db_name = "test_memory_db"
        db.vec_db = MagicMock()
        # get_by_id / get_by_ids used in _parse_node / _parse_nodes.
        db.vec_db.get_by_id.return_value = None
        db.vec_db.get_by_ids.return_value = []
        yield db


# ──────────────────────────────────────────────────────────────────────
# _parse_node regression tests
# ──────────────────────────────────────────────────────────────────────


class TestParseNodeDeserializesDictFields:
    """A JSON-string ``internal_info`` / ``info`` must be returned as
    ``dict`` — the exact failure mode reported in #2288."""

    def _make_node_dict(self, *, internal_info=None, info=None):
        node = {
            "id": "node-1",
            "memory": "hello",
            "memory_type": "LongTermMemory",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "sources": [json.dumps({"type": "chat", "role": "user"})],
        }
        if internal_info is not None:
            node["internal_info"] = internal_info
        if info is not None:
            node["info"] = info
        return node

    def test_neo4j_parse_node_internal_info_string_becomes_dict(self, shared_neo4j_db):
        payload = {"chunk_id": "abc", "score": 0.9}
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)

        result = shared_neo4j_db._parse_node(self._make_node_dict(internal_info=serialized))

        assert result["id"] == "node-1"
        assert result["memory"] == "hello"
        assert isinstance(result["metadata"]["internal_info"], dict)
        assert result["metadata"]["internal_info"] == payload

    def test_neo4j_parse_node_info_string_becomes_dict(self, shared_neo4j_db):
        payload = {"free_form": "value"}
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)

        result = shared_neo4j_db._parse_node(self._make_node_dict(info=serialized))

        assert isinstance(result["metadata"]["info"], dict)
        assert result["metadata"]["info"] == payload

    def test_neo4j_parse_node_preserves_none(self, shared_neo4j_db):
        result = shared_neo4j_db._parse_node(self._make_node_dict())
        # Neither field was in the input; parser must not invent them.
        assert "internal_info" not in result["metadata"]
        assert "info" not in result["metadata"]

    def test_neo4j_parse_node_preserves_dict_passthrough(self, shared_neo4j_db):
        # Some legacy code paths already hand a real dict — must be a
        # no-op, not re-round-tripped through json.
        payload = {"already_dict": True}
        result = shared_neo4j_db._parse_node(self._make_node_dict(internal_info=payload))
        assert result["metadata"]["internal_info"] == payload

    def test_neo4j_parse_node_malformed_json_becomes_none(self, shared_neo4j_db):
        result = shared_neo4j_db._parse_node(self._make_node_dict(internal_info="{not json}"))
        assert result["metadata"]["internal_info"] is None

    def test_community_parse_node_deserializes_internal_info(self, community_neo4j_db):
        payload = {"chunk_id": "abc", "score": 0.9}
        result = community_neo4j_db._parse_node(
            self._make_node_dict(
                internal_info=json.dumps(payload, ensure_ascii=False, sort_keys=True)
            )
        )
        assert isinstance(result["metadata"]["internal_info"], dict)
        assert result["metadata"]["internal_info"] == payload

    def test_community_parse_node_deserializes_info(self, community_neo4j_db):
        payload = {"lookup_key": "v"}
        result = community_neo4j_db._parse_node(
            self._make_node_dict(info=json.dumps(payload, ensure_ascii=False, sort_keys=True))
        )
        assert isinstance(result["metadata"]["info"], dict)
        assert result["metadata"]["info"] == payload


# ──────────────────────────────────────────────────────────────────────
# _parse_nodes regression test (community batch path)
# ──────────────────────────────────────────────────────────────────────


class TestParseNodesBatchDeserializesDictFields:
    def test_batch_preserves_dict_per_node(self, community_neo4j_db):
        payloads = [{"k": i} for i in range(3)]
        raw_nodes = [
            {
                "id": f"node-{i}",
                "memory": f"m{i}",
                "memory_type": "LongTermMemory",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "internal_info": json.dumps(payloads[i], ensure_ascii=False, sort_keys=True),
                "info": json.dumps({"i": i}, ensure_ascii=False, sort_keys=True),
            }
            for i in range(3)
        ]

        results = community_neo4j_db._parse_nodes(raw_nodes)

        assert len(results) == 3
        for i, parsed in enumerate(results):
            assert isinstance(parsed["metadata"]["internal_info"], dict)
            assert parsed["metadata"]["internal_info"] == payloads[i]
            assert isinstance(parsed["metadata"]["info"], dict)
            assert parsed["metadata"]["info"] == {"i": i}


# ──────────────────────────────────────────────────────────────────────
# End-to-end guard: parsed metadata must validate against pydantic
# ──────────────────────────────────────────────────────────────────────


class TestParsedMetadataValidatesAgainstTextualMemoryItem:
    """Close the loop with the failure point in the issue:

    ``TreeNodeTextualMemoryMetadata`` declares ``internal_info: dict | None``
    and ``info: dict | None``. Feeding it a raw string used to raise
    ``ValidationError``; feeding it the parsed dict must succeed."""

    def test_parsed_metadata_passes_pydantic_validation(self, shared_neo4j_db):
        from memos.memories.textual.item import TreeNodeTextualMemoryMetadata

        payload = {"chunk_id": "abc", "score": 0.9}
        parsed = shared_neo4j_db._parse_node(
            {
                "id": "node-1",
                "memory": "hello",
                "memory_type": "LongTermMemory",
                "status": "activated",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "internal_info": json.dumps(payload, ensure_ascii=False, sort_keys=True),
                "info": json.dumps({"k": "v"}, ensure_ascii=False, sort_keys=True),
            }
        )

        # This construct used to raise pydantic ValidationError with the
        # message ``Input should be a valid dictionary [type=dict_type,
        # input_value='{"chunk_id": "abc", ...}', input_type=str]``.
        metadata_obj = TreeNodeTextualMemoryMetadata(**parsed["metadata"])
        assert metadata_obj.internal_info == payload
        assert metadata_obj.info == {"k": "v"}
