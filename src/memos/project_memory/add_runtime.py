"""Orchestrate durable Episodes with the MemOS scheduler."""

from __future__ import annotations

import json
import os
import threading
import time

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from itertools import pairwise
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.llms.usage import EMBEDDING, expect_usage, meter_usage
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL as MERGE_RESULT,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_TASK_LABEL as MERGE,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_PROCESS_TASK_LABEL as PROCESS,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_SPACE_TASK_LABEL as SPACE,
)
from memos.mem_scheduler.schemas.task_schemas import (
    SCHEDULER_DEFERRED_INFO_KEY,
    SCHEDULER_SKIP_ACK_INFO_KEY,
)

from .add_acceptance import AddAcceptance
from .add_algorithm import formation_due, organize_episode, organize_staged, recall_candidates
from .add_boundary import judge_boundary, unjudged
from .add_commit import (
    DraftWitnessError,
    EpisodeFenceError,
    commit_changeset,
    commit_formation,
)
from .add_dispatch import EpisodeDispatch, StageLease, label_for
from .add_extraction import extract_episode, jsonable
from .add_index import index_changeset, ranked_topics
from .add_merge import VersionConflictError, prepare_merge, rebase_append_only, rewrite_metadata
from .judge import ModelError
from .turns import evidence_vectors


if TYPE_CHECKING:
    from collections.abc import Callable

    from .add_store import PostgresAddStore
    from .judge import ModelHub

logger = get_logger(__name__)
_RELEASE_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0
"""
_RENEW_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
"""


@dataclass(frozen=True)
class RuntimeSettings:
    sync_wait_seconds: float = 30.0
    scan_seconds: int = 60
    recover_seconds: float = 1.0
    publish_stale_seconds: int = 60
    stage_lease_seconds: int = 600
    formation_count: int = 10
    formation_interval: int = 7200
    input_budget: int = 12_000
    lock_wait_seconds: int = 900
    previous_wait_seconds: int = 600

    @classmethod
    def from_env(cls) -> RuntimeSettings:
        return cls(
            **{
                name: type(default)(os.getenv(f"PROJECT_MEMORY_{name.upper()}", str(default)))
                for name, default in vars(cls()).items()
            }
        )

    def __post_init__(self) -> None:
        if min(vars(self).values()) <= 0:
            raise ValueError("Project memory runtime limits must be positive")


