"""Explicit graph dependencies and immutable persisted-memory anchors."""

import json

from dataclasses import replace

from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.events import TraceEvent, TraceLink, TraceValue
from memos_smartcomment.recorder import SmartCommentRecorder


def test_only_explicit_links_create_edges() -> None:
    source = TraceValue("Synthetic input", identity="source")
    independent = TraceValue("Synthetic independent output", identity="independent")
    target = TraceValue("Synthetic linked output", identity="target")
    event = TraceEvent(
        operation="synthetic.observe",
        category="synthetic",
        trace_id="synthetic-trace",
        inputs=(source,),
        outputs=(independent,),
    )
    recorder = SmartCommentRecorder(SmartCommentSettings(strict=True), event)
    recorder.record(event)
    data = recorder.export_graph()["data"]
    assert {node["name"] for node in data["nodes"]} == {"source", "independent"}
    assert data["edges"] == []

    recorder.record(
        TraceEvent(
            operation="synthetic.link",
            category="synthetic",
            trace_id=event.trace_id,
            links=(TraceLink(source, target),),
        )
    )
    data = recorder.export_graph()["data"]
    nodes = {node["full_node_id"]: node["name"] for node in data["nodes"]}
    assert set(nodes.values()) == {"source", "independent", "target"}
    assert [
        (nodes[edge["source_full_node_id"]], nodes[edge["target_full_node_id"]])
        for edge in data["edges"]
    ] == [("source", "target")]


def test_restored_memory_reference_is_completed_once_without_changing_edges() -> None:
    reference = TraceValue(
        {"memory_id": "a", "cube_id": "cube"},
        identity="memory:cube:a",
        category="persisted_memory",
        class_name="memory",
        identity_only=True,
    )
    enhanced = TraceValue("Synthetic enhancement", identity="enhanced")
    event = TraceEvent(
        operation="synthetic.refine",
        category="memory_refinement",
        trace_id="synthetic-trace",
        links=(TraceLink(reference, enhanced),),
    )
    settings = SmartCommentSettings(strict=True)
    recorder = SmartCommentRecorder(settings, event)
    recorder.record(event)
    snapshot = recorder.export_graph()
    original = next(
        node for node in snapshot["data"]["nodes"] if node["category"] == "persisted_memory"
    )
    assert original["metadata"]["snapshot_status"] == "reference"

    restored = SmartCommentRecorder(settings, event)
    restored.restore_graph(snapshot)
    for text in ("Synthetic original memory", "Synthetic conflicting memory"):
        restored.record(
            TraceEvent(
                operation="synthetic.persist",
                category="memory_persistence",
                trace_id=event.trace_id,
                outputs=(replace(reference, value=text, identity_only=False),),
            )
        )

    data = restored.export_graph()["data"]
    assert len(data["nodes"]) == 2
    node = next(node for node in data["nodes"] if node["category"] == "persisted_memory")
    assert node["full_node_id"] == original["full_node_id"]
    assert node["metadata"]["snapshot_status"] == "complete"
    assert json.loads(node["value"]) == "Synthetic original memory"
    assert data["edges"] == snapshot["data"]["edges"]
