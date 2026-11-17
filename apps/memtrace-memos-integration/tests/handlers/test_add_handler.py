"""Memory lineage not already covered by the repository's plugin integration tests."""

from dataclasses import replace
from unittest.mock import Mock

import pytest

from memos_smartcomment.handlers.add_handler import AddHandler


# isort: split
from memos.plugins.hook_context import HookContext


CONTEXT = HookContext(trace_id="trace", user_id="user", cube_ids=("cube",), operation_id="op")


def test_write_matches_unique_ids_and_keeps_unresolved_placeholders() -> None:
    events = []
    AddHandler(events.append).on_text_memory_add_after(
        hook_context=CONTEXT,
        text_memory=None,
        memories=[
            {"id": "a", "memory": "Candidate A"},
            {"id": "b", "memory": "Candidate B"},
            {"id": "duplicate", "memory": "First candidate"},
            {"id": "duplicate", "memory": "Second candidate"},
        ],
        kwargs={},
        result=["b", "missing", "duplicate", "a"],
    )
    (event,) = events
    assert event.metadata["lineage_status"] == "partial"
    assert [(link.source.value, link.target.value) for link in event.links] == [
        ("Candidate B", "Candidate B"),
        ("Candidate A", "Candidate A"),
    ]
    assert [link.target.identity for link in event.links] == ["memory:cube:b", "memory:cube:a"]
    assert [node.identity for node in event.outputs] == [
        f"memory:cube:{memory_id}" for memory_id in ("b", "missing", "duplicate", "a")
    ]
    for node in event.outputs[1:3]:
        assert node.category == "persisted_memory" and node.identity_only
        assert node.value == {"memory_id": node.metadata["memory_id"], "cube_id": "cube"}


def test_enqueue_failure_does_not_escape_write_callback() -> None:
    submit = Mock(side_effect=RuntimeError("Synthetic tracing failure"))
    result = AddHandler(submit).on_text_memory_add_after(
        hook_context=CONTEXT,
        text_memory=None,
        memories=[{"id": "a", "memory": "Candidate A"}],
        kwargs={},
        result=["a"],
    )
    submit.assert_called_once()
    assert result is None  # A tracing observer must not replace the business result.


@pytest.mark.parametrize(
    "grouping,source_ids",
    [("per_input", ["b"]), ("batch", ["a", "b"]), ("unknown", [])],
)
def test_scheduler_refinement_respects_declared_grouping(grouping, source_ids) -> None:
    events = []
    AddHandler(events.append).on_scheduler_memory_operation_after(
        hook_context=replace(CONTEXT, source="scheduler.mem_read.fine_transfer_simple_mem"),
        operation="fine",
        operation_input={
            "memories": [{"id": "a", "memory": "Source A"}, {"id": "b", "memory": "Source B"}],
            "result_grouping": grouping,
        },
        result=[[], [{"id": "enhanced", "memory": "Enhanced memory"}]],
    )
    (event,) = events
    assert [link.source.metadata["memory_id"] for link in event.links] == source_ids
    (output,) = event.outputs
    assert output.category == "enhanced_memory" and output.value == "Enhanced memory"
    assert all(link.target == output for link in event.links)
    assert event.metadata["lineage_status"] == ("resolved" if source_ids else "unresolved")


def test_scheduler_write_and_soft_delete_keep_distinct_memory_roles() -> None:
    events = []
    handler = AddHandler(events.append)
    handler.on_scheduler_memory_operation_after(
        hook_context=replace(CONTEXT, source="scheduler.mem_read.add_enhanced_memories"),
        operation="add",
        operation_input={"memories": [{"id": "enhanced", "memory": "Enhanced memory"}]},
        result=["enhanced"],
    )
    handler.on_scheduler_memory_operation_after(
        hook_context=replace(CONTEXT, source="scheduler.mem_read.remove_memories"),
        operation="soft_delete",
        operation_input={"memory_ids": ["source"], "preserved_memory_ids": ["enhanced"]},
        result=None,
    )
    write, deletion = events
    (link,) = write.links
    assert link.source.category == "enhanced_memory"
    assert link.source.identity == "enhanced_memory:trace:cube:enhanced"
    assert link.target.identity == "memory:cube:enhanced"
    assert link.target.value == "Enhanced memory"
    (link,) = deletion.links
    assert link.category == "memory_deletion"
    assert link.source.identity == "memory:cube:source"
    assert link.target.category == "scheduler_result"
    assert [node.identity for node in deletion.inputs] == ["memory:cube:source"]


def test_scheduler_failed_write_links_input_to_failure_without_persisted_output() -> None:
    events = []
    AddHandler(events.append).on_scheduler_memory_operation_failed(
        hook_context=replace(CONTEXT, source="scheduler.mem_read.add_enhanced_memories"),
        operation="add",
        operation_input={"memories": [{"id": "enhanced", "memory": "Enhanced memory"}]},
        error=ValueError("Synthetic failure"),
    )
    (event,) = events
    (source,), (status,), (link,) = event.inputs, event.outputs, event.links
    assert source.category == "enhanced_memory"
    assert status.category == "scheduler_result" and status.metadata["status"] == "failed"
    assert event.metadata["error_type"] == "ValueError"
    assert (link.source, link.target, link.category) == (
        source,
        status,
        "scheduler_operation_failed",
    )
