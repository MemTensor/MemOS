import uuid

from unittest.mock import MagicMock

import pytest

from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.types import NLIResult
from memos.graph_dbs.base import BaseGraphDB
from memos.memories.textual.item import (
    ArchivedTextualMemory,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.memories.textual.tree_text_memory.organize.history_manager import (
    MemoryHistoryManager,
    _rebuild_fast_node_history,
)


@pytest.fixture
def mock_nli_client():
    client = MagicMock(spec=NLIClient)
    return client


@pytest.fixture
def mock_graph_db():
    return MagicMock(spec=BaseGraphDB)


@pytest.fixture
def history_manager(mock_nli_client, mock_graph_db):
    return MemoryHistoryManager(nli_client=mock_nli_client, graph_db=mock_graph_db)


def test_truncation(history_manager, mock_nli_client):
    # Setup
    new_item = TextualMemoryItem(memory="Test")
    long_memory = "A" * 300
    related_item = TextualMemoryItem(memory=long_memory)

    mock_nli_client.compare_one_to_many.return_value = [NLIResult.DUPLICATE]

    # Action
    history_manager.resolve_history_via_nli(new_item, [related_item])

    # Assert
    assert "possibly duplicate memories" in new_item.memory
    assert "..." in new_item.memory  # Should be truncated
    assert len(new_item.memory) < 1000  # Ensure reasonable length


def test_empty_related_items(history_manager, mock_nli_client):
    new_item = TextualMemoryItem(memory="Test")
    history_manager.resolve_history_via_nli(new_item, [])

    mock_nli_client.compare_one_to_many.assert_not_called()
    assert new_item.metadata.history is None or len(new_item.metadata.history) == 0


def test_mark_memory_status(history_manager, mock_graph_db):
    # Setup
    id1 = uuid.uuid4().hex
    id2 = uuid.uuid4().hex
    id3 = uuid.uuid4().hex
    memory_ids = [id1, id2, id3]
    status = "resolving"

    # Action
    history_manager.mark_memory_status(memory_ids, status, user_name="u1")

    # Assert
    assert mock_graph_db.update_node.call_count == 3

    # Verify we called it correctly
    mock_graph_db.update_node.assert_any_call(id=id1, fields={"status": status}, user_name="u1")
    mock_graph_db.update_node.assert_any_call(id=id2, fields={"status": status}, user_name="u1")
    mock_graph_db.update_node.assert_any_call(id=id3, fields={"status": status}, user_name="u1")


def test_format_async_update_prompt(history_manager):
    # Setup
    # Create history items
    h1 = ArchivedTextualMemory(
        version=1, archived_memory_id="101", memory="Duplicate content", update_type="duplicate"
    )
    h2 = ArchivedTextualMemory(
        version=1, archived_memory_id="201", memory="Conflict content", update_type="conflict"
    )
    h3 = ArchivedTextualMemory(
        version=1, archived_memory_id="301", memory="Unrelated content", update_type="unrelated"
    )

    item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(history=[h1, h2, h3]),
    )

    # Execute
    prompt = history_manager.format_prompt(item)

    # Verify
    assert "[ID:101]" in prompt
    assert "Duplicate content" in prompt
    assert "[ID:201]" in prompt
    assert "Conflict content" in prompt
    assert "[ID:301]" in prompt
    assert "Unrelated content" in prompt
    assert "New user input" in prompt

    # Check that placeholders are gone (basic check)
    assert "${duplicate_candidates}" not in prompt
    assert "${conflict_candidates}" not in prompt


def test_apply_llm_memory_updates_new_node(history_manager, mock_graph_db):
    llm_response = {
        "memory list": [
            {
                "key": "New Memory",
                "memory_type": "LongTermMemory",
                "value": "New Content",
                "tags": ["tag1"],
                "source_candidate_ids": [],
                "conflicted_candidate_ids": [],
                "history_segments": [],
            }
        ],
        "restored_memories": [],
        "summary": "Summary",
    }

    source_item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(history=[]),
    )
    updated, new_items = history_manager.apply_llm_memory_updates(
        llm_response, source_item=source_item, user_name="u1"
    )

    assert len(updated) == 0
    assert len(new_items) == 1
    new_item = new_items[0]
    assert new_item.memory == "New Content"
    assert new_item.metadata.tags == ["tag1"]
    assert new_item.metadata.history == []
    mock_graph_db.add_node.assert_not_called()


