"""Fan out once per requested view, combine ranks, then apply one result budget."""

import asyncio

from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextvars import copy_context
from functools import partial
from threading import BoundedSemaphore

from memos.log import get_logger
from memos.project_memory.index import Vector, terms
from memos.project_memory.messages import MessageStore
from memos.project_memory.store import Hit, RetrievalStore, Scope
from memos.project_memory.views import ITEM_TYPES


logger = get_logger(__name__)
PROJECT_GROUPS = {"project": "topic_detail_list", "trajectory": "trajectory_detail_list"}
PERSONAL_GROUPS = {
    "detail_factual": ("text_mem", "memory_detail_list"),
    "preference": ("pref_mem", "preference_detail_list"),
    "tool_memory": ("tool_mem", "tool_memory_detail_list"),
    "skill": ("skill_mem", "skill_detail_list"),
    "profile": ("profile_mem", "profile_detail_list"),
    "event": ("event_mem", "event_detail_list"),
}


def mix(lanes: list[list[Hit]], limit: int) -> tuple[list[Hit], bool]:
    hits, scores = {}, {}
    for lane in lanes:
        seen = set()
        for rank, hit in enumerate(lane, 1):
            if hit.key not in seen:
                scores[hit.key] = scores.get(hit.key, 0.0) + 1 / (60 + rank)
                hits.setdefault(hit.key, hit)
                seen.add(hit.key)
    if not hits:
        return [], False
    peak = max(scores.values())
    features = {}
    for key, hit in hits.items():
        text = " ".join(
            str(hit.data.get(k, ""))
            for k in ("topic_name", "topic_summary", "content", "memory", "preference")
        )
        features[key] = set(terms(text))
    similarity = dict.fromkeys(hits, 0.0)
    remaining = set(hits)
    selected = []
    while remaining and len(selected) < limit:

        def priority(key: tuple) -> tuple:
            return (
                -(0.8 * scores[key] / peak - 0.2 * similarity[key]),
                not hits[key].current_session,
                key,
            )

        best = min(remaining, key=priority)
        remaining.remove(best)
        relevance = scores[best] / peak - 0.25 * similarity[best]
        hits[best].data.setdefault("relativity", round(max(0.0, relevance), 6))
        selected.append(hits[best])
        for key in remaining:
            union = features[key] | features[best]
            if union:
                overlap = len(features[key] & features[best]) / len(union)
                similarity[key] = max(similarity[key], overlap)
    return selected, bool(remaining)


class ProjectRetrieval:
    def __init__(
        self,
        store: RetrievalStore,
        embed: Callable[[str], Vector] | None = None,
        message_store: MessageStore | None = None,
    ):
        self.message_store = message_store
        self.store = store
        self.embed = embed
        self.providers = ThreadPoolExecutor(max_workers=8, thread_name_prefix="memos-project")
        self.provider_slots = BoundedSemaphore(8)

    def close(self) -> None:
        self.providers.shutdown(wait=False, cancel_futures=True)

    async def _provider_call(self, call: Callable, *args):
        # A timed-out synchronous provider may keep running. Reserve its slot until
        # it actually finishes; leave the event loop's workers free for SQL reads.
        if not self.provider_slots.acquire(blocking=False):
            raise TimeoutError("Project recall provider workers are busy")
        try:
            future = self.providers.submit(copy_context().run, call, *args)
        except BaseException:
            self.provider_slots.release()
            raise
        future.add_done_callback(lambda _: self.provider_slots.release())
        return await asyncio.wrap_future(future)

    async def search(
        self,
        scope: Scope,
        query: str,
        session: str | None,
        views: list[str],
        limit: int,
        personal: Callable | None = None,
        *,
        item_types: tuple[str, ...] = ITEM_TYPES,
        result_format: str = "topic",
        threshold: float = 0.45,
    ) -> dict:
        deadline = asyncio.get_running_loop().time() + 0.46
        # Scope errors fail the entire request, including mixed searches.
        scope = await asyncio.wait_for(asyncio.to_thread(self.store.validate, scope), 0.25)
        degraded = set()
        lanes = {}
        project_ready = Future()
        accepted_project = None

        async def embedding() -> Vector | None:
            if self.embed:
                try:
                    result = await asyncio.wait_for(self._provider_call(self.embed, query), 0.10)
                    result.sql_value()
                    return result
                except Exception as exc:
                    logger.warning("Project query embedding unavailable (%s)", type(exc).__name__)
            return None

        async def recall(channel: str) -> None:
            vector = await shared_vector
            hits, partial_vectors = await asyncio.to_thread(
                self.store.recall,
                scope,
                channel,
                query,
                vector,
                session,
                limit,
                item_types,
                result_format,
                threshold,
            )
            lanes[channel] = hits
            if channel == "project":
                project_ready.set_result(hits)
            if partial_vectors:
                degraded.add(channel + ".vector")

        async def recall_personal() -> None:
            if personal is None:
                raise LookupError("Personal search is unavailable")
            nonlocal accepted_project
            hits, missing, accepted_project = await self._provider_call(
                personal, project_ready if "project" in views else None
            )
            lanes["personal"] = hits
            degraded.update(missing)

        async def run(channel: str, call: Callable) -> None:
            try:
                await asyncio.wait_for(
                    call(), min(0.30, deadline - asyncio.get_running_loop().time())
                )
            except Exception as exc:
                if channel == "project" and not project_ready.done():
                    project_ready.set_result([])
                degraded.add(channel)
                logger.warning(
                    "Project search channel %s unavailable (%s)", channel, type(exc).__name__
                )

        shared_vector = asyncio.create_task(embedding())
        calls = [run(v, partial(recall, v)) for v in PROJECT_GROUPS if v in views]
        if any(v in PERSONAL_GROUPS for v in views):
            calls.append(run("personal", recall_personal))
        await asyncio.gather(*calls)
        if accepted_project is not None and "project" in lanes:
            lanes["project"] = [hit for hit in lanes["project"] if hit.key in accepted_project]
        selected, truncated = mix([lanes[k] for k in sorted(lanes)], limit)
        data = {
            (PROJECT_GROUPS[v] if v in PROJECT_GROUPS else PERSONAL_GROUPS[v][1]): [] for v in views
        }
        if result_format == "item" and "project" in views:
            data["project_item_list"] = data.pop("topic_detail_list")
        for hit in selected:
            data[hit.group].append(hit.data)
        for group in ("topic_detail_list", "project_item_list"):
            if group in data:
                data[group].sort(key=lambda item: -item["relativity"])
        recalled = data.get("topic_detail_list", [])
        if session and data.get("project_item_list"):
            topics = {}
            for hit in selected:
                if hit.group != "project_item_list":
                    continue
                row = hit.data
                topic = topics.setdefault(
                    (row["space_id"], row["topic_id"]),
                    {"space_id": row["space_id"], "id": row["topic_id"], "decisions": []},
                )
                if hit.kind == "decision":
                    topic["decisions"].append(row)
            recalled = list(topics.values())
        if session and recalled:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self.store.log_recall, scope, session, recalled),
                    min(0.05, deadline - asyncio.get_running_loop().time()),
                )
            except Exception as exc:
                logger.warning("Project recall log unavailable (%s)", type(exc).__name__)
                degraded.add("recall_log")
        return {
            **data,
            "channels": sorted(lanes),
            "degraded": sorted(degraded),
            "truncated": truncated,
        }
