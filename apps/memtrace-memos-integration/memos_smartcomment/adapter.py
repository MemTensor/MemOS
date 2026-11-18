# One worker serializes events into per-user, per-trace graph snapshots.
from __future__ import annotations

import json
import queue
import threading
import time

from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Protocol

from memos_smartcomment.events import DeferredTraceEvent
from memos_smartcomment.lineage import connect_search_lineage
from memos_smartcomment.recorder import SmartCommentRecorder
from memos_smartcomment.storage import TraceStore


# isort: split
from memos.exceptions import MemOSError
from memos.log import get_logger


if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from memos_smartcomment.config import SmartCommentSettings
    from memos_smartcomment.events import TraceEvent


logger = get_logger(__name__)
_INDEX_FLUSH_SECONDS = 1.0
_RETRY_SECONDS = 1.0
_TraceKey = tuple[str | None, str]


class Recorder(Protocol):
    def record(self, event: TraceEvent) -> None: ...

    def export_graph(self) -> dict[str, Any]: ...

    def restore_graph(self, data: dict[str, Any]) -> None: ...


# Queue acceptance does not imply processing or durable storage.
@dataclass(slots=True)
class AdapterStats:
    accepted: int = 0
    dropped: int = 0
    processed: int = 0
    failed: int = 0
    rejected: int = 0
    # Retried persistence failures; unlike failed, these do not discard an event.
    write_failures: int = 0


@dataclass(slots=True)
class _CachedRecorder:
    recorder: Recorder
    last_used: float
    graph_items: int