def test_apply_llm_memory_updates_update_existing(history_manager, mock_graph_db):
    # Setup existing node
    existing_id = uuid.uuid4().hex
    existing_node = {
        "id": existing_id,
        "memory": "Old Content",
        "metadata": {
            "version": 1,
            "created_at": "2023-01-01",
            "tags": ["old"],
            "status": "resolving",
            "embedding": [],
            "memory_type": "LongTermMemory",
        },
    }
    mock_graph_db.get_node.return_value = existing_node
    mock_graph_db.get_nodes.return_value = [existing_node]

    llm_response = {
        "memory list": [
            {
                "key": "Updated Memory",
                "memory_type": "LongTermMemory",
                "value": "Updated Content",
                "tags": ["new"],
                "source_candidate_ids": [existing_id],
                "conflicted_candidate_ids": [],
                "history_segments": [],
            }
        ],
        "restored_memories": [],
        "summary": "Summary",
    }

    source_item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(
            history=[
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=existing_id,
                    memory="Old Content",
                    update_type="duplicate",
                )
            ]
        ),
    )
    updated, new_items = history_manager.apply_llm_memory_updates(
        llm_response, source_item=source_item, user_name="u1"
    )

    assert len(updated) == 1
    assert len(new_items) == 0
    updated_item = updated[0]
    assert updated_item.id == existing_id
    assert updated_item.memory == "Updated Content"
    assert updated_item.metadata.version == 2
    assert updated_item.metadata.tags == ["new"]
    assert len(updated_item.metadata.history) == 1

    history_entry = updated_item.metadata.history[0]
    assert history_entry.archived_memory_id != existing_id
    assert history_entry.archived_memory_id is not None
    assert history_entry.memory == "Old Content"
    assert history_entry.update_type == "duplicate"

    mock_graph_db.add_node.assert_called_once()
    mock_graph_db.update_node.assert_called_once()
    args, kwargs = mock_graph_db.update_node.call_args
    assert kwargs["id"] == existing_id
    assert kwargs["fields"]["memory"] == "Updated Content"
    assert kwargs["fields"]["version"] == 2


def test_apply_llm_memory_updates_restored(history_manager, mock_graph_db):
    source_id = uuid.uuid4().hex
    restored_item = TextualMemoryItem(
        memory="Restored Content",
        metadata=TreeNodeTextualMemoryMetadata(history=[]),
    )
    history_manager._handle_restored_memories = MagicMock(return_value=[restored_item])
    llm_response = {
        "memory list": [],
        "restored_memories": [
            {"source_candidate_id": source_id, "value": "Restored Content", "tags": ["restored"]}
        ],
        "summary": "Summary",
    }

    source_item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(
            history=[
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=source_id,
                    memory="Old Content",
                    update_type="conflict",
                )
            ]
        ),
    )
    updated, new_items = history_manager.apply_llm_memory_updates(
        llm_response, source_item=source_item, user_name="u1"
    )

    assert len(updated) == 0
    assert len(new_items) == 1
    assert new_items[0] == restored_item
    history_manager._handle_restored_memories.assert_called_once_with(
        llm_response["restored_memories"], source_item
    )
    mock_graph_db.add_node.assert_not_called()


def test_apply_llm_memory_updates_unrelated(history_manager, mock_graph_db):
    id1 = uuid.uuid4().hex
    id2 = uuid.uuid4().hex
    llm_response = {"memory list": [], "restored_memories": [], "summary": "Summary"}

    source_item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(
            history=[
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=id1,
                    memory="M1",
                    update_type="unrelated",
                ),
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=id2,
                    memory="M2",
                    update_type="unrelated",
                ),
            ]
        ),
    )
    updated, new_items = history_manager.apply_llm_memory_updates(
        llm_response, source_item=source_item, user_name="u1"
    )

    assert len(updated) == 0
    assert len(new_items) == 0

    # Check that update_node was called to set status="activated"
    # mark_memory_status calls update_node for each item
    assert mock_graph_db.update_node.call_count == 2

    # We can inspect calls
    calls = mock_graph_db.update_node.call_args_list
    ids = sorted([c.kwargs["id"] for c in calls])
    assert ids == sorted([id1, id2])
    for c in calls:
        assert c.kwargs["fields"]["status"] == "activated"