class EpisodeAddRuntime:
    def __init__(
        self,
        store: PostgresAddStore,
        hub: ModelHub,
        submit: Callable[[list[ScheduleMessageItem]], None],
        redis: Any,
        settings: RuntimeSettings | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
        embedder: Callable[[list[str]], list[list[float]]] | None = None,
        legacy_status: Callable[[str, str], dict | None] | None = None,
        embedding_model_id: str | None = None,
    ) -> None:
        self.store = store
        self.hub = hub
        self.submit = submit
        self.redis = redis
        self.settings = settings or RuntimeSettings.from_env()
        self.now = clock or (lambda: datetime.now(timezone.utc))
        self.embedder = self._metered(embedder, embedding_model_id) if embedder else None
        self.legacy_status = legacy_status
        self.embedding_model_id = embedding_model_id
        self.acceptance = AddAcceptance(store, clock=self.now)
        self.dispatch = EpisodeDispatch(store, lease_seconds=self.settings.stage_lease_seconds)
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None
        self._formation_thread: threading.Thread | None = None

    @staticmethod
    def _metered(
        embedder: Callable[[list[str]], list[list[float]]], model: str | None
    ) -> Callable[[list[str]], list[list[float]]]:
        """Count embedding calls of backends that do not report usage as usage-less."""

        def embed(texts: list[str]) -> list[list[float]]:
            with expect_usage(EMBEDDING, model):
                return embedder(texts)

        return embed

    def accept(self, request: Any) -> dict[str, Any]:
        accepted = self.acceptance.accept(request)
        for episode_id in accepted.closed_episode_ids:
            self._publish(episode_id)
        status = "running"
        error = None
        if getattr(request, "async_mode", "async") == "sync":
            deadline = time.monotonic() + self.settings.sync_wait_seconds
            while True:
                outcomes = [self.store.load_episode(eid) for eid in accepted.closed_episode_ids]
                if all(row is None or row["outcome"] != "pending" for row in outcomes):
                    error = next((row["error"] for row in outcomes if row and row["error"]), None)
                    status = (
                        "failed"
                        if any(row and row["outcome"] == "failed" for row in outcomes)
                        else "completed"
                    )
                    if accepted.duplicate:
                        existing = self.status(accepted.task_id, request.user_id) or {}
                        status = existing.get("status", "completed")
                        if status == "in_progress":
                            status = "running"
                        error = (existing.get("memory_views") or {}).get("project", {}).get("error")
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(0.1, remaining))

        result = {
            "success": status != "failed",
            "task_id": accepted.task_id,
            "status": status,
            "memory_view": "project",
            "_duplicate": accepted.duplicate,
        }
        if error:
            result["error"] = error
        return result

    def status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        current = self.acceptance.status(task_id, user_id)
        old = self.legacy_status(task_id, user_id) if self.legacy_status else None
        if current is None:
            return old
        if old:
            views = current["memory_views"]
            project = views["project"]
            historical = old["memory_views"]["project"]["memory_ids"]
            project["memory_ids"] = sorted(set(project["memory_ids"]).union(historical))
            views["updated"] = len(project["memory_ids"])
        return current

    def _publish(self, episode_id: str) -> None:
        try:
            episode = self.store.load_episode(episode_id)
            if episode is None:
                return
            label = label_for(episode)
            if label is None or not episode["owner_task_id"]:
                return
            now = self.now()
            if episode["next_retry_at"] is not None and episode["next_retry_at"] > now:
                return
            data = episode["organize_result"] or {}
            payload = {"episode_id": episode_id, "attempt": episode["attempt"]}
            if label in {MERGE, MERGE_RESULT}:
                payload["lock_token"] = data.get("lock_token")
            if label == MERGE:
                payload["plan"] = data["plan"]
            if label == MERGE_RESULT:
                payload["status"] = "prepared"
                payload["changeset"] = data["changeset"]
            self.submit(
                [
                    ScheduleMessageItem(
                        user_id=episode["user_id"],
                        mem_cube_id=episode["space_id"],
                        task_id=episode["owner_task_id"],
                        label=label,
                        content=json.dumps(jsonable(payload), ensure_ascii=False),
                    )
                ]
            )
            self.dispatch.published(episode, now, label=label)
        except Exception as exc:
            logger.warning(
                "Project Add will recover publication for %s (%s)", episode_id, type(exc).__name__
            )

    def recover(self) -> None:
        for episode in self.dispatch.due(
            self.now(), stale_seconds=self.settings.publish_stale_seconds
        ):
            self._publish(episode["id"])

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._run_timer, name="project-add-recovery", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        if self._formation_thread:
            self._formation_thread.join(timeout=5)
            self._formation_thread = None

    def _run_timer(self) -> None:
        # One scanner per schema: the due scan covers every project stored in it.
        scan_key = f"project_episode_scan_lock:{self.store.schema_name}"
        next_close = 0.0
        while not self._stopped.is_set():
            try:
                if time.monotonic() >= next_close:
                    token = uuid4().hex
                    if self.redis.set(
                        scan_key, token, nx=True, ex=min(50, self.settings.scan_seconds)
                    ):
                        try:
                            self.acceptance.close_due()
                        finally:
                            self.redis.eval(_RELEASE_LOCK, 1, scan_key, token)
                        self._start_formation_scan()
                    next_close = time.monotonic() + self.settings.scan_seconds
                self.recover()
            except Exception as exc:
                logger.warning("Project Add timer will retry (%s)", type(exc).__name__)
            self._stopped.wait(self.settings.recover_seconds)

    def _start_formation_scan(self) -> None:
        """Run quiet-Space Formation beside the timer so closing and recovery never wait on it."""
        if self._formation_thread is not None and self._formation_thread.is_alive():
            return
        self._formation_thread = threading.Thread(
            target=self._formation_scan, name="project-add-formation", daemon=True
        )
        self._formation_thread.start()

    def _formation_scan(self) -> None:
        try:
            self.form_due_spaces()
        except Exception as exc:
            logger.warning("Project Add Formation scan will retry (%s)", type(exc).__name__)

    def form_due_spaces(self) -> list[dict[str, Any]]:
        """Run Formation for quiet Spaces whose staged Episodes waited past the interval."""
        results = []
        for space_id in self.store.staged_space_ids():
            if self._stopped.is_set():
                break
            try:
                result = self.form_space(space_id)
            except Exception as exc:
                # Store or Redis trouble is usually transient: retry after a few scans.
                self._back_off(space_id, self.settings.scan_seconds * 5)
                logger.warning(
                    "Project Add Formation for a quiet Space backs off (%s)", type(exc).__name__
                )
                continue
            if result["ran"]:
                results.append(result)
        return results

    def _formation_key(self, kind: str, space_id: str) -> str:
        return f"project_formation_{kind}:{self.store.schema_name}:{space_id}"

    def _back_off(self, space_id: str, seconds: int | None = None) -> None:
        # A Formation that cannot commit would fail the same way on the next scan.
        self.redis.set(
            self._formation_key("backoff", space_id),
            "1",
            ex=int(seconds or self.settings.formation_interval),
        )

    def form_space(self, space_id: str, *, force: bool = False) -> dict[str, Any]:
        """Run one Formation over a Space's staged Episodes without a new Episode to carry it.

        Planning runs under a per-Space planning lock only, so Episode commits keep going; the
        Space lock is taken just around the commit, which rechecks every version it relies on.
        A forced run (flush) ignores back-off and the interval, and does not age staged Episodes.
        """
        outcome: dict[str, Any] = {"space_id": space_id, "ran": False}
        if not force and self.redis.exists(self._formation_key("backoff", space_id)):
            return {**outcome, "reason": "BACKING_OFF"}
        space = self.store.read_space(space_id)
        staged = self.store.read_staged(space_id) if space else []
        if not staged:
            return {**outcome, "reason": "NO_STAGED"}
        now = self.now()
        due = formation_due(
            space,
            staged,
            now,
            formation_count=self.settings.formation_count,
            formation_interval=self.settings.formation_interval,
        )
        if not force and not due:
            return {**outcome, "reason": "NOT_DUE"}
        planning = self._formation_key("planning", space_id)
        token = f"formation:{uuid4().hex}"
        if not self.redis.set(planning, token, nx=True, ex=self.settings.lock_wait_seconds):
            return {**outcome, "reason": "FORMATION_RUNNING"}
        try:
            return self._form_and_commit(space_id, space, staged, now, force, outcome)
        finally:
            self.redis.eval(_RELEASE_LOCK, 1, planning, token)

    def _form_and_commit(
        self,
        space_id: str,
        space: dict,
        staged: list[dict],
        now: datetime,
        force: bool,
        outcome: dict[str, Any],
    ) -> dict[str, Any]:
        domains = sorted({domain for ep in staged for domain in ep["domains"]})
        plan = organize_staged(
            self.hub,
            staged,
            space,
            self.store.read_topics(space_id, domains),
            now=now,
            count_attempt=not force,
        )
        if plan["formation"] is None:
            self._back_off(space_id)
            return {**outcome, "reason": "FORMATION_MODEL_UNAVAILABLE"}
        changeset = index_changeset(
            rewrite_metadata(self.hub, prepare_merge(self.hub, plan)),
            self.embedder,
            self.store.dim,
            model_id=self.embedding_model_id,
        )
        key = self._space_key({"space_id": space_id})
        token = f"formation:{uuid4().hex}"
        deadline = time.monotonic() + 30
        while not self.redis.set(key, token, nx=True, ex=30):
            if time.monotonic() >= deadline:
                self._back_off(space_id, self.settings.scan_seconds * 5)
                return {**outcome, "reason": "SPACE_LOCKED"}
            time.sleep(0.2)
        try:
            committed = commit_formation(self.store, changeset)
        except VersionConflictError:
            # An Episode ran Formation or changed a staged Episode first; plan again later.
            self._back_off(space_id, self.settings.scan_seconds * 5)
            return {**outcome, "reason": "FORMATION_CONFLICT"}
        except (EpisodeFenceError, DraftWitnessError):
            self._back_off(space_id)
            return {**outcome, "reason": "FORMATION_REJECTED"}
        finally:
            self.redis.eval(_RELEASE_LOCK, 1, key, token)
        return {
            **outcome,
            "ran": True,
            **committed,
            "staged": len(staged),
            "rejected": plan["formation"].get("rejected", []),
        }

    def flush(
        self, space_id: str, conversation_id: str | None = None, *, wait_seconds: float = 0.0
    ) -> dict[str, Any]:
        """Close open Episodes, wait for in-flight stages, then force Formation (dev and eval).

        Episodes still in flight after ``wait_seconds`` are reported and Formation waits for them;
        call again once they finish. Formation covers the whole Space's staged Episodes.
        """
        closed = self.acceptance.close_open(space_id, conversation_id)
        for episode_id in closed:
            self._publish(episode_id)
        deadline = time.monotonic() + wait_seconds
        while (pending := self.store.unfinished_episode_ids(space_id)) and (
            time.monotonic() < deadline
        ):
            time.sleep(0.1)
        if pending:
            formation = {"space_id": space_id, "ran": False, "reason": "EPISODES_IN_FLIGHT"}
        else:
            formation = self.form_space(space_id, force=True)
        return {
            "space_id": space_id,
            "closed_episode_ids": closed,
            "pending_episode_ids": pending,
            "formation": formation,
            "staged_remaining": self.store.staged_count(space_id),
        }

    def handle(self, batch: list[ScheduleMessageItem]) -> None:
        for message in batch:
            try:
                lease = self.dispatch.claim(message, self.now())
                if lease is not None:
                    self._work(lease, message.label)
            except Exception as exc:
                message.info = {
                    **(message.info or {}),
                    SCHEDULER_DEFERRED_INFO_KEY: True,
                    SCHEDULER_SKIP_ACK_INFO_KEY: True,
                }
                logger.warning(
                    "Project Add kept %s delivery pending (%s)", message.label, type(exc).__name__
                )

    def _work(self, lease: StageLease, label: str) -> None:
        started = time.perf_counter()
        with meter_usage() as meter:
            try:
                episode = self.store.load_episode(lease.episode_id)
                if episode is None:
                    lease.transition["error"] = "EpisodeNotFound"
                    return
                self._run_stage(lease, label, episode)
            finally:
                self._stage_done(lease, label, started, meter.summary())

    def _stage_done(
        self, lease: StageLease, label: str, started: float, usage: list[dict[str, Any]]
    ) -> None:
        """Persist the stage's run time and model usage, whatever the stage ended in."""
        run_ms = round((time.perf_counter() - started) * 1000)
        transition = lease.transition
        detail = {
            "label": label,
            "token": lease.token,
            "run_ms": run_ms,
            "next_stage": transition.get("stage"),
            "outcome": transition.get("outcome"),
            "reason": transition.get("reason"),
            "error": transition.get("error"),
            "applied": transition.get("applied"),
            "usage": usage,
        }
        logger.info(
            "Project Add stage episode=%s label=%s attempt=%s run_ms=%d next=%s outcome=%s "
            "calls=%d total_tokens=%d",
            lease.episode_id,
            label,
            lease.attempt,
            run_ms,
            detail["next_stage"],
            detail["outcome"],
            sum(row["calls"] for row in usage),
            sum(row["total_tokens"] for row in usage),
        )
        try:
            self.store.record_event(
                lease.episode_id,
                "stage_done",
                self.now(),
                stage=lease.stage,
                attempt=lease.attempt,
                detail=detail,
            )
        except Exception as exc:
            logger.warning(
                "Project Add could not record stage metrics for %s (%s)",
                lease.episode_id,
                type(exc).__name__,
            )

    def _run_stage(self, lease: StageLease, label: str, episode: dict) -> None:
        try:
            if label == PROCESS:
                self._extract(lease, episode)
            elif label == SPACE:
                self._organize(lease, episode)
            elif label == MERGE:
                self._merge(lease, episode)
            else:
                self._commit(lease, episode)
        except EpisodeFenceError:
            self._terminal(lease, episode, "SPACE_CLEARED", "The Episode's Space or lease changed")
        except DraftWitnessError:
            self._terminal(
                lease, episode, "INVALID_EVIDENCE", "A Draft has invalid source evidence"
            )
        except VersionConflictError:
            self._conflict(lease, episode)
        except Exception as exc:
            lease.transition["error"] = type(exc).__name__
            if label == MERGE_RESULT and self._committed(lease):
                lease.transition.update(stage="done", applied=True)
                self._release(episode, lease.data.get("lock_token"))
                return
            reason = "MODEL_UNAVAILABLE" if isinstance(exc, ModelError) else "STORE_UNAVAILABLE"
            logger.warning("Project Add stage %s will retry (%s)", lease.stage, type(exc).__name__)
            self._retry(lease, episode, reason, label)

    def _advance(self, lease: StageLease, **change: Any) -> None:
        if self.dispatch.advance(lease, self.now(), **change):
            self._publish(lease.episode_id)

    def _extract(self, lease: StageLease, episode: dict) -> None:
        previous = episode.get("previous")
        if previous and previous["state"] != "extracted" and previous["outcome"] == "pending":
            self._wait(lease, episode, "previous", self.settings.previous_wait_seconds, 5)
            return
        warnings = list(episode.get("warnings") or [])
        if episode.get("boundary") is None:
            boundary = self._judge_boundary(lease, episode, warnings)
            segments = _segments(episode["turns"], boundary["starts"])
            siblings = self.dispatch.settle_boundary(lease, self.now(), episode, boundary, segments)
            if siblings is None:
                return  # Another worker owns the stage now.
            for sibling in siblings:
                self._publish(sibling)
            if siblings:
                episode = self.store.load_episode(lease.episode_id)
                previous = episode.get("previous")
        result = extract_episode(
            self.hub,
            episode,
            episode["messages"],
            (previous or {}).get("messages"),
            input_budget=self.settings.input_budget,
        )
        persist = {
            "extraction": {
                "at": self.now().isoformat(),
                "status": result["extract_status"],
                "anchors": result["anchors"],
                "anchor_keys": result["anchor_keys"],
            },
            "warnings": warnings,
        }
        summary = {"episode_summary": result["episode_summary"] or None}
        try:
            summary["embedding"], turns = evidence_vectors(
                episode["messages"], summary["episode_summary"], self.embedder, self.store.dim
            )
        except ModelError:
            if lease.data.get("retries", 0) < 3:
                raise
            warnings.append("EVIDENCE_EMBEDDING_UNAVAILABLE")
            summary["embedding"], turns = evidence_vectors(
                episode["messages"], summary["episode_summary"], None, self.store.dim
            )
        if result["drafts"]:
            self._advance(
                lease,
                stage="organizing",
                drafts=result["drafts"],
                organize_result={"queued": True},
                persist=persist,
                episode=summary,
                turns=turns,
            )
        else:
            self._advance(
                lease,
                stage="done",
                outcome="skipped",
                drafts=result["drafts"],
                organize_result={},
                persist=persist,
                episode=summary,
                turns=turns,
            )

    def _judge_boundary(self, lease: StageLease, episode: dict, warnings: list[str]) -> dict:
        """Where the member's tasks start in this Episode and whether it continues the previous
        one. A model failure is retried by the stage; on the last try the Episode keeps one
        segment and is flagged BOUNDARY_MODEL_UNAVAILABLE instead of failing."""
        previous = episode.get("previous")
        prior = (
            {
                "episode_summary": previous.get("episode_summary"),
                "topic_name": previous.get("topic_name"),
            }
            if previous
            else None
        )
        try:
            judged = judge_boundary(self.hub, boundary_turns(episode), prior)
        except ModelError:
            if lease.data.get("retries", 0) < 3:
                raise
            judged = unjudged(prior)
            warnings.append("BOUNDARY_MODEL_UNAVAILABLE")
        return {
            "starts": list(judged.starts),
            "continues_previous": judged.continues_previous,
            "judged": judged.judged,
            "reasons": list(judged.reasons),
        }

    def _organize(self, lease: StageLease, episode: dict) -> None:
        data = lease.data
        if data.get("conflicts", 0) >= 3 and not data.get("lock_token"):
            token = self._new_lock_token(lease)
            if not self.redis.set(self._space_key(episode), token, nx=True, ex=120):
                self._wait(lease, episode, "lock", self.settings.lock_wait_seconds, 1)
                return
            data["lock_token"] = token
        if data.get("lock_token") and not self._renew(episode, data["lock_token"]):
            self._restart(lease, episode)
            return
        space_id = episode["space_id"]
        topics = self.store.read_topics(space_id, episode["domains"])
        space = self.store.read_space(space_id)
        if space is None:
            self._terminal(lease, episode, "SPACE_CLEARED", "The Space was removed")
            return
        boundary = episode.get("boundary") or {}
        if boundary and not boundary.get("continues_previous"):
            # The member moved to other work: the previous Topic is no must-consider candidate
            # and no previous-Episode basis for attaching.
            episode = {**episode, "previous": None}
        ranked, degraded = ranked_topics(self.store, episode, self.embedder)
        plan = organize_episode(
            self.hub,
            episode,
            recall_candidates(episode, topics, ranked, degraded=degraded),
            self.store.read_staged(space_id),
            space,
            now=self.now(),
            formation_count=self.settings.formation_count,
            formation_interval=self.settings.formation_interval,
            all_topics=topics,
            load_formation_topics=lambda domains: self.store.read_topics(space_id, domains),
        )
        if data.get("lock_token") and not self._renew(episode, data["lock_token"]):
            self._restart(lease, episode)
            return
        data = {**data, "plan": plan, "retries": 0}
        if plan["assignments"]:
            self._advance(lease, stage="awaiting_merge", organize_result=data)
        else:
            data["changeset"] = prepare_merge(self.hub, plan)
            self._advance(lease, stage="committing", organize_result=data)

    def _merge(self, lease: StageLease, episode: dict) -> None:
        token = lease.data.get("lock_token")
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        prepared = prepare_merge(self.hub, lease.data["plan"])
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        data = {**lease.data, "changeset": prepared, "retries": 0}
        self._advance(lease, stage="committing", organize_result=data)

    def _commit(self, lease: StageLease, episode: dict) -> None:
        data = lease.data
        token = data.get("lock_token")
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        changeset = index_changeset(
            rewrite_metadata(self.hub, data["changeset"]),
            self.embedder,
            self.store.dim,
            model_id=self.embedding_model_id,
        )
        if token:
            if not self._renew(episode, token):
                self._restart(lease, episode)
                return
        else:
            token = self._new_lock_token(lease)
            if not self.redis.set(self._space_key(episode), token, nx=True, ex=30):
                self._wait(lease, episode, "lock", self.settings.lock_wait_seconds, 1)
                return
        try:
            receipt = commit_changeset(
                self.store, lease.episode_id, lease.attempt, changeset, work_token=lease.token
            )
            lease.transition.update(
                stage="done", applied=True, outcome=(receipt or {}).get("outcome")
            )
        finally:
            self._release(episode, token)

    def _committed(self, lease: StageLease) -> bool:
        current = self.store.load_episode(lease.episode_id)
        return bool(current and current["commit_key"] == f"{lease.episode_id}:{lease.attempt}")

    def _conflict(self, lease: StageLease, episode: dict) -> None:
        changes = lease.data.get("changeset") or {}
        conflicts = lease.data.get("conflicts", 0) + 1
        if conflicts >= 6:
            self._terminal(lease, episode, "VERSION_CONFLICT", "Repeated concurrent Topic changes")
            return
        data = {"conflicts": conflicts}
        self._release(episode, lease.data.get("lock_token"))
        if conflicts < 3 and changes.get("kind") == "append":
            ids = [edit["topic"]["id"] for edit in changes["topics"]]
            topics = self.store.read_topics(episode["space_id"], topic_ids=ids)
            try:
                data["changeset"] = rebase_append_only(changes, topics)
            except VersionConflictError:
                pass
            else:
                self._advance(
                    lease, stage="committing", attempt=lease.attempt + 1, organize_result=data
                )
                return
        self._advance(lease, stage="organizing", organize_result={**data, "queued": True})

    def _restart(self, lease: StageLease, episode: dict) -> None:
        self._release(episode, lease.data.get("lock_token"))
        self._advance(
            lease,
            stage="organizing",
            organize_result={"conflicts": lease.data.get("conflicts", 0), "queued": True},
        )

    def _wait(
        self, lease: StageLease, episode: dict, kind: str, max_wait: int, base_delay: int
    ) -> None:
        data = dict(lease.data)
        now = self.now()
        began = datetime.fromisoformat(data.setdefault(f"{kind}_since", now.isoformat()))
        if (now - began).total_seconds() >= max_wait:
            self._terminal(lease, episode, "QUEUE_TIMEOUT", "Timed out waiting for " + kind)
            return
        tries = data.get(f"{kind}_retries", 0) + 1
        data[f"{kind}_retries"] = tries
        # The Episode waits in its stage; the retry time keeps it from being delivered sooner.
        self.dispatch.advance(
            lease,
            now,
            next_retry_time=now + timedelta(seconds=min(10, base_delay * 2 ** min(tries - 1, 4))),
            organize_result=data,
        )

    def _retry(self, lease: StageLease, episode: dict, reason: str, label: str) -> None:
        retries = lease.data.get("retries", 0) + 1
        if retries > 3:
            self._terminal(lease, episode, reason, "Stage retry budget exhausted", exhausted=True)
            return
        data = {**lease.data, "retries": retries}
        token = data.pop("lock_token", None)
        self._release(episode, token)
        stage = {}
        if token and label != PROCESS:
            # The Space lock is gone: organize again in a new round.
            data = {"retries": retries, "conflicts": data.get("conflicts", 0), "queued": True}
            stage = {"stage": "organizing"}
        now = self.now()
        self.dispatch.advance(
            lease,
            now,
            next_retry_time=now + timedelta(seconds=2**retries),
            organize_result=data,
            persist={
                "last_error": episode.get("last_error")
                or self._error(lease, reason, "Stage will retry")
            },
            **stage,
        )

    def _terminal(
        self,
        lease: StageLease,
        episode: dict,
        reason: str,
        message: str,
        *,
        exhausted: bool = False,
    ) -> None:
        self._release(episode, lease.data.get("lock_token"))
        error = self._error(lease, reason, message)
        if exhausted:
            error = dict(episode.get("last_error") or error)
            error["retry_exhausted"] = True
        self._advance(lease, outcome="failed", error=error, organize_result={})

    @staticmethod
    def _error(lease: StageLease, reason: str, message: str) -> dict[str, Any]:
        code = {
            "SPACE_CLEARED": 40902,
            "INVALID_EVIDENCE": 42201,
            "VERSION_CONFLICT": 40901,
            "QUEUE_TIMEOUT": 50401,
            "STORE_UNAVAILABLE": 50301,
            "MODEL_UNAVAILABLE": 50302,
        }[reason]
        return {
            "code": code,
            "reason": reason,
            "message": message,
            "origin": {"stage": lease.stage, "episode_id": lease.episode_id},
        }

    def _space_key(self, episode: dict) -> str:
        # Space IDs are unique across projects; Space-level Formation has no Episode row to read.
        return f"project_space_lock:{self.store.schema_name}:{episode['space_id']}"

    @staticmethod
    def _new_lock_token(lease: StageLease) -> str:
        return f"{lease.episode_id}:{lease.attempt}:{lease.token}"

    def _renew(self, episode: dict, token: str) -> bool:
        return bool(self.redis.eval(_RENEW_LOCK, 1, self._space_key(episode), token, 600))

    def _release(self, episode: dict, token: str | None) -> None:
        if token:
            try:
                self.redis.eval(_RELEASE_LOCK, 1, self._space_key(episode), token)
            except Exception as exc:
                logger.warning(
                    "Project Add will let the Space lock expire (%s)", type(exc).__name__
                )


def boundary_turns(episode: dict) -> list[dict]:
    """Turns for the boundary judgment: the member's words and the Agent's replies."""
    turns: dict[str, dict] = {}
    for message in episode["messages"]:
        turn = turns.setdefault(message["turn_id"], {"member": [], "agent": []})
        if message["role"] == "user":
            turn["member"].append(message["content"] or "")
        elif message["role"] == "assistant" and message["content"]:
            turn["agent"].append(message["content"])
    return [
        {"member": "\n".join(turn["member"]), "agent": "\n".join(turn["agent"])}
        for turn in turns.values()
    ]


def _segments(turns: list[dict], starts: list[int]) -> list[tuple[int, int]]:
    """msg_seq ranges of the segments that begin at the given Turn indexes."""
    bounds = [*starts, len(turns)]
    return [
        (turns[begin]["seq_start"], turns[end - 1]["seq_end"])
        for begin, end in pairwise(bounds)
        if begin < end
    ]
