"""Slice durable Add ancestry and link it to final Search result lists."""

from __future__ import annotations

import json

from collections import defaultdict
from copy import deepcopy
from dataclasses import replace
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos_smartcomment.events import TraceEvent, TraceLink, TraceValue


if TYPE_CHECKING:
    from collections.abc import Iterable


_NODE_CATEGORIES = {
    "input_message_batch",
    "message_batch",
    "extracted_memory",
    "enhanced_memory",
    "persisted_memory",
}
_EDGE_CATEGORIES = {"memory_extraction", "memory_persistence", "memory_refinement"}
_SOURCE_TRACE = "lineage_source_trace_id"
_IDS = {
    "nodes": "full_node_id",
    "edges": "edge_id",
    "operations": "op_id",
    "sessions": "session_id",
}


def _memory_key(cube_id: Any, memory_id: Any) -> tuple[str, str] | None:
    # Missing IDs cannot be correlated safely, even if text happens to match.
    if cube_id is None or memory_id is None or str(cube_id) == "" or str(memory_id) == "":
        return None
    return str(cube_id), str(memory_id)


def _complete(node: dict[str, Any]) -> bool:
    return node.get("metadata", {}).get("snapshot_status") == "complete"


def _write_observed(node: dict[str, Any]) -> bool:
    return node.get("metadata", {}).get("memos_stage") in {
        "text_memory.add.after",
        "scheduler.mem_read.add_enhanced_memories.after",
    }


class _Ancestry:
    """An ephemeral index of native Add data, shared across all hits of one Search."""

    def __init__(self) -> None:
        self.items: dict[str, dict[str, dict[str, Any]]] = {field: {} for field in _IDS}
        self.ambiguous: set[str] = set()

    def include(self, graph: dict[str, Any]) -> None:
        data = graph["data"]
        for field, id_field in _IDS.items():
            for item in data.get(field, ()):
                # An imported slice is never a new source of truth for another Search.
                if _SOURCE_TRACE in item.get("metadata", {}):
                    continue
                if field == "nodes" and item.get("category") not in _NODE_CATEGORIES:
                    continue
                if field == "edges" and item.get("category") not in _EDGE_CATEGORIES:
                    continue
                key = item[id_field]
                prior = self.items[field].get(key)
                if field == "nodes" and prior is not None:
                    # Legacy colon-concatenated identities can collide. Do not guess.
                    if item["category"] == prior["category"] == "persisted_memory":
                        a, b = item.get("metadata", {}), prior.get("metadata", {})
                        if _memory_key(a.get("cube_id"), a.get("memory_id")) != _memory_key(
                            b.get("cube_id"), b.get("memory_id")
                        ):
                            self.ambiguous.add(key)
                        # A scheduler reference must not hide the original write snapshot.
                        prior_priority = (_complete(prior), _write_observed(prior))
                        item_priority = (_complete(item), _write_observed(item))
                        if prior_priority > item_priority:
                            continue
                        if (
                            prior_priority == item_priority
                            and prior["created_at"] <= item["created_at"]
                        ):
                            continue
                    elif prior.get("value") != item.get("value"):
                        self.ambiguous.add(key)
                        continue
                self.items[field][key] = item

    def roots(self) -> dict[tuple[str, str], str]:
        candidates: dict[tuple[str, str], set[str]] = defaultdict(set)
        writes = {
            e["target_full_node_id"]
            for e in self.items["edges"].values()
            if e.get("category") == "memory_persistence"
        }
        for node_id, node in self.items["nodes"].items():
            metadata = node.get("metadata", {})
            # A bare scheduler reference is not evidence that an Add was observed.
            if (
                node_id in self.ambiguous
                or node.get("category") != "persisted_memory"
                or not (_complete(node) or node_id in writes or _write_observed(node))
            ):
                continue
            key = _memory_key(metadata.get("cube_id"), metadata.get("memory_id"))
            if key is not None:
                candidates[key].add(node_id)
        return {key: next(iter(ids)) for key, ids in candidates.items() if len(ids) == 1}

    def slice(self, roots: Iterable[str]) -> dict[str, dict[str, dict[str, Any]]]:
        selected: dict[str, dict[str, dict[str, Any]]] = {field: {} for field in _IDS}
        incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for edge in self.items["edges"].values():
            source, target = edge["source_full_node_id"], edge["target_full_node_id"]
            if (
                source in self.items["nodes"]
                and target in self.items["nodes"]
                and source not in self.ambiguous
                and target not in self.ambiguous
            ):
                incoming[target].append(edge)
        pending = list(roots)
        while pending:
            node_id = pending.pop()
            if node_id in selected["nodes"]:
                continue
            selected["nodes"][node_id] = self.items["nodes"][node_id]
            # Reverse traversal never expands siblings or downstream status/deletion nodes.
            for edge in incoming[node_id]:
                selected["edges"][edge["edge_id"]] = edge
                pending.append(edge["source_full_node_id"])
        op_ids = {edge["op_id"] for edge in selected["edges"].values()}
        session_ids = {
            item["session_id"] for field in ("nodes", "edges") for item in selected[field].values()
        }
        for op_id, operation in self.items["operations"].items():
            if op_id in op_ids or operation["session_id"] in session_ids:
                selected["operations"][op_id] = operation
                session_ids.add(operation["session_id"])
        selected["sessions"] = {
            key: session for key, session in self.items["sessions"].items() if key in session_ids
        }
        return selected