def test_apply_llm_memory_updates_conflict_and_merge(history_manager, mock_graph_db):
    # Setup existing node (primary)
    primary_id = uuid.uuid4().hex
    secondary_id = uuid.uuid4().hex
    existing_node = {
        "id": primary_id,
        "memory": "Old Content",
        "metadata": {"version": 1, "embedding": [], "memory_type": "LongTermMemory"},
    }
    mock_graph_db.get_node.return_value = existing_node
    mock_graph_db.get_nodes.return_value = [
        existing_node,
        {
            "id": secondary_id,
            "memory": "Secondary",
            "metadata": {"version": 1, "embedding": [], "memory_type": "LongTermMemory"},
        },
    ]

    llm_response = {
        "memory list": [
            {
                "key": "Conflict Resolved",
                "memory_type": "LongTermMemory",
                "value": "New Content",
                "tags": [],
                "source_candidate_ids": [],
                "conflicted_candidate_ids": [primary_id, secondary_id],
                "history_segments": [],
            }
        ],
        "restored_memories": [],
        "summary": "Summary",
    }

    source_item = TextualMemoryItem(
        memory="New user input",
        metadata=TreeNodeTextualMemoryMetadata(
            history=[
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=primary_id,
                    memory="Old Content",
                    update_type="conflict",
                ),
                ArchivedTextualMemory(
                    version=1,
                    archived_memory_id=secondary_id,
                    memory="Secondary",
                    update_type="conflict",
                ),
            ]
        ),
    )
    updated, new_items = history_manager.apply_llm_memory_updates(
        llm_response, source_item=source_item, user_name="u1"
    )

    assert len(updated) == 1
    assert len(new_items) == 0
    updated_item = updated[0]
    assert updated_item.id == primary_id
    assert updated_item.metadata.history[0].update_type == "conflict"

    # Verify primary update
    # The mock_graph_db.update_node is called for primary (update) AND secondary (delete)

    # Find call for primary
    primary_update_calls = [
        c
        for c in mock_graph_db.update_node.call_args_list
        if c.kwargs["id"] == primary_id and "memory" in c.kwargs.get("fields", {})
    ]
    assert len(primary_update_calls) >= 1
    assert primary_update_calls[0].kwargs["fields"]["memory"] == "New Content"

    # Find call for secondary
    secondary_update_calls = [
        c for c in mock_graph_db.update_node.call_args_list if c.kwargs["id"] == secondary_id
    ]
    assert len(secondary_update_calls) >= 1
    last_secondary_update = secondary_update_calls[-1]
    assert last_secondary_update.kwargs["fields"]["status"] == "archived"
    assert last_secondary_update.kwargs["fields"]["evolve_to"] == [primary_id]


def test_rebuild_fast_node_history_dedup_and_replace():
    h1 = ArchivedTextualMemory(
        version=1, archived_memory_id="a", memory="m1", update_type="duplicate"
    )
    h2 = ArchivedTextualMemory(
        version=1, archived_memory_id="b", memory="m2", update_type="conflict"
    )
    h3 = ArchivedTextualMemory(
        version=2, archived_memory_id="a", memory="m3", update_type="duplicate"
    )
    item = TextualMemoryItem(
        memory="x", metadata=TreeNodeTextualMemoryMetadata(history=[h1, h2, h3])
    )

    r1 = ArchivedTextualMemory(
        version=2, archived_memory_id="b", memory="m4", update_type="conflict"
    )
    r2 = ArchivedTextualMemory(
        version=1, archived_memory_id="c", memory="m5", update_type="duplicate"
    )

    _rebuild_fast_node_history(item, {1: [r1, r2]})

    by_id = {h.archived_memory_id: h for h in item.metadata.history}
    assert set(by_id.keys()) == {"a", "b", "c"}
    assert by_id["a"].version == 2
    assert by_id["b"].version == 2


def test_check_and_fetch_replacements_deleted(history_manager, mock_graph_db):
    fast_id = uuid.uuid4().hex
    history_item = ArchivedTextualMemory(
        version=1, archived_memory_id=fast_id, memory="fast", update_type="conflict", is_fast=True
    )
    item = TextualMemoryItem(
        memory="x", metadata=TreeNodeTextualMemoryMetadata(history=[history_item])
    )
    mock_graph_db.get_nodes.return_value = [
        {"id": fast_id, "metadata": {"status": "deleted", "evolve_to": ["n1", "n2"]}}
    ]

    replacement_item = ArchivedTextualMemory(
        version=1, archived_memory_id="n1", memory="r1", update_type="conflict"
    )
    history_manager._fetch_evolved_nodes = MagicMock(return_value=[replacement_item])

    replacements = history_manager._check_and_fetch_replacements(item, [0])

    assert 0 in replacements
    assert replacements[0][0].archived_memory_id == "n1"
    history_manager._fetch_evolved_nodes.assert_called_once_with(["n1", "n2"], "conflict")


