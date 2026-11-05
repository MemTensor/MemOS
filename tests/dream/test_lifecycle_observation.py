"""Final-result notifications and successful native feedback attribution."""

import logging

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APISearchRequest
from memos.dream.lifecycle import LIFECYCLE_METADATA_KEY, LifecycleConfig
from memos.dream.lifecycle.observation import DreamLifecycleObserver
from memos.dream.lifecycle.service import DreamLifecycleService
from memos.mem_feedback.feedback import MemFeedback
from memos.memories.textual.item import TextualMemoryItem
from memos.plugins import hooks
from memos.plugins.hook_defs import H, get_hook_spec


@pytest.fixture(autouse=True)
def restore_hooks():
    before = {key: list(value) for key, value in hooks._hooks.items()}
    hooks._hooks.clear()
    yield
    hooks._hooks.clear()
    hooks._hooks.update(before)


def new_node(graph):
    item = str(uuid4())
    graph.add_node(
        item, "Synthetic source", {"source": "dream", "status": "activated"}, user_name="cube-a"
    )
    return item


def observer(graph):
    return DreamLifecycleObserver(DreamLifecycleService(graph, LifecycleConfig()))


def test_real_search_counts_only_final_returned_ids_after_every_pipe(graph):
    kept, removed, injected = new_node(graph), new_node(graph), new_node(graph)
    view = SimpleNamespace(
        search_memories=lambda request: {
            "text_mem": [
                {
                    "cube_id": "cube-a",
                    "memories": [
                        {
                            "id": item,
                            "memory": "Synthetic",
                            "metadata": {"relativity": 1, "memory_type": "LongTermMemory"},
                        }
                        for item in (kept, removed)
                    ],
                }
            ]
        }
    )
    handler = SearchHandler.__new__(SearchHandler)
    handler.logger = logging.getLogger("lifecycle-search-test")
    handler.deps = SimpleNamespace(reranker=None)
    handler._build_cube_view = lambda request: view

    def final_pipe(request, result):
        result.data["text_mem"][0]["memories"] = [{"id": kept}, {"id": kept}]
        return result

    def malicious_notification(**kwargs):
        kwargs["result"].data["text_mem"][0]["memories"] = [{"id": injected}]

    bridge = observer(graph)
    hooks.register_hook(H.SEARCH_AFTER, final_pipe)
    hooks.register_hook(H.SEARCH_COMPLETED, malicious_notification)
    hooks.register_hook(H.SEARCH_COMPLETED, bridge.on_search_completed)
    response = handler.handle_search_memories(
        APISearchRequest(
            user_id="user-a",
            readable_cube_ids=["cube-a"],
            query="Fixture",
            relativity=0,
            dedup="no",
            top_k=2,
        )
    )
    assert [item["id"] for item in response.data["text_mem"][0]["memories"]] == [kept, kept]
    assert (
        graph.get_node(kept, user_name="cube-a")["metadata"][LIFECYCLE_METADATA_KEY]["hit_count"]
        == 1
    )
    assert LIFECYCLE_METADATA_KEY not in graph.get_node(removed, user_name="cube-a")["metadata"]
    assert LIFECYCLE_METADATA_KEY not in graph.get_node(injected, user_name="cube-a")["metadata"]
    assert bridge.delivery_snapshot().accepted == 1


def test_explicit_delivery_replay_keeps_identity_and_foreign_buckets_are_excluded(graph):
    item = new_node(graph)
    bridge = observer(graph)
    request = APISearchRequest(user_id="user-a", readable_cube_ids=["cube-a"], query="Fixture")
    payload = {
        "text_mem": [
            {"cube_id": "cube-a", "memories": [{"id": item}]},
            {"cube_id": "foreign", "memories": [{"id": item}]},
        ]
    }
    now = datetime.now(timezone.utc)
    bridge.observe_returned(request=request, results=payload, event_id="stable-response", at=now)
    bridge.observe_returned(request=request, results=payload, event_id="stable-response", at=now)
    snapshot = bridge.delivery_snapshot()
    assert snapshot.accepted == 1 and snapshot.duplicates == 1


def test_native_successful_feedback_notifies_only_explicit_affected_id(graph):
    old_id, other_id = new_node(graph), new_node(graph)
    bridge = observer(graph)
    hooks.register_hook(H.MEMORY_FEEDBACK_COMMITTED, bridge.on_feedback_committed)
    feedback = MemFeedback.__new__(MemFeedback)
    feedback.mem_reader = SimpleNamespace(memory_version_switch="off")
    feedback.graph_store = graph
    feedback._single_add_operation = lambda *args: {"id": new_node(graph)}
    old = TextualMemoryItem(id=old_id, memory="Before", metadata={"memory_type": "LongTermMemory"})
    new = TextualMemoryItem(memory="Corrected", metadata={"memory_type": "LongTermMemory"})
    feedback._single_update_operation(old, new, "user-a", "cube-a")
    metadata = graph.get_node(old_id, user_name="cube-a")["metadata"]
    assert metadata[LIFECYCLE_METADATA_KEY]["invalidated_by_feedback"]
    assert LIFECYCLE_METADATA_KEY not in graph.get_node(other_id, user_name="cube-a")["metadata"]
    assert get_hook_spec(H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE).pipe_key is None
    assert len(hooks._hooks.get(H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE, [])) == 0


def test_failed_native_feedback_emits_no_success_notification(graph, monkeypatch):
    item = new_node(graph)
    calls = []
    hooks.register_hook(H.MEMORY_FEEDBACK_COMMITTED, lambda **kwargs: calls.append(kwargs))
    feedback = MemFeedback.__new__(MemFeedback)
    feedback.mem_reader = SimpleNamespace(memory_version_switch="off")
    feedback.graph_store = graph
    monkeypatch.setattr(
        graph,
        "update_node",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("Synthetic failed write")),
    )
    old = TextualMemoryItem(id=item, memory="Before", metadata={"memory_type": "WorkingMemory"})
    new = TextualMemoryItem(memory="Corrected", metadata={"memory_type": "WorkingMemory", "embedding": [0, 0, 1]})
    with pytest.raises(OSError):
        feedback._single_update_operation(old, new, "user-a", "cube-a")
    assert calls == []


def test_delivery_failure_is_reported_without_mutating_response(graph):
    item = new_node(graph)
    graph.update_node(item, {LIFECYCLE_METADATA_KEY: {"version": 99}}, user_name="cube-a")
    bridge = observer(graph)
    hooks.register_hook(H.SEARCH_COMPLETED, bridge.on_search_completed)
    from memos.api.product_models import SearchResponse

    request = APISearchRequest(user_id="user-a", readable_cube_ids=["cube-a"], query="Fixture")
    response = SearchResponse(
        message="Fixture", data={"text_mem": [{"cube_id": "cube-a", "memories": [{"id": item}]}]}
    )
    delivery = hooks.notify_hook(
        H.SEARCH_COMPLETED,
        request=request,
        result=response,
        event_id="failed-delivery",
        at=datetime.now(timezone.utc),
    )
    assert delivery.failed == 1 and bridge.delivery_snapshot().failed == 1
    assert response.data["text_mem"][0]["memories"] == [{"id": item}]
