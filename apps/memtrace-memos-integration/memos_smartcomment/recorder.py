# Translate semantic events into one SmartComment graph per trace.
from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

from memos.exceptions import MemOSError
from memos.log import get_logger


if TYPE_CHECKING:
    from memos_smartcomment.config import SmartCommentSettings
    from memos_smartcomment.events import TraceEvent, TraceValue


_NONE_FULL_NODE_ID = "COMMENT:NONE@1"
_NONE_SESSION_ID = "__none__"
_NONE_OPERATION_ID = "__none_op__"
logger = get_logger(__name__)


# Use stable encoding when comparing immutable snapshots.
def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: str) -> Any:
    return json.loads(value)


class SmartCommentRecorder:
    """Own one smartcomment graph and append normalized MemOS events to it."""

    def __init__(self, settings: SmartCommentSettings, first_event: TraceEvent) -> None:
        from smartcomment import (
            comment_graph,
            comment_link,
            comment_op_scope,
            comment_session,
            comment_variable,
        )
        from smartcomment.runtime import ExecNetwork

        self._comment_graph = comment_graph
        self._comment_link = comment_link
        self._comment_op_scope = comment_op_scope
        self._comment_session = comment_session
        self._comment_variable = comment_variable
        self._graph = ExecNetwork(
            graph_id=first_event.trace_id,
            user_id=first_event.user_id,
            project_id=settings.project_id,
            strict=settings.strict,
        )

    # Event recording: register explicit values and dependencies, never an input/output product.
    @staticmethod
    def _as_comment_item(value: TraceValue) -> tuple[Any, dict[str, Any]]:
        options: dict[str, Any] = {
            "id_strategy": lambda _value, identity=value.identity: identity,
            "encoding_fn": _encode,
            "decoding_fn": _decode,
            "category": value.category,
            "identity_only": value.identity_only,
            "metadata": value.metadata,
        }
        if value.class_name is not None:
            options["class_name"] = value.class_name
        if value.comment is not None:
            options["comment"] = value.comment
        if value.category == "persisted_memory":
            # A database memory ID is an immutable graph anchor, not a versioned view.
            options["identity_only"] = True
            options["metadata"] = {
                **value.metadata,
                "snapshot_status": "reference" if value.identity_only else "complete",
            }
        return value.value, options

    # SmartComment sessions describe events; MemOS sessions remain metadata.
    def record(self, event: TraceEvent) -> None:
        session_metadata = {
            "memos_session_id": event.session_id,
            "task_id": event.task_id,
            "cube_ids": list(event.cube_ids),
            "trace_event_id": event.event_id,
            "trace_event_created_at": event.created_at,
        }
        operation_metadata = {
            **event.metadata,
            "trace_event_id": event.event_id,
            "memos_trace_id": event.trace_id,
            "memos_session_id": event.session_id,
            "task_id": event.task_id,
            "cube_ids": list(event.cube_ids),
        }
        nodes: dict[int, Any] = {}
        completions: dict[str, TraceValue] = {}

        # Cache object registrations within this event; identities handle cross-event reuse.
        def register(value: TraceValue) -> Any:
            key = id(value)
            if key not in nodes:
                raw_value, options = self._as_comment_item(value)
                node = self._comment_variable(raw_value, to_runtime=True, **options)
                nodes[key] = node
                if (
                    not value.identity_only
                    and getattr(node, "category", None) == "persisted_memory"
                ):
                    if node.metadata.get("snapshot_status") == "reference":
                        completions.setdefault(node.full_node_id, value)
                    elif node.raw_value != _encode(value.value):
                        logger.warning(
                            "Ignoring a conflicting snapshot for immutable memory unit %s",
                            value.identity,
                        )
            return nodes[key]

        with (
            self._comment_graph(graph=self._graph),
            self._comment_session(
                session_id=f"event-{event.event_id}",
                session_name=event.operation,
                category=event.category,
                comment=(
                    event.comment
                    if event.comment is not None
                    else f"MemOS event for {event.operation}."
                ),
                metadata=session_metadata,
            ),
            self._comment_op_scope(
                op_name=event.operation,
                category=event.category,
                comment=(
                    event.comment
                    if event.comment is not None
                    else f"MemOS semantic operation: {event.operation}."
                ),
                metadata=operation_metadata,
            ),
        ):
            for value in (*event.inputs, *event.outputs):
                register(value)
            # Register link endpoints even when omitted from inputs/outputs; link metadata wins.
            for link in event.links:
                self._comment_link(
                    source=register(link.source),
                    target=register(link.target),
                    category=link.category,
                    comment=link.comment,
                    edge_metadata={**operation_metadata, **link.metadata},
                )
        if completions:
            self._complete_memory_snapshots(completions)

    # Current-format snapshots: complete references once, restore, and export for persistence.
    def _complete_memory_snapshots(self, completions: dict[str, TraceValue]) -> None:
        """Fill an ID-only placeholder once, preserving its node ID and incident edges."""
        exported = self._graph.export_graph()
        for node in exported["data"]["nodes"]:
            if (value := completions.get(node["full_node_id"])) is not None:
                node["value"] = _encode(value.value)
                node["comment"] = value.comment
                node["metadata"] = {
                    **node.get("metadata", {}),
                    **value.metadata,
                    "snapshot_status": "complete",
                }
        # Use the public graph round-trip API after exiting the active graph scope.
        self.restore_graph(exported)

    def restore_graph(self, data: dict[str, Any]) -> None:
        """Restore a current-format snapshot without changing its identities or edges."""
        from smartcomment.runtime import ExecNetwork

        for field in ("graph_id", "user_id", "project_id"):
            if data.get(field) != getattr(self._graph, field):
                raise MemOSError(f"Snapshot {field} does not match the requested graph")
        graph = ExecNetwork.import_graph(data)
        graph.strict = self._graph.strict
        self._graph = graph

    # Hide SmartComment's internal NONE sentinel and its associated graph elements.
    def export_graph(self) -> dict[str, Any]:
        exported = self._graph.export_graph()
        data = exported["data"]
        data["nodes"] = [
            node for node in data["nodes"] if node["full_node_id"] != _NONE_FULL_NODE_ID
        ]
        data["edges"] = [
            edge
            for edge in data["edges"]
            if edge["source_full_node_id"] != _NONE_FULL_NODE_ID
            and edge["target_full_node_id"] != _NONE_FULL_NODE_ID
        ]
        data["operations"] = [
            operation
            for operation in data["operations"]
            if operation["op_id"] != _NONE_OPERATION_ID
        ]
        data["sessions"] = [
            session for session in data["sessions"] if session["session_id"] != _NONE_SESSION_ID
        ]
        return exported
