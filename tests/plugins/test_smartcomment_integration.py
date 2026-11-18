"""Plugin isolation, persistence recovery and shutdown without external services."""

import errno
import json
import threading

from contextlib import asynccontextmanager, nullcontext
from copy import deepcopy
from dataclasses import asdict

import pytest


pytest.importorskip("memos_smartcomment")
pytest.importorskip("smartcomment")

from memos_smartcomment import adapter as adapter_module
from memos_smartcomment import storage
from memos_smartcomment.adapter import AsyncTraceAdapter
from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.events import DeferredTraceEvent, TraceEvent, TraceValue
from memos_smartcomment.handlers import HookHandlers
from memos_smartcomment.plugin import SmartCommentPlugin

from memos.exceptions import ConfigurationError


def observation(trace="trace-a", user="user-a"):
    return TraceEvent(
        operation="memos.search.request",
        category="search_request",
        trace_id=trace,
        user_id=user,
        outputs=(TraceValue(value="example", identity="query"),),
    )


def search_fixture(query="query", user="user-a"):
    request = {"trace_id": "shared", "user_id": user, "query": query, "relativity": 0.5}
    results = {
        "text_mem": [
            {"cube_id": "cube-a", "memories": [{"id": query, "memory": query, "score": 0.0}]}
        ]
    }
    return request, results


@pytest.mark.parametrize("deferred", [False, True])
@pytest.mark.parametrize("terminal", ["rerank", "failure"])
def test_search_stages_remain_with_their_user(deferred, terminal):
    events, pending = [], []
    handler = HookHandlers(events.append, defer_search=pending.append if deferred else None)
    first, first_results = search_fixture("first", "user-a")
    second, second_results = search_fixture("second", "user-b")
    for request, results in ((first, first_results), (second, second_results)):
        handler.on_search_memory_results(search_req=request, results=results)
    if terminal == "failure":
        handler.on_search_post_process_failed(
            handler=None, search_req=first, error=ValueError("example")
        )
    else:
        handler.on_search_results_after_rerank(search_req=first, results=first_results)
    handler.on_search_results_after_rerank(search_req=second, results=second_results)
    events.extend(work.build() for work in pending)

    reranks = [event for event in events if event.operation == "memos.search.rerank"]
    assert len(reranks) == (1 if terminal == "failure" else 2)
    for event in reranks:
        marker = "first" if event.user_id == "user-a" else "second"
        assert len(event.links) == 1
        assert (
            event.links[0].source.value
            == event.links[0].target.value
            == [{"memory_id": marker, "memory": marker, "score": 0.0}]
        )
    assert not handler._search_stages


@pytest.mark.parametrize("same_query", [False, True])
def test_overlapping_requests_keep_distinct_graph_chains(tmp_path, same_query):
    adapter = AsyncTraceAdapter(SmartCommentSettings(output_dir=tmp_path, strict=True))
    handler = HookHandlers(adapter.submit, defer_search=adapter.submit)
    requests, results = zip(
        *(search_fixture(marker) for marker in ("first", "second")), strict=True
    )
    if same_query:
        requests[1]["query"] = requests[0]["query"]
    original = deepcopy((requests, results))
    try:
        for request in requests:
            handler.on_search_before(request=request)
        # MemOS copies requests before retrieval and rebuilds context at each stage.
        working = deepcopy(requests)
        for request, result in zip(working, results, strict=True):
            handler.on_search_memory_results(search_req=request, results=result)
        for request, result in zip(working, results, strict=True):
            handler.on_search_results_after_rerank(search_req=request, results=result)
        assert not handler._search_stages
        assert adapter.flush(timeout=5)
        assert adapter.stats.processed == 6
        assert adapter.stats.failed == adapter.stats.write_failures == 0
        data = json.loads(adapter.output_path("shared", "user-a").read_text())["data"]
        nodes = {node["full_node_id"]: node for node in data["nodes"]}
        reranks = [edge for edge in data["edges"] if edge["category"] == "memory_reranked"]
        assert len(reranks) == 2
        for edge in reranks:
            source, target = (
                nodes[edge[key]] for key in ("source_full_node_id", "target_full_node_id")
            )
            assert json.loads(source["value"]) == json.loads(target["value"])
        for marker in ("first", "second"):
            raw = next(
                node
                for node in nodes.values()
                if node["category"] == "search_memory_list_raw"
                and json.loads(node["value"])[0]["memory"] == marker
            )
            current = raw["full_node_id"]
            for category in ("memory_retrieval", "memory_cube_branch", "memory_type_branch"):
                parents = [
                    edge["source_full_node_id"]
                    for edge in data["edges"]
                    if edge["category"] == category and edge["target_full_node_id"] == current
                ]
                assert len(parents) == 1
                current = parents[0]
            assert json.loads(nodes[current]["value"]) == ("first" if same_query else marker)
        assert (requests, results) == original
    finally:
        adapter.close()