def connect_search_lineage(
    current: dict[str, Any],
    event: TraceEvent,
    sources: Iterable[dict[str, Any]],
) -> tuple[dict[str, Any], TraceEvent | None]:
    """Return a detached Add slice and explicit final-list -> persisted-memory links."""
    hits: list[tuple[tuple[str, str], TraceValue, int, Any]] = []
    for output in event.outputs:
        if (
            output.category != "search_memory_list_rerank"
            or output.metadata.get("stage") != "rerank"
        ):
            continue
        seen = set()
        for rank, entry in enumerate(output.value, start=1):
            key = _memory_key(output.metadata.get("cube_id"), entry.get("memory_id"))
            if key is not None and key not in seen:
                hits.append((key, output, rank, entry.get("score")))
                seen.add(key)
    if not hits:
        return current, None

    ancestry = _Ancestry()
    for source in sources:
        if all(source.get(field) == current.get(field) for field in ("user_id", "project_id")):
            ancestry.include(source)
    ancestry.include(current)
    roots = ancestry.roots()
    matched = [(key, result, rank, score) for key, result, rank, score in hits if key in roots]
    selected = ancestry.slice(roots[key] for key, _result, _rank, _score in matched)
    merged = deepcopy(current)
    for field, id_field in _IDS.items():
        items = {item[id_field]: item for item in merged["data"][field]}
        for key, original in selected[field].items():
            prior = items.get(key)
            if prior is not None and not (
                field == "nodes"
                and prior.get("category") == "persisted_memory"
                and not _complete(prior)
                and _complete(original)
            ):
                continue
            item = deepcopy(original)
            if item["graph_id"] != current["graph_id"]:
                item["metadata"] = {**item.get("metadata", {}), _SOURCE_TRACE: item["graph_id"]}
                item["graph_id"] = current["graph_id"]
            items[key] = item
        merged["data"][field] = list(items.values())

    links = []
    for key, result, rank, score in matched:
        node = ancestry.items["nodes"][roots[key]]

        score_str = f"{float(score):.3f}" if score is not None else "unknown"

        memory = TraceValue(
            value=json.loads(node["value"]),
            identity=node["name"],
            category=node["category"],
            class_name=node.get("class_name"),
            identity_only=True,
            comment=node.get("comment"),
            metadata=deepcopy(node["metadata"]),
        )

        links.append(
            TraceLink(
                source=replace(result, identity_only=True),
                target=memory,
                category="memory_search_lineage",
                comment=(
                    f"Retrieve this memory at rank={rank}, "
                    f"score={score_str} in the final search result list."
                ),
                metadata={
                    "cube_id": key[0],
                    "memory_id": key[1],
                    "source_trace_id": node["graph_id"],
                    "rank": rank,
                    "score": score,
                },
            )
        )
    return merged, replace(
        event,
        operation="memos.search.link_add_lineage",
        category="memory_search_lineage",
        comment="Connect final Search hits to their observed Add ancestry.",
        event_id=uuid4().hex,
        inputs=(),
        outputs=(),
        links=tuple(links),
        metadata={
            "memos_stage": "search.results.after_rerank",
            "operation_id": event.metadata.get("operation_id"),
            "requested_count": len(hits),
            "linked_count": len(matched),
            "unresolved_count": len(hits) - len(matched),
            "lineage_status": (
                "resolved" if len(matched) == len(hits) else "partial" if matched else "unresolved"
            ),
        },
    )
