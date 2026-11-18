"""Queue bounds and durable trace discovery complement the root retry tests."""

import json

from dataclasses import replace

from memos_smartcomment.adapter import AsyncTraceAdapter
from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.events import DeferredTraceEvent, TraceEvent, TraceValue


EVENT = TraceEvent(
    operation="memos.search.request",
    category="search_request",
    trace_id="../trace",
    user_id="../user",
    created_at="2026-10-15T06:32:10.125+00:00",
    outputs=(TraceValue("Synthetic | <query>", identity="query", category="search_query"),),
)


def _write(settings, event):
    adapter = AsyncTraceAdapter(settings)
    try:
        assert adapter.submit(event)
    finally:
        adapter.close()
    assert adapter.stats.processed == 1
    assert adapter.stats.failed == adapter.stats.write_failures == 0
    return adapter


def test_full_queue_drops_event_and_close_drains_accepted_work(tmp_path) -> None:
    adapter = AsyncTraceAdapter(SmartCommentSettings(output_dir=tmp_path, queue_size=1))
    try:
        assert adapter.submit(DeferredTraceEvent(EVENT.operation, lambda: EVENT))
        assert not adapter.submit(EVENT)
    finally:
        adapter.close()
    assert not adapter.submit(EVENT)
    stats = adapter.stats
    assert stats.accepted == stats.processed == stats.dropped == stats.rejected == 1
    assert stats.failed == stats.write_failures == 0
    data = json.loads(adapter.output_path(EVENT.trace_id, EVENT.user_id).read_text())["data"]
    assert len(data["operations"]) == 1


def test_restart_rebuilds_index_and_appends_to_original_trace_path(tmp_path) -> None:
    settings = SmartCommentSettings(output_dir=tmp_path, output_timezone="UTC")
    first = _write(settings, EVENT)
    path = first.output_path(EVENT.trace_id, EVENT.user_id)
    assert path.resolve().is_relative_to(tmp_path.resolve())
    assert path.parents[2].name == "2026-10-15" and path.parent.parent.name == "search"
    index = path.parents[3] / "_index.json"
    index.write_text("corrupt index", encoding="utf-8")
    later = replace(
        EVENT,
        event_id="later-event",
        operation="memos.scheduler.mem_read.after",
        created_at="2026-10-17T01:00:00+00:00",
        outputs=(TraceValue("Later observation", identity="later"),),
    )
    reopened = _write(replace(settings, output_timezone="Asia/Shanghai"), later)
    assert reopened.output_path(EVENT.trace_id, EVENT.user_id) == path
    graph = json.loads(path.read_text())
    assert len(graph["data"]["operations"]) == 2
    assert {json.loads(node["value"]) for node in graph["data"]["nodes"]} == {
        "Synthetic | <query>",
        "Later observation",
    }
    meta = json.loads(path.with_name("meta.json").read_text())
    assert (meta["first_seen_at"], meta["last_seen_at"]) == (EVENT.created_at, later.created_at)
    assert meta["timezone"] == "UTC"
    assert (
        json.loads(index.read_text())["traces"][EVENT.trace_id]["path"]
        == path.relative_to(index.parent).as_posix()
    )
    markdown = (index.parent / "index.md").read_text()
    assert "<query>" not in markdown
    assert path.relative_to(index.parent).as_posix() in markdown