@pytest.mark.parametrize("stage", ["raw", "threshold", "rerank", "failure"])
@pytest.mark.parametrize("boundary", ["_snapshot", "_event"])
def test_failed_capture_releases_only_its_request_state(monkeypatch, stage, boundary):
    handler = HookHandlers(lambda event: None, defer_search=lambda work: None)
    request, results = search_fixture()
    other_request, other_results = search_fixture("other")
    other_request["trace_id"] = "other-trace"
    handler.on_search_memory_results(search_req=request, results=results)
    handler.on_search_memory_results(search_req=other_request, results=other_results)

    def fail(*args, **kwargs):
        raise ValueError("injected capture failure")

    with monkeypatch.context() as patch:
        patch.setattr(handler, boundary, fail)
        with pytest.raises(ValueError, match="injected capture failure"):
            if stage == "failure":
                handler.on_search_post_process_failed(
                    handler=None, search_req=request, error=ValueError("example")
                )
            else:
                callback = {
                    "raw": handler.on_search_memory_results,
                    "threshold": handler.on_search_results_after_threshold,
                    "rerank": handler.on_search_results_after_rerank,
                }[stage]
                callback(search_req=request, results=results)
    assert len(handler._search_stages) == 1
    handler.on_search_results_after_rerank(search_req=other_request, results=other_results)
    assert not handler._search_stages


def test_deferred_events_keep_snapshots_and_removed_counts():
    events, pending = [], []
    handler = HookHandlers(events.append, defer_search=pending.append, max_value_chars=8)
    request, results = search_fixture()
    memories = results["text_mem"][0]["memories"]
    memories[:] = [
        {"id": "kept", "memory": {"text": "before", "api_key": "fixture-secret"}, "score": 0},
        {"memory": "abcdefgh-first"},
        {"memory": "abcdefgh-second"},
    ]
    handler.on_search_before(request=request)
    handler.on_search_memory_results(search_req=request, results=results)
    memories.pop(1)
    handler.on_search_results_after_threshold(search_req=request, results=results)
    handler.on_search_results_after_rerank(search_req=request, results=results)
    memories[0]["memory"]["text"] = "after"
    request["trace_id"] = "changed"
    assert all(isinstance(work, DeferredTraceEvent) for work in pending)
    events.extend(work.build() for work in pending)
    assert [event.metadata.get("filtered_count") for event in events] == [None, 0, 1, 0]
    assert {event.trace_id for event in events} == {"shared"}
    captured = json.dumps([asdict(event) for event in events])
    assert "fixture-secret" not in captured and "<redacted>" in captured
    assert '"text": "before"' in captured and '"text": "after"' not in captured
    assert not handler._search_stages


