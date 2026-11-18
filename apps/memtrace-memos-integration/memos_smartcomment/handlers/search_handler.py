"""Capture retained Search result lists at each observed stage."""

from __future__ import annotations

import json

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from functools import partial
from hashlib import sha256
from threading import Lock
from typing import TYPE_CHECKING, Any
from urllib.parse import quote
from uuid import uuid4

from memos_smartcomment.events import DeferredTraceEvent, TraceEvent, TraceLink, TraceValue
from memos_smartcomment.handlers.base import (
    BaseHandler,
    _cube_ids,
    _current_trace_id,
    _get,
    _memory_text,
)


# isort: split
from memos.log import get_logger


if TYPE_CHECKING:
    from memos.plugins.hook_context import HookContext


logger = get_logger(__name__)

_SEARCH_LINK_CATEGORIES = {
    "threshold": "memory_threshold_passed",
    "dedup": "memory_deduplicated",
    "rerank": "memory_reranked",
}

_SEARCH_STAGE_LABELS = {
    "raw": "initial retrieval",
    "threshold": "relevance filtering",
    "dedup": "deduplication",
    "rerank": "reranking",
}

_BucketKey = tuple[str, str | None, int]
_MemoryKey = tuple[str, str | bytes]


@dataclass(frozen=True)
class _SearchBucket:
    """One detached list, identified independently of its memory contents."""

    result_type: str
    cube_id: str | None
    bucket_index: int
    occurrence: int
    memories: list[dict[str, Any]]
    identities: tuple[_MemoryKey, ...]

    @property
    def key(self) -> _BucketKey:
        # Cube IDs survive bucket reordering; missing IDs fall back to position.
        return (
            self.result_type,
            self.cube_id,
            self.occurrence if self.cube_id is not None else self.bucket_index,
        )


@dataclass(frozen=True)
class _SearchList:
    bucket: _SearchBucket
    node: TraceValue


@dataclass(frozen=True)
class _SearchState:
    # Retain the request so its object ID cannot be reused while stages are pending.
    request: Any
    namespace: str
    lists: dict[_BucketKey, _SearchList]


