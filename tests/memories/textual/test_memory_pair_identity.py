"""Independent identities and one storage operation for each logical memory."""

import uuid

from threading import Event
from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.manager import (
    MemoryManager,
    extract_working_binding_ids,
)


@pytest.fixture
def manager():
    result = MemoryManager(Mock(), Mock(), Mock())
    result.is_reorganize = True
    result.reorganizer = Mock()
    return result


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("kind", ["LongTermMemory", "UserMemory"])
@pytest.mark.parametrize("fast", [False, True])
def test_independent_pair_preserves_input_and_retry_identity(manager, batch, kind, fast):
    old_binding = str(uuid.uuid4())
    item = TextualMemoryItem(
        memory="production pair",
        metadata={
            "memory_type": kind,
            "embedding": [1, 0, 0],
            "tags": ["mode:fast"] if fast else [],
            "background": f"source [working_binding:{old_binding}]",
            "working_binding": old_binding,
            "info": {"agent_id": "app"},
        },
    )
    before = item.model_dump()
    expected_working = str(uuid.uuid5(uuid.NAMESPACE_URL, "memos:working:" + item.id))
    for _ in range(2):
        assert manager.add([item], "A", mode="async", use_batch=batch) == [item.id]
        nodes = manager.graph_store.add_nodes_batch.call_args.args[0]
        assert len(nodes) == 2
        working, final = nodes
        assert working["id"] == expected_working != final["id"] == item.id
        assert working["metadata"]["memory_type"] == "WorkingMemory"
        assert "working_binding" not in working["metadata"]
        assert final["metadata"]["memory_type"] == kind
        assert final["metadata"]["working_binding"] == expected_working
        for node in nodes:
            assert node["memory"] == item.memory
            assert node["metadata"]["embedding"] == [1, 0, 0]
            assert node["metadata"]["info"] == {"agent_id": "app"}
            assert old_binding not in node["metadata"]["background"]
        if fast:
            assert f"[working_binding:{expected_working}]" in final["metadata"]["background"]
        assert manager.graph_store.add_nodes_batch.call_args.kwargs == {"user_name": "A"}
        assert item.model_dump() == before
    manager.graph_store.add_node.assert_not_called()


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize(
    "kind",
    [
        "WorkingMemory",
        "OuterMemory",
        "RawFileMemory",
        "ToolSchemaMemory",
        "ToolTrajectoryMemory",
        "SkillMemory",
        "PreferenceMemory",
        "Context",
    ],
)
def test_single_types_do_not_create_phantom_bindings(manager, batch, kind):
    item = TextualMemoryItem(memory="one", metadata={"memory_type": kind, "tags": ["mode:fast"]})
    graph = kind not in {"WorkingMemory", "OuterMemory", "Context"}
    assert manager.add([item], "A", mode="async", use_batch=batch) == ([item.id] if graph else [])
    if kind == "Context":
        manager.graph_store.add_nodes_batch.assert_not_called()
    else:
        nodes = manager.graph_store.add_nodes_batch.call_args.args[0]
        assert len(nodes) == 1 and nodes[0]["id"] == item.id
        assert nodes[0]["metadata"]["memory_type"] == (kind if graph else "WorkingMemory")
        assert "working_binding" not in nodes[0]["metadata"]


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize(
    "failure", [GraphDBError("storage"), ValueError("invalid"), RuntimeError("driver")]
)
def test_failed_write_is_visible_and_does_not_notify(manager, batch, failure):
    manager.graph_store.add_node.side_effect = failure
    manager.graph_store.add_nodes_batch.side_effect = failure
    with pytest.raises(type(failure)) as caught:
        manager.add(
            [TextualMemoryItem(memory="one", metadata={"memory_type": "LongTermMemory"})],
            "A",
            use_batch=batch,
        )
    assert caught.value is failure
    manager.reorganizer.add_message.assert_not_called()
    manager.graph_store.remove_oldest_memory.assert_not_called()


def test_batch_boundary_never_splits_pair(manager):
    items = [
        TextualMemoryItem(memory=str(i), metadata={"memory_type": "LongTermMemory"})
        for i in range(6)
    ]
    assert manager._add_memories_batch(items, "A", batch_size=5) == [item.id for item in items]
    calls = manager.graph_store.add_nodes_batch.call_args_list
    assert len(calls) == 2
    for call in calls:
        nodes = call.args[0]
        ids = {node["id"] for node in nodes}
        for node in nodes:
            if node["metadata"]["memory_type"] == "LongTermMemory":
                assert node["metadata"]["working_binding"] in ids


def test_parallel_results_follow_input_order(manager):
    first, second = TextualMemoryItem(memory="first"), TextualMemoryItem(memory="second")
    second_done = Event()

    def process(item, owner):
        if item is first:
            assert second_done.wait(3)
        else:
            second_done.set()
        return [item.id]

    manager._process_memory = process
    assert manager._add_memories_parallel([first, second], "A") == [first.id, second.id]


def test_empty_batch_and_invalid_batch_size(manager):
    assert manager.add([], "A", mode="async") == []
    with pytest.raises(ValueError, match="batch_size"):
        manager._add_memories_batch([], "A", batch_size=0)
    manager.graph_store.add_nodes_batch.assert_not_called()


def test_missing_background_and_nontext_legacy_metadata(manager):
    item = TextualMemoryItem(
        memory="one", metadata={"memory_type": "LongTermMemory", "background": None}
    )
    assert manager.add([item], "A", mode="async") == [item.id]
    assert extract_working_binding_ids([{"id": item.id, "metadata": {"background": 3}}]) == set()


@pytest.mark.parametrize("form", ["braced", "hex", "urn"])
def test_legacy_self_binding_preserves_accepted_uuid_spellings(form):
    value = uuid.uuid4()
    primary = {"braced": "{" + str(value) + "}", "hex": value.hex, "urn": value.urn}[form]
    item = TextualMemoryItem(id=primary, memory="legacy", metadata={"working_binding": primary})
    assert extract_working_binding_ids([item]) == set()


@pytest.mark.parametrize("as_dict", [False, True])
@pytest.mark.parametrize("source", ["structured", "legacy", "self", "invalid", "none"])
def test_binding_cleanup_uses_existing_field_and_rejects_self(as_dict, source):
    primary, working, legacy = [str(uuid.uuid4()) for _ in range(3)]
    metadata = {}
    if source == "structured":
        metadata = {"working_binding": working, "background": f"[working_binding:{legacy}]"}
    elif source == "legacy":
        metadata = {"background": f"[working_binding:{working}]"}
    elif source == "self":
        metadata = {"working_binding": primary, "background": f"[working_binding:{primary}]"}
    elif source == "invalid":
        metadata = {"working_binding": "invalid"}
    item = TextualMemoryItem(id=primary, memory="one", metadata=metadata)
    assert extract_working_binding_ids([item.model_dump() if as_dict else item]) == (
        {working} if source in {"structured", "legacy"} else set()
    )