def test_fetch_evolved_nodes_returns_archives(history_manager, mock_graph_db):
    mock_graph_db.get_nodes.return_value = [
        {
            "id": "x1",
            "memory": "m1",
            "metadata": {"version": 2, "is_fast": False, "created_at": "2024-01-01"},
        },
        {
            "id": "x2",
            "memory": "m2",
            "metadata": {"version": 1, "is_fast": True, "created_at": "2024-01-02"},
        },
    ]

    results = history_manager._fetch_evolved_nodes(["x1", "x2"], "duplicate")

    assert len(results) == 2
    ids = sorted([r.archived_memory_id for r in results])
    assert ids == ["x1", "x2"]
    assert all(r.update_type == "duplicate" for r in results)


def test_wait_and_update_fast_history_rebuilds(history_manager):
    fast_id = uuid.uuid4().hex
    fast_item = ArchivedTextualMemory(
        version=1, archived_memory_id=fast_id, memory="fast", update_type="duplicate", is_fast=True
    )
    other_item = ArchivedTextualMemory(
        version=1, archived_memory_id="k1", memory="keep", update_type="unrelated", is_fast=False
    )
    item = TextualMemoryItem(
        memory="x", metadata=TreeNodeTextualMemoryMetadata(history=[fast_item, other_item])
    )

    replacement = ArchivedTextualMemory(
        version=2, archived_memory_id="n1", memory="new", update_type="duplicate", is_fast=False
    )
    history_manager._check_and_fetch_replacements = MagicMock(return_value={0: [replacement]})

    history_manager.wait_and_update_fast_history(item, timeout_sec=1)

    ids = [h.archived_memory_id for h in item.metadata.history]
    assert "n1" in ids
    assert fast_id not in ids
    history_manager._check_and_fetch_replacements.assert_called_once()


def test_update_existing_memory_cas_merge_with_llm(mock_graph_db):
    llm = MagicMock()
    llm.generate.return_value = "Merged Content"
    manager = MemoryHistoryManager(
        nli_client=MagicMock(spec=NLIClient), graph_db=mock_graph_db, llm=llm
    )

    existing_id = uuid.uuid4().hex
    mock_graph_db.get_node.return_value = {
        "id": existing_id,
        "memory": "Old Content",
        "metadata": {"version": 2, "embedding": [], "memory_type": "LongTermMemory"},
    }
    mock_graph_db.get_nodes.return_value = [
        {
            "id": existing_id,
            "memory": "Old Content",
            "metadata": {"version": 2, "embedding": [], "memory_type": "LongTermMemory"},
        }
    ]

    mem_data = {
        "key": "k",
        "value": "Proposed",
        "tags": ["t1"],
        "source_candidate_ids": [existing_id],
        "conflicted_candidate_ids": [],
    }

    updated, new_item = manager._update_existing_memory(
        mem_data,
        [existing_id],
        [existing_id],
        {existing_id: 1},
        user_name="u1",
        fast_item=TextualMemoryItem(
            memory="New user input", metadata=TreeNodeTextualMemoryMetadata()
        ),
    )

    assert updated.memory == "Merged Content"
    assert updated.metadata.version == 3
    assert new_item is None
    mock_graph_db.update_node.assert_called_once()


def test_update_existing_memory_marks_working_binding_deleted(history_manager, mock_graph_db):
    history_manager.mark_memory_status = MagicMock()
    primary_id = uuid.uuid4().hex
    working_binding = uuid.uuid4().hex
    mock_graph_db.get_node.return_value = {
        "id": primary_id,
        "memory": "Old Content",
        "metadata": {"version": 1, "working_binding": working_binding, "embedding": []},
    }
    mock_graph_db.get_nodes.return_value = [
        {
            "id": primary_id,
            "memory": "Old Content",
            "metadata": {"version": 1, "working_binding": working_binding, "embedding": []},
        }
    ]
    mem_data = {
        "key": "k",
        "value": "Updated",
        "tags": [],
        "source_candidate_ids": [primary_id],
        "conflicted_candidate_ids": [],
    }

    updated, new_item = history_manager._update_existing_memory(
        mem_data,
        [primary_id],
        [primary_id],
        {primary_id: 1},
        user_name="u1",
        fast_item=TextualMemoryItem(
            memory="New user input", metadata=TreeNodeTextualMemoryMetadata()
        ),
    )

    assert updated is not None
    assert new_item is None
    history_manager.mark_memory_status.assert_called_once_with(
        [str(working_binding)], "deleted", user_name="u1"
    )