class SearchHandler(BaseHandler):
    """Capture one result-list node per type/cube bucket at each enabled Search stage."""

    def __init__(
        self,
        submit: Callable[[TraceEvent], Any],
        *,
        max_value_chars: int = 20_000,
        defer_search: Callable[[DeferredTraceEvent], Any] | None = None,
    ) -> None:
        super().__init__(submit, max_value_chars=max_value_chars)
        self._defer_search = defer_search
        self._search_stages: dict[tuple[str | None, str, int], _SearchState] = {}
        self._search_stages_lock = Lock()

    def clear(self) -> None:
        """Release cached search-stage nodes at shutdown."""
        with self._search_stages_lock:
            self._search_stages.clear()

    # Query intake and search identity
    # A search starts with a query and the readable cubes from its request.
    # Hook context and request fields place that query in a user trace.
    # Every result stage refers to the same query identity.
    def on_search_before(
        self,
        *,
        request: Any,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        if request is None:
            return
        subject = self._search_subject(hook_context, request)
        query = self._search_query_value(subject, request, identity_only=False)
        self._emit(
            self._event(
                subject,
                operation="memos.search.request",
                category="search_request",
                comment="Capture the query submitted to the MemOS Search API.",
                outputs=(query,),
                metadata={"memos_stage": "search.before"},
            )
        )

    def _search_subject(
        self,
        hook_context: HookContext | None,
        request: Any,
    ) -> dict[str, Any]:
        subject = self._hook_subject(hook_context)
        for key in ("trace_id", "user_id", "session_id", "task_id"):
            if subject.get(key) is None and (value := _get(request, key)) is not None:
                subject[key] = value
        if cube_ids := _cube_ids(request):
            subject["mem_cube_ids"] = cube_ids
        return subject

    def _search_query_value(
        self,
        subject: Any,
        request: Any,
        *,
        identity_only: bool,
    ) -> TraceValue:
        trace_id = _current_trace_id(subject)
        query = self._value(
            value=_get(request, "query", ""),
            identity=f"search_query:{trace_id}",
            category="search_query",
            class_name="str",
            identity_only=identity_only,
            comment="The raw query the user uploaded for memory retrieval.",
            metadata={"memos_stage": "search.before"},
        )
        # Before receives the original request; result Hooks receive its working copy.
        # Match the captured query across that copy without borrowing another query's value.
        digest = sha256(json.dumps(query.value, ensure_ascii=False).encode()).hexdigest()
        return replace(query, identity=f"{query.identity}:{digest}")

    # Retrieved candidates
    # Retrieval returns candidates grouped by memory type and storage cube.
    # Each bucket becomes one list node, preserving the observed memory order.
    # Stage links connect the retained lists at successive observed stages.
    def on_search_memory_results(
        self,
        *,
        search_req: Any,
        results: Any,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        self._on_search_results(
            request=search_req,
            results=results,
            hook_context=hook_context,
            operation="memos.search.retrieve",
            category="memory_retrieval",
            comment="Observe the memory candidates returned for this query before post-processing.",
            stage="raw",
            metadata={
                "memos_stage": "search.memory_results",
                "top_k": _get(search_req, "top_k"),
            },
        )

    def on_search_results_after_threshold(
        self,
        *,
        search_req: Any,
        results: Any,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        threshold = _get(search_req, "relativity", 0) or 0
        # MemOS emits this Hook even when the threshold function returns early.
        if threshold <= 0:
            return
        self._on_search_results(
            request=search_req,
            results=results,
            hook_context=hook_context,
            operation="memos.search.threshold_filter",
            category="memory_filtering",
            comment="Observe candidates after the threshold stage.",
            stage="threshold",
            metadata={
                "memos_stage": "search.results.after_threshold",
                "threshold": threshold,
                "score_field": "metadata.relativity",
                "applied": True,
            },
        )

    def on_search_results_after_dedup(
        self,
        *,
        search_req: Any,
        results: Any,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        method = _get(search_req, "dedup", "no") or "no"
        # Only these methods execute the API's explicit deduplication stage.
        if method not in {"sim", "mmr"}:
            return
        self._on_search_results(
            request=search_req,
            results=results,
            hook_context=hook_context,
            operation="memos.search.deduplicate",
            category="memory_deduplication",
            comment="Observe candidates after the deduplication stage.",
            stage="dedup",
            metadata={
                "memos_stage": "search.results.after_dedup",
                "method": str(method),
                "applied": True,
                "top_k": _get(search_req, "top_k"),
            },
        )

    def on_search_results_after_rerank(
        self,
        *,
        search_req: Any,
        results: Any,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        # request.rerank controls retrieval before raw, not this API post-processing.
        self._on_search_results(
            request=search_req,
            results=results,
            hook_context=hook_context,
            operation="memos.search.rerank",
            category="memory_reranking",
            comment="Observe candidate order and content after rerank stage.",
            stage="rerank",
            metadata={
                "memos_stage": "search.results.after_rerank",
                "algorithm": "relativity_sort",
                "order_by": "metadata.relativity",
                "direction": "descending",
                "top_k": _get(search_req, "top_k"),
            },
        )

    def _on_search_results(
        self,
        *,
        request: Any,
        results: Any,
        hook_context: HookContext | None,
        operation: str,
        category: str,
        comment: str,
        stage: str,
        metadata: dict[str, Any],
    ) -> None:
        if request is None:
            return
        subject = self._search_subject(hook_context, request)
        request_key = self._search_cache_key(subject, request)
        with self._search_stages_lock:
            # Take ownership before capture so failures cannot strand this request's state.
            state = self._search_stages.pop(request_key, None)
        if state is None or stage == "raw":
            state = _SearchState(request, f"{_current_trace_id(subject)}:{uuid4().hex}", {})
        buckets = self._search_result_buckets(results)

        retained_comment = {
            "raw": (
                "Raw memory candidates returned by retrieval, before API-level "
                "relevance filtering, deduplication, and reranking."
            ),
            "threshold": (
                "Memory candidates retained after relevance-threshold filtering. "
                "This stage filters text_mem and pref_mem type memories. "
                "Other memory types pass through unchanged."
            ),
            "dedup": (
                f"Memory candidates retained after the {metadata.get('method')} deduplication stage."
                if metadata.get("method")
                else "Memory candidates retained after the deduplication stage."
            ),
            "rerank": (
                "Memory candidates retained after the reranking stage. This stage only processes memories of the text_mem type."
            ),
        }.get(
            stage,
            f"Memory candidates retained after the {stage} stage.",
        )
        # Skipped or missing stages leave the last observed lists as predecessors.
        previous = state.lists

        # A disappearing bucket still has an empty result at the next stage.
        for key, prior in previous.items():
            buckets.setdefault(key, replace(prior.bucket, memories=[], identities=()))

        current = {
            key: _SearchList(
                bucket,
                self._search_memory_list_value(
                    state.namespace, stage=stage, bucket=bucket, retained_comment=retained_comment
                ),
            )
            for key, bucket in buckets.items()
            if bucket.memories or key in previous
        }
        query = (
            self._search_query_value(subject, request, identity_only=True)
            if stage == "raw"
            else None
        )
        event = self._event(
            subject,
            operation=operation,
            category=category,
            comment=comment,
            metadata=metadata,
        )
        work = DeferredTraceEvent(
            operation=operation,
            build=partial(
                self._build_search_event,
                event,
                namespace=state.namespace,
                stage=stage,
                query=query,
                previous=previous,
                current=current,
            ),
        )
        if self._defer_search is None:
            self._emit(work.build())
        else:
            try:
                self._defer_search(work)
            except Exception:
                logger.exception("Failed to enqueue smartcomment event: %s", operation)
                return

        # Only completed captures become predecessors; writer progress is independent.
        with self._search_stages_lock:
            if stage != "rerank":
                self._search_stages[request_key] = _SearchState(request, state.namespace, current)

    def _build_search_event(
        self,
        event: TraceEvent,
        *,
        namespace: str,
        stage: str,
        query: TraceValue | None,
        previous: dict[_BucketKey, _SearchList],
        current: dict[_BucketKey, _SearchList],
    ) -> TraceEvent:
        """Assemble links and count removals without touching live request state."""
        stage_label = _SEARCH_STAGE_LABELS.get(stage, stage)
        outputs = tuple(result.node for result in current.values())
        filtered_count = 0
        if stage == "raw":
            assert query is not None
            inputs = (query,)
            branches, links = self._search_retrieval_branches(
                namespace, query=query, results=tuple(current.values())
            )
            outputs = branches + outputs
        else:
            stage_links: list[TraceLink] = []
            for key, result in current.items():
                if key not in previous:
                    continue
                prior = previous[key]
                source = replace(prior.node, identity_only=True)
                stage_links.append(
                    TraceLink(
                        source=source,
                        target=result.node,
                        category=_SEARCH_LINK_CATEGORIES[stage],
                        comment=f"Filter memory candidates through the {stage_label} stage.",
                    )
                )
                filtered_count += self._removed_memory_count(
                    prior.bucket.identities, result.bucket.identities
                )
            links = tuple(stage_links)
            inputs = self._unique_values([link.source for link in links])

        return replace(
            event,
            inputs=inputs,
            outputs=outputs,
            links=links,
            metadata={
                **event.metadata,
                "link_strategy": "bucket_lists",
                "filtered_count": filtered_count,
            },
        )

    def _search_retrieval_branches(
        self,
        namespace: str,
        *,
        query: TraceValue,
        results: tuple[_SearchList, ...],
    ) -> tuple[tuple[TraceValue, ...], tuple[TraceLink, ...]]:
        """Expand raw retrieval into query -> result type -> cube -> memory list."""
        types: dict[str, TraceValue] = {}
        branches: list[TraceValue] = []
        links: list[TraceLink] = []
        for result in results:
            bucket = result.bucket
            result_type = bucket.result_type
            if result_type not in types:
                type_node = self._value(
                    value=result_type,
                    identity=f"search_memory_type:{namespace}:{result_type}",
                    category="search_memory_type",
                    class_name="search_memory_type",
                    identity_only=False,
                    comment=f"Branch of the {result_type} memory type. In this branch, all retrieved memories belong to the {result_type} memory type.",
                    metadata={"stage": "raw", "result_type": result_type},
                )
                types[result_type] = type_node
                branches.append(type_node)
                links.append(
                    TraceLink(
                        source=query,
                        target=type_node,
                        category="memory_type_branch",
                        comment="Group raw search candidates by memory type.",
                    )
                )

            cube_id = bucket.cube_id
            cube_label = cube_id if cube_id is not None else f"bucket-{bucket.bucket_index}"
            cube_node = self._value(
                value=cube_label,
                identity=f"search_cube:{namespace}:{result_type}:{bucket.bucket_index}",
                category="search_cube",
                class_name="search_cube",
                identity_only=False,
                comment=(
                    f"Branch for the {result_type} memory type and the {cube_label} memory cube. In this branch, all retrieved memories are of the {result_type} memory type and belong to the {cube_label} memory cube."
                ),
                metadata={
                    "stage": "raw",
                    "result_type": result_type,
                    "cube_id": cube_id,
                    "bucket_index": bucket.bucket_index,
                },
            )
            branches.append(cube_node)
            links.extend(
                (
                    TraceLink(
                        source=types[result_type],
                        target=cube_node,
                        category="memory_cube_branch",
                        comment=f"Group {result_type} memory-type raw search candidates by memory cube.",
                    ),
                    TraceLink(
                        source=cube_node,
                        target=result.node,
                        category="memory_retrieval",
                        comment="Return the list of memories retrieved under this branch.",
                    ),
                )
            )
        return tuple(branches), tuple(links)

    def _search_result_buckets(self, results: Any) -> dict[_BucketKey, _SearchBucket]:
        if not isinstance(results, Mapping):
            return {}

        buckets: dict[_BucketKey, _SearchBucket] = {}
        for result_type, raw_buckets in results.items():
            if not isinstance(raw_buckets, list | tuple):
                continue
            occurrences: Counter[str | None] = Counter()
            for bucket_index, raw_bucket in enumerate(raw_buckets):
                cube_id = _get(raw_bucket, "cube_id")
                cube_id = str(cube_id) if cube_id is not None else None
                occurrence = occurrences[cube_id]
                occurrences[cube_id] += 1
                memories = _get(raw_bucket, "memories")
                if not isinstance(memories, list | tuple):
                    continue
                items = []
                identities = []
                for memory in memories:
                    metadata = _get(memory, "metadata", {})
                    # Zero is a valid score; only None falls through to the next field.
                    score = _get(metadata, "relativity")
                    if score is None:
                        score = _get(metadata, "score")
                    if score is None:
                        score = _get(memory, "score")
                    memory_id = _get(memory, "id") or _get(memory, "memory_id")
                    text = _memory_text(memory)
                    identities.append(self._memory_identity(memory_id, text))
                    items.append(
                        {
                            # Known fields need no recursive dictionary walk. Scalars are
                            # cheap; unusual structured values still use normal redaction.
                            "memory_id": self._snapshot(memory_id),
                            "memory": self._snapshot(text),
                            "score": self._snapshot(score),
                        }
                    )
                bucket = _SearchBucket(
                    result_type=str(result_type),
                    cube_id=cube_id,
                    bucket_index=bucket_index,
                    occurrence=occurrence,
                    memories=items,
                    identities=tuple(identities),
                )
                buckets[bucket.key] = bucket
        return buckets

    def _memory_identity(self, memory_id: Any, text: Any) -> _MemoryKey:
        """Capture matching keys before truncation without retaining unbounded text."""
        if memory_id is not None:
            kind, value = "id", str(memory_id)
        elif isinstance(text, str):
            kind, value = "text", text
        else:
            kind = "json"
            try:
                value = json.dumps(text, ensure_ascii=False, sort_keys=True, default=str)
            except (TypeError, ValueError, RecursionError):
                # Cycles and mixed mapping keys must not prevent safe result capture.
                value = json.dumps(self._snapshot(text), ensure_ascii=False, sort_keys=True)
            # Preserve JSON's default=str equality with an actual string observation.
            if value.startswith('"'):
                kind, value = "text", json.loads(value)
        # Structured values may contain secrets; retain only a digest of their identity.
        if (
            kind == "json"
            or len(value) > self._max_value_chars
            or (memory_id is not None and not isinstance(memory_id, str | int | float | bool))
        ):
            return kind, sha256(value.encode("utf-8", errors="surrogatepass")).digest()
        return kind, value

    def _search_memory_list_value(
        self,
        namespace: str,
        *,
        stage: str,
        bucket: _SearchBucket,
        retained_comment: str = "",
    ) -> TraceValue:
        # DOT renderers interpolate IDs inside quotes; encode the structured key
        # so its quotes and backslashes cannot split one node into multiple IDs.
        bucket_key = quote(
            json.dumps(bucket.key, ensure_ascii=False, separators=(",", ":")), safe=""
        )
        metadata = {
            "stage": stage,
            "result_type": bucket.result_type,
            "cube_id": bucket.cube_id,
            "bucket_index": bucket.bucket_index,
            "memory_count": len(bucket.memories),
        }

        return TraceValue(
            # Captured entries are already detached, redacted and bounded.
            value=bucket.memories,
            identity=f"search_memory_list:{namespace}:{stage}:{bucket_key}",
            category=f"search_memory_list_{stage}",
            class_name="search_memory_list",
            comment=retained_comment,
            metadata=self._snapshot(metadata),
        )

    @staticmethod
    def _removed_memory_count(
        previous: tuple[_MemoryKey, ...], current: tuple[_MemoryKey, ...]
    ) -> int:
        """Count removed occurrences without creating a discarded-memory list."""

        # Scores and expanded text can change while the same memory is retained.
        before = Counter(previous)
        after = Counter(current)
        return sum((before - after).values())

    # Search completion
    # Reranking completes the search result flow. A post-processing exception
    # links the query to a failure status. Both outcomes release the cached
    # result lists for that request.
    def on_search_post_process_failed(
        self,
        *,
        handler: Any,
        search_req: Any,
        error: BaseException,
        hook_context: HookContext | None = None,
        **_kwargs: Any,
    ) -> None:
        stage = "search.post_process.failed"
        subject = self._search_subject(hook_context, search_req)
        self._clear_search_stages(subject, search_req)
        query = self._search_query_value(subject, search_req, identity_only=True)
        status = self._operation_status_value(subject, error, stage=stage)
        self._emit(
            self._event(
                subject,
                operation=f"memos.{stage}",
                category="search_failure",
                comment="Observe an exception during Search API post-processing for this query.",
                inputs=(query,),
                outputs=(status,),
                links=(
                    TraceLink(
                        source=query,
                        target=status,
                        category="operation_failed",
                        comment="Post-processing this query raised an observed exception.",
                    ),
                ),
                metadata={
                    "memos_stage": stage,
                    "status": "failed",
                    "error_type": error.__class__.__name__,
                    "handler": handler.__class__.__name__,
                },
            )
        )

    @staticmethod
    def _search_cache_key(subject: Any, request: Any) -> tuple[str | None, str, int]:
        return _get(subject, "user_id"), _current_trace_id(subject), id(request)

    def _clear_search_stages(self, subject: Any, request: Any) -> None:
        with self._search_stages_lock:
            self._search_stages.pop(self._search_cache_key(subject, request), None)
