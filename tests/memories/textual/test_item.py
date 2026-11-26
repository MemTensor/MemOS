"""Regression tests for JSON-encoded internal metadata read from graph storage."""

import copy
import json
import uuid

import pytest

from pydantic import ValidationError

from memos.memories.textual.item import (
    ArchivedTextualMemory,
    PreferenceTextualMemoryMetadata,
    SearchedTreeNodeTextualMemoryMetadata,
    TextualMemoryItem,
    TextualMemoryMetadata,
    TreeNodeTextualMemoryMetadata,
)


@pytest.mark.parametrize("encoded", [False, True])
def test_history_accepts_existing_objects_and_json_entries(encoded):
    entry = {"memory": "old", "version": 3, "update_type": "feedback"}
    history = [json.dumps(entry) if encoded else entry]
    item = TextualMemoryItem(memory="new", metadata={"history": history, "version": 4})
    assert item.metadata.history == [ArchivedTextualMemory(**entry, created_at=None)]
    assert history == [json.dumps(entry) if encoded else entry]


@pytest.mark.parametrize("entry", ["not json", "[]", "null", "42"])
def test_history_quarantines_invalid_entries_without_losing_memory(entry, caplog):
    item = TextualMemoryItem(memory="new", metadata={"history": [entry, {"memory": "valid"}]})
    assert item.memory == "new"
    assert [snapshot.memory for snapshot in item.metadata.history] == ["valid"]
    assert item.metadata.history_quarantine == [entry]
    assert "history" in caplog.text
    restored = TextualMemoryItem.model_validate(item.model_dump())
    assert restored.metadata.history_quarantine == [entry]
    assert restored.metadata.history[0].created_at is None


@pytest.mark.parametrize(
    "metadata_cls",
    [
        TextualMemoryMetadata,
        TreeNodeTextualMemoryMetadata,
        SearchedTreeNodeTextualMemoryMetadata,
        PreferenceTextualMemoryMetadata,
    ],
)
@pytest.mark.parametrize("field", ["internal_info", "info"])
def test_dict_metadata_decodes_json_object(metadata_cls, field):
    value = {"ingest_batch_id": "test-batch", "nested": {"chunk_index": 0, "values": [True, None]}}

    metadata = metadata_cls(**{field: "  " + json.dumps(value) + "\n"})

    assert getattr(metadata, field) == value
    assert metadata.model_dump()[field] == value


@pytest.mark.parametrize("value", [None, {}, {"ingest_batch_id": "test-batch", "nested": [1, 2]}])
@pytest.mark.parametrize("field", ["internal_info", "info"])
def test_dict_metadata_preserves_existing_values(value, field):
    original = copy.deepcopy(value)

    metadata = TextualMemoryMetadata(**{field: value})

    assert getattr(metadata, field) == original
    assert value == original


@pytest.mark.parametrize(
    "value",
    ["{", "not-json", "[]", "null", "1", "true", '"text"', json.dumps('{"batch": "test"}')],
)
@pytest.mark.parametrize("field", ["internal_info", "info"])
def test_dict_metadata_rejects_malformed_json_and_encoded_non_objects(value, field):
    with pytest.raises(ValidationError):
        TextualMemoryMetadata(**{field: value})


@pytest.mark.parametrize("value", [[], [["batch", "test"]], 1, False])
@pytest.mark.parametrize("field", ["internal_info", "info"])
def test_dict_metadata_preserves_rejection_of_invalid_types(value, field):
    with pytest.raises(ValidationError):
        TextualMemoryMetadata(**{field: value})


def test_search_item_from_dict_decodes_internal_info_without_changing_other_fields():
    value = {"ingest_batch_id": "test-batch", "chunk_index": 0, "chunk_total": 2}
    record = {
        "id": str(uuid.uuid4()),
        "memory": "Synthetic memory for a graph storage round trip.",
        "metadata": {
            "memory_type": "LongTermMemory",
            "internal_info": json.dumps(value),
            "info": json.dumps({"client_metadata": True}),
            "relativity": 0.75,
            "sources": [{"type": "chat", "role": "user", "content": "Synthetic source."}],
            "session_id": "test-session",
        },
    }
    original = copy.deepcopy(record)

    item = TextualMemoryItem.from_dict(record)

    assert item.metadata.internal_info == value
    assert item.metadata.info == {"client_metadata": True}
    assert item.id == record["id"]
    assert item.memory == record["memory"]
    assert item.metadata.sources[0].content == "Synthetic source."
    assert item.metadata.session_id == "test-session"
    assert item.metadata.relativity == 0.75
    assert record == original

    # Graph storage serializes dictionaries as JSON strings again on the next write.
    stored = item.to_dict()
    stored["metadata"]["internal_info"] = json.dumps(stored["metadata"]["internal_info"])
    stored["metadata"]["info"] = json.dumps(stored["metadata"]["info"])
    assert TextualMemoryItem.from_dict(stored).to_dict() == item.to_dict()