def test_update_existing_memory_no_mark_when_working_binding_matches(
    history_manager, mock_graph_db
):
    history_manager.mark_memory_status = MagicMock()
    primary_id = uuid.uuid4().hex
    mock_graph_db.get_node.return_value = {
        "id": primary_id,
        "memory": "Old Content",
        "metadata": {"version": 1, "working_binding": primary_id, "embedding": []},
    }
    mock_graph_db.get_nodes.return_value = [
        {
            "id": primary_id,
            "memory": "Old Content",
            "metadata": {"version": 1, "working_binding": primary_id, "embedding": []},
        }
    ]
    mem_data = {
        "key": "k",
        "value": "Updated",
        "tags": [],
        "source_candidate_ids": [primary_id],
        "conflicted_candidate_ids": [],
    }

    updated, new_item = history_manager._update_existing_memory(
        mem_data,
        [primary_id],
        [primary_id],
        {primary_id: 1},
        user_name="u1",
        fast_item=TextualMemoryItem(
            memory="New user input", metadata=TreeNodeTextualMemoryMetadata()
        ),
    )

    assert updated is not None
    assert new_item is None


def test_update_from_feedback_returns_persistence_payload_without_side_effects(
    history_manager, mock_graph_db
):
    history_manager.mark_memory_status = MagicMock()
    memory_id = str(uuid.uuid4())
    old_item = TextualMemoryItem(
        id=memory_id,
        memory="Old Content",
        metadata=TreeNodeTextualMemoryMetadata(
            version=2,
            memory_type="LongTermMemory",
            embedding=[0.1, 0.2],
            sources=[{"type": "chat", "content": "old source"}],
            history=[],
        ),
    )
    new_item = TextualMemoryItem(
        memory="Updated Content",
        metadata=TreeNodeTextualMemoryMetadata(
            tags=["fresh"],
            key="topic",
            background="new background",
            embedding=[0.3, 0.4],
            sources=[{"type": "feedback", "content": "new feedback source"}],
            memory_type="LongTermMemory",
        ),
    )

    current_item, archived_item, archived_metadata, update_fields = (
        history_manager.update_from_feedback(
            old_item=old_item,
            new_item=new_item,
            user_name="u1",
        )
    )

    assert current_item.id == memory_id
    assert current_item.memory == "Updated Content"
    assert archived_item.memory == "Old Content"
    assert current_item.metadata.sources[0].content == "new feedback source"
    assert current_item.metadata.sources[0].type == "feedback"
    assert current_item.metadata.sources[1].content == "old source"
    assert archived_item.metadata.sources[0].content == "old source"
    assert archived_metadata["embedding"] == [0.1, 0.2]
    assert update_fields["memory"] == "Updated Content"
    assert update_fields["covered_history"] == memory_id
    assert update_fields["embedding"] == [0.3, 0.4]
    mock_graph_db.get_node.assert_not_called()
    mock_graph_db.add_node.assert_not_called()
    mock_graph_db.update_node.assert_not_called()
    history_manager.mark_memory_status.assert_not_called()


def test_update_existing_memory_node_missing(history_manager, mock_graph_db):
    mock_graph_db.get_node.return_value = None
    mock_graph_db.get_nodes.return_value = []
    mem_data = {"value": "v", "tags": [], "key": "k"}

    updated, new_item = history_manager._update_existing_memory(
        mem_data,
        ["missing"],
        [],
        {},
        user_name="u1",
        fast_item=TextualMemoryItem(
            memory="New user input", metadata=TreeNodeTextualMemoryMetadata()
        ),
    )

    assert updated is None
    assert new_item is not None
    assert new_item.memory == "v"
    mock_graph_db.update_node.assert_not_called()


def test_update_node_with_history():
    item = TextualMemoryItem(
        memory="Old Content",
        metadata=TreeNodeTextualMemoryMetadata(
            version=2,
            tags=["old"],
            key="k1",
            history=[],
        ),
    )

    updated, archived = MemoryHistoryManager.update_node_with_history(
        item,
        "New Content",
        "conflict",
    )

    assert updated.memory == "New Content"
    assert updated.metadata.version == 3
    assert updated.metadata.tags == ["old"]
    assert updated.metadata.key == "k1"
    assert len(updated.metadata.history) == 1
    history_entry = updated.metadata.history[0]
    assert history_entry.memory == "Old Content"
    assert history_entry.update_type == "conflict"
    assert history_entry.archived_memory_id == archived.id
    assert archived.metadata.status == "archived"
    assert archived.metadata.evolve_to == [updated.id]


def test_merge_conflicting_memory_llm_error(mock_graph_db):
    llm = MagicMock()
    llm.generate.side_effect = Exception("fail")
    manager = MemoryHistoryManager(
        nli_client=MagicMock(spec=NLIClient), graph_db=mock_graph_db, llm=llm
    )

    merged = manager._merge_conflicting_memory("Latest", "Proposed")

    assert "System Merge Fallback" in merged
    assert "Latest" in merged
    assert "Proposed" in merged