@pytest.mark.parametrize("same_user", [False, True])
@pytest.mark.parametrize("dedup, events_per_request", [("no", 4), ("mmr", 5)])
def test_plugin_preserves_concurrent_api_search_results(
    tmp_path, monkeypatch, clean_hooks, same_user, dedup, events_per_request
):
    from concurrent.futures import ThreadPoolExecutor
    from types import SimpleNamespace

    from memos.api.handlers.base_handler import HandlerDependencies
    from memos.api.handlers.search_handler import SearchHandler
    from memos.api.product_models import APISearchRequest
    from memos.plugins.hook_defs import H
    from memos.plugins.hooks import register_hook

    monkeypatch.setattr("memos.api.handlers.search_handler.get_current_trace_id", lambda: "shared")
    handler = SearchHandler(
        HandlerDependencies(
            naive_mem_cube=object(),
            mem_scheduler=object(),
            searcher=object(),
            deepsearch_agent=object(),
        )
    )
    requests = [
        APISearchRequest(user_id="user-a", query="first", relativity=0.5, dedup=dedup, top_k=5),
        APISearchRequest(
            user_id="user-a" if same_user else "user-b",
            query="second",
            relativity=0.5,
            dedup=dedup,
            top_k=5,
        ),
    ]
    original = [request.model_dump() for request in requests]

    def retrieve(request):
        _, results = search_fixture(request.query)
        results["text_mem"][0]["memories"][0]["metadata"] = {
            "relativity": 1.0,
            "memory_type": "LongTermMemory",
        }
        return results

    monkeypatch.setattr(
        handler, "_build_cube_view", lambda request: SimpleNamespace(search_memories=retrieve)
    )
    expected = [handler.handle_search_memories(request).model_dump() for request in requests]
    monkeypatch.setenv("MEMOS_SMARTCOMMENT_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setenv("MEMOS_SMARTCOMMENT_STRICT", "true")
    plugin = SmartCommentPlugin()
    barrier = threading.Barrier(2)

    def wait_for_both_raw_stages(**kwargs):
        barrier.wait(timeout=5)

    try:
        plugin.on_load()
        register_hook(H.SEARCH_MEMORY_RESULTS, wait_for_both_raw_stages)
        with ThreadPoolExecutor(max_workers=2) as pool:
            actual = list(pool.map(handler.handle_search_memories, requests))
        assert [response.model_dump() for response in actual] == expected
        assert [request.model_dump() for request in requests] == original
        assert not plugin.handlers._search_stages
        assert plugin.adapter.flush(timeout=5)
        assert plugin.adapter.stats.processed == 2 * events_per_request
        assert plugin.adapter.stats.failed == plugin.adapter.stats.write_failures == 0
        for user in {request.user_id for request in requests}:
            data = json.loads(plugin.adapter.output_path("shared", user).read_text())["data"]
            nodes = {node["full_node_id"]: node for node in data["nodes"]}
            links = [
                edge
                for edge in data["edges"]
                if edge["category"]
                in {"memory_threshold_passed", "memory_deduplicated", "memory_reranked"}
            ]
            assert len(links) == (events_per_request - 2) * (2 if same_user else 1)
            for edge in links:
                assert (
                    nodes[edge["source_full_node_id"]]["value"]
                    == nodes[edge["target_full_node_id"]]["value"]
                )
            if not same_user:
                foreign = "second" if user == "user-a" else "first"
                assert all(foreign not in node["value"] for node in nodes.values())
    finally:
        plugin.on_shutdown()


@pytest.mark.parametrize("link_history", [False, True])
def test_add_snapshots_and_search_lineage_survive_restart(tmp_path, link_history):
    from memos.plugins.hook_context import HookContext

    settings = SmartCommentSettings(output_dir=tmp_path, link_search_to_add=link_history)
    adapter = AsyncTraceAdapter(settings)
    handler = HookHandlers(adapter.submit, defer_search=adapter.submit)
    context = HookContext(trace_id="add", user_id="user-a", cube_ids=("cube-a",))
    messages = [{"role": "user", "content": "Remember the blue notebook"}]
    request = {
        "trace_id": "add",
        "user_id": "user-a",
        "writable_cube_ids": ["cube-a"],
        "messages": messages,
    }
    memory = {"id": "memory-a", "memory": "The notebook is blue"}
    try:
        handler.on_add_before(request=request)
        handler.on_mem_reader_extract_after(
            hook_context=context,
            scene_data=[messages],
            type="chat",
            info=None,
            mode="fine",
            user_name="cube-a",
            result=[memory],
        )
        handler.on_text_memory_add_after(
            hook_context=context,
            text_memory=None,
            memories=[memory],
            kwargs={},
            result=["memory-a"],
        )
        handler.on_add_after(request=request)
        messages[0]["content"] = "changed after capture"
        memory["memory"] = "changed after capture"
        assert adapter.flush(timeout=5)
        assert adapter.stats.processed == 3 and adapter.stats.failed == 0
        add_path = adapter.output_path("add", "user-a")
        add_snapshot = add_path.read_bytes()
    finally:
        adapter.close()

    reopened = AsyncTraceAdapter(settings)
    handler = HookHandlers(reopened.submit, defer_search=reopened.submit)
    search, results = search_fixture()
    results["text_mem"][0]["memories"] = [
        {"id": "memory-a", "memory": "The notebook is blue", "score": 0.0}
    ]
    try:
        handler.on_search_before(request=search)
        handler.on_search_memory_results(search_req=search, results=results)
        handler.on_search_results_after_rerank(search_req=search, results=results)
        assert reopened.flush(timeout=5)
        assert reopened.stats.processed == 3
        assert reopened.stats.failed == reopened.stats.write_failures == 0
        data = json.loads(reopened.output_path("shared", "user-a").read_text())["data"]
        lineage = [edge for edge in data["edges"] if edge["category"] == "memory_search_lineage"]
        assert len(lineage) == int(link_history)
        if link_history:
            assert lineage[0]["metadata"]["rank"] == 1
            assert lineage[0]["metadata"]["score"] == 0.0
            assert {edge["category"] for edge in data["edges"]} >= {
                "memory_extraction",
                "memory_persistence",
            }
            assert any(
                json.loads(node["value"]) == "The notebook is blue" for node in data["nodes"]
            )
            assert any(
                json.loads(node["value"])
                == [{"role": "user", "content": "Remember the blue notebook"}]
                for node in data["nodes"]
            )
        assert add_path.read_bytes() == add_snapshot
    finally:
        reopened.close()


@pytest.mark.parametrize("filename", ["_user.json", "meta.json"])
@pytest.mark.parametrize("reopen", [False, True])
def test_failed_reservations_recover_without_exhausting_names(
    tmp_path, monkeypatch, filename, reopen
):
    settings = SmartCommentSettings(output_dir=tmp_path)
    store = storage.TraceStore(settings)
    event = observation()
    original = storage.os.replace

    def disk_full(source, destination):
        if destination.name == filename:
            raise OSError(errno.ENOSPC, "injected reservation failure")
        return original(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(storage.os, "replace", disk_full)
        for _ in range(4):
            with pytest.raises(OSError, match="injected reservation failure"):
                store.write([event], {"version": 1})
    if reopen:
        store = storage.TraceStore(settings)
    store.write([event], {"version": 2})
    assert store.publish_indexes() == 0
    path = store.output_path(event.trace_id, event.user_id)
    assert json.loads(path.read_text()) == {"version": 2}
    assert list(json.loads((path.parents[3] / "_index.json").read_text())["traces"]) == [
        event.trace_id
    ]
    assert not list(tmp_path.rglob("*.tmp"))


@pytest.mark.parametrize("filename", ["_user.json", "meta.json"])
def test_reservation_failure_preserves_other_files(tmp_path, monkeypatch, filename):
    store = storage.TraceStore(SmartCommentSettings(output_dir=tmp_path))
    original = storage.os.replace
    preserved = []

    def fail_with_existing_file(source, destination):
        if destination.name == filename:
            marker = destination.parent / "existing.json"
            marker.write_text('{"preserved": true}')
            preserved.append(marker)
            raise OSError(errno.ENOSPC, "injected reservation failure")
        return original(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(storage.os, "replace", fail_with_existing_file)
        with pytest.raises(OSError, match="injected reservation failure"):
            store.write([observation()], {"version": 1})
    store.write([observation()], {"version": 2})
    assert len(preserved) == 1
    assert json.loads(preserved[0].read_text()) == {"preserved": True}


@pytest.mark.parametrize(
    "field", ["queue_size", "max_value_chars", "max_cached_traces", "max_cached_graph_items"]
)
@pytest.mark.parametrize("value", [0, -1, 1.5, True, "4", None])
def test_settings_reject_invalid_integer_limits(field, value):
    with pytest.raises(ConfigurationError, match=field):
        SmartCommentSettings(**{field: value})


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf"), True, "4", None])
def test_settings_reject_invalid_cache_timeout(value):
    with pytest.raises(ConfigurationError, match="cache_ttl_seconds"):
        SmartCommentSettings(cache_ttl_seconds=value)


def test_settings_defaults_agree_between_entrypoints(monkeypatch):
    monkeypatch.delenv("MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD", raising=False)
    assert SmartCommentSettings().link_search_to_add is False
    assert SmartCommentSettings.from_env().link_search_to_add is False


@pytest.mark.parametrize(
    "raw, expected", [("0.5", 0.5), ("nan", 300), ("inf", 300), ("0", 300), ("bad", 300)]
)
def test_environment_accepts_finite_positive_fractional_timeout(monkeypatch, raw, expected):
    monkeypatch.setenv("MEMOS_SMARTCOMMENT_CACHE_TTL_SECONDS", raw)
    assert SmartCommentSettings.from_env().cache_ttl_seconds == expected


@pytest.mark.parametrize("failure", [None, "startup", "cleanup"])
def test_application_lifespan_preserves_state_and_closes_writer(
    tmp_path, monkeypatch, clean_hooks, failure
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("MEMOS_SMARTCOMMENT_OUTPUT_DIR", str(tmp_path))
    plugin = SmartCommentPlugin()
    plugin.on_load()
    adapter = plugin.adapter
    request, results = search_fixture()
    plugin.handlers.on_search_memory_results(search_req=request, results=results)

    @asynccontextmanager
    async def original_lifespan(app):
        if failure == "startup":
            raise ValueError("injected startup failure")
        yield {"marker": "original-state"}
        # Component shutdown may still emit accepted observations.
        assert adapter.submit(observation("cleanup"))
        if failure == "cleanup":
            raise ValueError("injected cleanup failure")

    app = FastAPI(lifespan=original_lifespan)
    plugin._bind_app(app)
    plugin.init_app()
    expectation = (
        pytest.raises(ValueError, match=f"injected {failure} failure") if failure else nullcontext()
    )
    try:
        with expectation, TestClient(app) as client:
            assert client.app_state["marker"] == "original-state"
        assert not adapter._thread.is_alive()
        assert not plugin.handlers._search_stages
        assert adapter.stats.processed == (1 if failure == "startup" else 2)
        assert adapter.stats.failed == adapter.stats.write_failures == 0
        assert not adapter._store.pending_indexes
        assert not adapter.submit(observation("late"))
        for path in tmp_path.glob("*/_index.json"):
            assert json.loads(path.read_text())["traces"]
    finally:
        adapter.close()


@pytest.mark.parametrize("filename", ["_user.json", "meta.json"])
def test_application_shutdown_drains_backlog_after_reservation_retry(
    tmp_path, monkeypatch, clean_hooks, filename
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("MEMOS_SMARTCOMMENT_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(adapter_module, "_RETRY_SECONDS", 0.01)
    plugin = SmartCommentPlugin()
    plugin.on_load()
    adapter = plugin.adapter
    original = storage.os.replace
    blocked, attempts = threading.Event(), threading.Event()
    blocked.set()
    failures = 0

    def disk_full(source, destination):
        nonlocal failures
        if destination.name == filename and blocked.is_set():
            failures += 1
            if failures >= 4:
                attempts.set()
            raise OSError(errno.ENOSPC, "injected reservation failure")
        return original(source, destination)

    @asynccontextmanager
    async def original_lifespan(app):
        yield
        blocked.clear()

    monkeypatch.setattr(storage.os, "replace", disk_full)
    app = FastAPI(lifespan=original_lifespan)
    plugin._bind_app(app)
    plugin.init_app()
    try:
        with TestClient(app):
            for _ in range(4):
                assert adapter.submit(observation())
            assert attempts.wait(2)
            assert adapter.stats.processed == 0
        assert not adapter._thread.is_alive()
        assert adapter.stats.processed == 4
        assert adapter.stats.write_failures >= 4
        assert adapter.stats.failed == adapter.stats.dropped == 0
        assert not adapter._pending and not adapter._store.pending_indexes
        path = adapter.output_path("trace-a", "user-a")
        assert len(json.loads(path.read_text())["data"]["operations"]) == 4
        assert "trace-a" in json.loads((path.parents[3] / "_index.json").read_text())["traces"]
    finally:
        blocked.clear()
        adapter.close()


@pytest.mark.parametrize("filename", ["graph.json", "_index.json", "index.md"])
def test_close_timeout_keeps_retry_work_until_storage_recovers(tmp_path, monkeypatch, filename):
    monkeypatch.setattr(adapter_module, "_RETRY_SECONDS", 0.01)
    adapter = AsyncTraceAdapter(SmartCommentSettings(output_dir=tmp_path))
    original = storage.os.replace
    blocked, attempted = threading.Event(), threading.Event()
    blocked.set()

    def disk_full(source, destination):
        if destination.name == filename and blocked.is_set():
            attempted.set()
            raise OSError(errno.ENOSPC, "injected storage failure")
        return original(source, destination)

    monkeypatch.setattr(storage.os, "replace", disk_full)
    try:
        assert adapter.submit(observation())
        assert not adapter.flush(timeout=0.05)
        assert attempted.wait(2)
        adapter.close(timeout=0.01)
        assert adapter._thread.is_alive()
        assert adapter.stats.write_failures >= 1
        assert adapter.stats.failed == adapter.stats.dropped == 0
        assert not adapter.submit(observation("late"))
        blocked.clear()
        assert adapter.flush(timeout=5)
        adapter.close()
        assert not adapter._thread.is_alive()
        assert adapter.stats.processed == 1
        assert not adapter._pending and not adapter._store.pending_indexes
        path = adapter.output_path("trace-a", "user-a")
        assert len(json.loads(path.read_text())["data"]["operations"]) == 1
        assert list(json.loads((path.parents[3] / "_index.json").read_text())["traces"]) == [
            "trace-a"
        ]
        assert (path.parents[3] / "index.md").is_file()
    finally:
        blocked.clear()
        adapter.close()
