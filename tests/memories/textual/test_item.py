"""Regression tests for JSON-encoded internal metadata read from graph storage."""

import copy
import json
import uuid

import pytest

from pydantic import ValidationError

from memos.memories.textual.item import (
    PreferenceTextualMemoryMetadata,
    SearchedTreeNodeTextualMemoryMetadata,
    TextualMemoryItem,
    TextualMemoryMetadata,
    TreeNodeTextualMemoryMetadata,
)


@pytest.mark.parametrize(
    "metadata_cls",
    [
        TextualMemoryMetadata,
        TreeNodeTextualMemoryMetadata,
        SearchedTreeNodeTextualMemoryMetadata,
        PreferenceTextualMemoryMetadata,
    ],
)
def test_internal_info_decodes_json_object(metadata_cls):
    value = {"ingest_batch_id": "test-batch", "nested": {"chunk_index": 0, "values": [True, None]}}

    metadata = metadata_cls(internal_info=json.dumps(value))

    assert metadata.internal_info == value
    assert metadata.model_dump()["internal_info"] == value


@pytest.mark.parametrize("value", [None, {}, {"ingest_batch_id": "test-batch", "nested": [1, 2]}])
def test_internal_info_preserves_existing_values(value):
    original = copy.deepcopy(value)

    metadata = TextualMemoryMetadata(internal_info=value)

    assert metadata.internal_info == original
    assert value == original


@pytest.mark.parametrize(
    "value",
    ["{", "not-json", "[]", "null", "1", "true", '"text"', json.dumps('{"batch": "test"}')],
)
def test_internal_info_rejects_malformed_json_and_encoded_non_objects(value):
    with pytest.raises(ValidationError):
        TextualMemoryMetadata(internal_info=value)


@pytest.mark.parametrize("value", [[], [["batch", "test"]], 1, False])
def test_internal_info_preserves_rejection_of_invalid_types(value):
    with pytest.raises(ValidationError):
        TextualMemoryMetadata(internal_info=value)


def test_search_item_from_dict_decodes_internal_info_without_changing_other_fields():
    value = {"ingest_batch_id": "test-batch", "chunk_index": 0, "chunk_total": 2}
    record = {
        "id": str(uuid.uuid4()),
        "memory": "Synthetic memory for a graph storage round trip.",
        "metadata": {
            "memory_type": "LongTermMemory",
            "internal_info": json.dumps(value),
            "relativity": 0.75,
            "sources": [{"type": "chat", "role": "user", "content": "Synthetic source."}],
            "session_id": "test-session",
        },
    }
    original = copy.deepcopy(record)

    item = TextualMemoryItem.from_dict(record)

    assert item.metadata.internal_info == value
    assert item.id == record["id"]
    assert item.memory == record["memory"]
    assert item.metadata.sources[0].content == "Synthetic source."
    assert item.metadata.session_id == "test-session"
    assert item.metadata.relativity == 0.75
    assert record == original

    # Graph storage serializes dictionaries as JSON strings again on the next write.
    stored = item.to_dict()
    stored["metadata"]["internal_info"] = json.dumps(stored["metadata"]["internal_info"])
    assert TextualMemoryItem.from_dict(stored).to_dict() == item.to_dict()