class AsyncTraceAdapter:
    """Bounded event queue and graph cache, with one snapshot-writing worker."""

    def __init__(
        self,
        settings: SmartCommentSettings,
        *,
        recorder_factory: Callable[[TraceEvent], Recorder] | None = None,
    ) -> None:
        self.settings = settings
        self._store = TraceStore(settings)
        self._recorder_factory = recorder_factory or (
            lambda event: SmartCommentRecorder(settings, event)
        )
        self._queue: queue.Queue[TraceEvent | DeferredTraceEvent] = queue.Queue(
            maxsize=settings.queue_size
        )
        self._recorders: OrderedDict[_TraceKey, _CachedRecorder] = OrderedDict()
        self._pending: dict[_TraceKey, list[TraceEvent]] = {}
        self._cached_graph_items = 0
        self._thread: threading.Thread | None = None
        self._started = False
        self._closed = False
        # Protect lifecycle state and stats; only the worker accesses the graph cache.
        self._state_lock = threading.Lock()
        self._stats = AdapterStats()
        self._flush_requested = threading.Event()
        self._idle = threading.Event()
        self._idle.set()

    # Request-facing lifecycle: bounded, non-blocking submission and explicit drain/close.
    @property
    def stats(self) -> AdapterStats:
        with self._state_lock:
            return replace(self._stats)

    # The caller holds the state lock.
    def _start_worker(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name="memos-smartcomment-writer", daemon=True
        )
        self._thread.start()
        self._started = True

    def start(self) -> None:
        with self._state_lock:
            if self._closed:
                raise MemOSError("The smartcomment adapter is already closed")
            if not self._started:
                self._start_worker()

    def submit(self, event: TraceEvent | DeferredTraceEvent) -> bool:
        with self._state_lock:
            if self._closed:
                self._stats.rejected += 1
                return False
            try:
                # Do not let tracing backpressure block a business request.
                self._queue.put_nowait(event)
            except queue.Full:
                self._stats.dropped += 1
            else:
                self._stats.accepted += 1
                self._idle.clear()
                return True
        logger.warning("Dropping smartcomment event because the queue is full: %s", event.operation)
        return False

    # Idle includes graph, metadata, and index publication, not only queue consumption.
    def flush(self, timeout: float = 5.0) -> bool:
        with self._state_lock:
            if self._idle.is_set():
                return True
            self._flush_requested.set()
            if not self._started:
                self._start_worker()
        return self._idle.wait(timeout=max(0, timeout))

    # Drain accepted events; a timeout warns without interrupting an active write.
    def close(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        with self._state_lock:
            self._closed = True
            self._flush_requested.set()
            # Accepted events must drain even if start() was never called.
            if not self._started and not self._queue.empty():
                self._start_worker()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=max(0, deadline - time.monotonic()))
            if thread.is_alive():
                logger.warning("smartcomment writer did not stop within %.1f seconds", timeout)

    # Worker-owned persistence: restore durable snapshots and atomically replace them.
    def output_path(self, trace_id: str, user_id: str | None = None) -> Path:
        """Resolve an allocated trace; raises FileNotFoundError before its first write."""
        return self._store.output_path(trace_id, user_id)

    def _read_snapshot(self, event: TraceEvent) -> dict[str, Any] | None:
        try:
            path = self.output_path(event.trace_id, event.user_id)
        except FileNotFoundError:
            return None
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return None

    def _link_search_lineage(self, event: TraceEvent, recorder: Recorder) -> None:
        current = recorder.export_graph()

        def sources() -> Iterator[dict[str, Any]]:
            # The current trace may not have a path yet (e.g. rerank is its first event).
            for candidate in self._store.graph_paths(event.user_id):
                try:
                    snapshot = json.loads(candidate.read_text(encoding="utf-8"))
                    if (
                        isinstance(snapshot, dict)
                        and snapshot.get("graph_id") != event.trace_id
                        and isinstance(snapshot.get("data"), dict)
                    ):
                        yield snapshot
                except (OSError, ValueError):
                    logger.warning("Unable to read Add lineage snapshot: %s", candidate.name)

        try:
            merged, link_event = connect_search_lineage(current, event, sources())
            if link_event is not None:
                recorder.restore_graph(merged)
                recorder.record(link_event)
        except Exception:
            # Optional historical enrichment must not lose this Search's own graph.
            recorder.restore_graph(current)
            logger.exception("Failed to connect Add lineage for Search trace %s", event.trace_id)

    # Replace atomically so readers cannot observe a partial snapshot.
    def _export(self, events: list[TraceEvent], recorder: Recorder) -> int:
        exported = recorder.export_graph()
        self._store.write(events, exported)
        data = exported.get("data", {})
        return sum(len(data.get(key, ())) for key in ("nodes", "edges", "operations", "sessions"))

    # Never evict uncommitted events, including when a checkpoint is being retried.
    def _trim_cache(self) -> bool:
        now = time.monotonic()
        while self._recorders:
            key = next(iter(self._recorders))
            oldest = next(iter(self._recorders.values()))
            if (
                len(self._recorders) <= self.settings.max_cached_traces
                and self._cached_graph_items <= self.settings.max_cached_graph_items
                and now - oldest.last_used < self.settings.cache_ttl_seconds
            ):
                break
            if key in self._pending and not self._commit_trace(key):
                return False
            _, removed = self._recorders.popitem(last=False)
            self._cached_graph_items -= removed.graph_items
        return True

    def _get_recorder(self, event: TraceEvent) -> _CachedRecorder:
        key = (event.user_id, event.trace_id)
        cached = self._recorders.get(key)
        if cached is None:
            recorder = self._recorder_factory(event)
            snapshot = self._read_snapshot(event)
            if snapshot is not None:
                recorder.restore_graph(snapshot)
            # A failed record may have partly mutated the graph. Replay only earlier
            # successful observations, without losing their uncommitted changes.
            for pending in self._pending.get(key, ()):
                recorder.record(pending)
            data = snapshot.get("data", {}) if snapshot is not None else {}
            graph_items = sum(
                len(data.get(field, ())) for field in ("nodes", "edges", "operations", "sessions")
            )
            cached = _CachedRecorder(recorder, time.monotonic(), graph_items)
            self._recorders[key] = cached
            self._cached_graph_items += graph_items
        return cached

    def _process(self, event: TraceEvent) -> None:
        key = (event.user_id, event.trace_id)
        cached = self._get_recorder(event)
        try:
            cached.recorder.record(event)
            if self.settings.link_search_to_add and event.operation == "memos.search.rerank":
                self._link_search_lineage(event, cached.recorder)
        except Exception:
            self._recorders.pop(key)
            self._cached_graph_items -= cached.graph_items
            raise
        self._pending.setdefault(key, []).append(event)
        cached.last_used = time.monotonic()
        self._recorders.move_to_end(key)

    def _commit_trace(self, key: _TraceKey) -> bool:
        events = self._pending[key]
        try:
            cached = self._get_recorder(events[0])
            graph_items = self._export(events, cached.recorder)
        except Exception:
            with self._state_lock:
                self._stats.write_failures += 1
            logger.exception("Failed to checkpoint smartcomment trace %s; retaining for retry", key)
            return False
        self._cached_graph_items += graph_items - cached.graph_items
        cached.graph_items = graph_items
        del self._pending[key]
        with self._state_lock:
            self._stats.processed += len(events)
        for _event in events:
            self._queue.task_done()
        return True

    def _flush_graphs(self) -> None:
        # Stop consuming on I/O failure so the retry backlog cannot grow.
        while self._pending:
            for key in tuple(self._pending):
                self._commit_trace(key)
            if self._pending:
                time.sleep(_RETRY_SECONDS)

    def _flush_indexes(self) -> None:
        while failures := self._store.publish_indexes():
            with self._state_lock:
                self._stats.write_failures += failures
            time.sleep(_RETRY_SECONDS)

    def _mark_idle(self) -> bool:
        with self._state_lock:
            if self._queue.empty() and not self._pending and not self._store.pending_indexes:
                self._flush_requested.clear()
                self._idle.set()
                return self._closed
        return False

    def _run(self) -> None:
        next_index = time.monotonic() + _INDEX_FLUSH_SECONDS
        try:
            while True:
                timeout = max(0, min(0.05, next_index - time.monotonic()))
                try:
                    work = self._queue.get(timeout=timeout)
                except queue.Empty:
                    pass
                else:
                    try:
                        event = work.build() if isinstance(work, DeferredTraceEvent) else work
                        self._process(event)
                    except Exception:
                        with self._state_lock:
                            self._stats.failed += 1
                        self._queue.task_done()
                        logger.exception("Failed to record smartcomment event: %s", work.operation)
                    else:
                        # Break up CPU-heavy recording to prioritize API tail latency.
                        self._flush_graphs()

                now = time.monotonic()
                force = self._flush_requested.is_set() and self._queue.empty()
                if now >= next_index or force:
                    self._flush_indexes()
                    next_index = time.monotonic() + _INDEX_FLUSH_SECONDS
                if not self._trim_cache():
                    self._flush_graphs()
                    self._trim_cache()
                if self._mark_idle():
                    return
        finally:
            if not self._pending:
                self._recorders.clear()
                self._cached_graph_items = 0
